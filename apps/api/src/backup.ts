/**
 * Backup export / import (SPEC FR-16). Import merges challenges into the caller's account;
 * the profile is left as it is (the client can PATCH /api/me from backup.user if it wants).
 *
 * A backup file is user input, so an import follows the same rules as using the app (security):
 * the start date is one a create could have led to, stamps stop at "today + 1", "done" needs day 7,
 * at most LIMITS.openChallenges open and LIMITS.challengesPerUser challenges in total (excess items
 * are skipped), and the route allows QUOTAS.importsPerUserPerDay imports. Imported challenges are
 * private (`imported`: no cohort projection, not in the PILOT metrics) until the owner stamps or
 * edits them. Moderation of a challenge id outlives its item (MOD#<chId>, db/moderation.ts): a
 * challenge a moderator took out of the cohort stays out, and a card moderation stopped cannot be
 * published again, after export → delete → import as much as before (NF-2). The route serialises
 * imports per user (db/lock.ts), so parallel imports cannot each use the same free room (NF-5).
 */
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  DateSchema,
  EARLY_REFLECT_FROM_DAY,
  IdSchema,
  LIMITS,
  RecipeIdSchema,
  SealSchema,
  TOTAL_DAYS,
  VerdictSchema,
  dayIndex,
  newId,
  nextFirst,
  text,
  todayIn,
  type BackupFile,
  type Challenge,
  type ImportResponse,
  type User,
} from "@thirty/shared";
import { z } from "zod";
import {
  claimChallengeId,
  getChallengeItem,
  getChallengeOwner,
  isKnownRecipe,
  listChallengeStatuses,
  listUserChallenges,
  toChallenge,
  toChallengeItem,
  type ChallengeFlags,
} from "./db/challenges";
import { getModeration } from "./db/moderation";
import { isReportDeleted } from "./db/reports";
import type { DbDeps } from "./ports";

export async function exportBackup(deps: DbDeps, user: User): Promise<BackupFile> {
  return {
    format: "thirty-days-backup",
    version: 1,
    exportedAt: deps.now().getTime(),
    user: { nickname: user.nickname, shareProgress: user.shareProgress, reminder: user.reminder },
    challenges: await listUserChallenges(deps, user.id),
  };
}

/**
 * BackupFileSchema only checks the shape. Imported titles and seals become public in the
 * cohort list, so they go through the same rules as a normal create. A day note is private and is
 * checked on its own (NoteSchema): one that breaks today's rules is dropped, not the challenge (R14).
 */
const DAY_KEY_RE = new RegExp(`^([1-9]|[12]\\d|${TOTAL_DAYS})$`);
const NoteSchema = text({ min: 0, max: LIMITS.note, label: "ひとこと" });
const ImportedChallengeSchema = z.object({
  id: IdSchema,
  recipeId: RecipeIdSchema.nullable(),
  title: text({ max: LIMITS.challengeTitle, noUrl: true, label: "チャレンジ名" }),
  seal: SealSchema,
  startDate: DateSchema,
  status: z.enum(["active", "done"]),
  stamps: z.record(
    z.string().regex(DAY_KEY_RE),
    z.object({ at: z.number().nonnegative(), note: z.string().optional() }),
  ),
  verdict: VerdictSchema.nullable(),
  reflection: text({ min: 0, max: LIMITS.reflection, multiline: true, noUrl: true, label: "ひとこと" }).nullable(),
  finishedAt: z.number().nonnegative().nullable(),
  finishedDay: z.number().int().min(1).max(TOTAL_DAYS).nullable(),
  createdAt: z.number().nonnegative(),
  updatedAt: z.number().nonnegative(),
});

export type Sanitised = { challenge: Challenge; notesDropped: number };

/**
 * Strict re-validation plus the rules of the live API, for `today` in the owner's time zone:
 * - startDate no later than the next 1st (null: the item is skipped);
 * - stamps only on days 1..min(30, today's day + 1) (later ones are dropped);
 * - a day note that fails today's text rules (too long, e.g. emoji over the UTF-8 cap of a backup
 *   written before it) is dropped and counted; the stamp stays (R14);
 * - "done" only from day EARLY_REFLECT_FROM_DAY with a verdict; otherwise imported as active and the
 *   verdict / reflection dropped; finishedDay within EARLY_REFLECT_FROM_DAY..min(30, today's day);
 * - timestamps from the future are clamped so they cannot win every merge.
 */
export function sanitise(c: Challenge, nowMs: number, today: string): Sanitised | null {
  const parsed = ImportedChallengeSchema.safeParse(c);
  if (!parsed.success) return null;
  const v = parsed.data;
  if (v.startDate > nextFirst(today)) return null;
  const day = dayIndex(v.startDate, today);
  const lastStampDay = Math.min(TOTAL_DAYS, day + 1);
  const clamp = (n: number) => Math.min(n, nowMs);
  const stamps: Challenge["stamps"] = {};
  let notesDropped = 0;
  for (const [d, s] of Object.entries(v.stamps)) {
    if (Number(d) > lastStampDay) continue;
    const note = s.note === undefined ? undefined : NoteSchema.safeParse(s.note);
    if (note && !note.success) notesDropped++;
    stamps[d] = note?.success && note.data ? { at: clamp(s.at), note: note.data } : { at: clamp(s.at) };
  }
  const done = v.status === "done" && v.verdict !== null && day >= EARLY_REFLECT_FROM_DAY;
  const lastDay = Math.min(TOTAL_DAYS, day);
  const challenge: Challenge = {
    id: v.id,
    recipeId: v.recipeId,
    title: v.title,
    seal: v.seal,
    startDate: v.startDate,
    status: done ? "done" : "active",
    stamps,
    verdict: done ? v.verdict : null,
    reflection: done ? v.reflection || null : null,
    finishedAt: done ? clamp(v.finishedAt ?? v.updatedAt) : null,
    finishedDay: done ? Math.max(EARLY_REFLECT_FROM_DAY, Math.min(v.finishedDay ?? lastDay, lastDay)) : null,
    cheers: 0,
    shareId: null,
    createdAt: clamp(v.createdAt),
    updatedAt: clamp(v.updatedAt),
  };
  return { challenge, notesDropped };
}

type Outcome = "imported" | "skipped";

/** Room left in the account; `take` reserves it synchronously, so parallel items cannot overbook. */
type Slots = { take(c: Challenge): boolean };

function slotsFor(existing: Record<string, unknown>[]): Slots {
  let total = LIMITS.challengesPerUser - existing.length;
  let open = LIMITS.openChallenges - existing.filter((i) => i.status !== "done").length;
  return {
    take(c) {
      const needsOpen = c.status !== "done";
      if (total <= 0 || (needsOpen && open <= 0)) return false;
      total--;
      if (needsOpen) open--;
      return true;
    },
  };
}

async function claimFreshId(deps: DbDeps, uid: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const id = newId(16);
    if (await claimChallengeId(deps, id, uid)) return id;
  }
  throw new Error("could not allocate a challenge id");
}

/**
 * Moderation of this challenge id that an import of it keeps (NF-2): MOD#<chId> (hidden from the
 * cohort, card stopped), and a member a moderator deleted for good (report META, older data too).
 */
export async function moderationOf(deps: DbDeps, chId: string): Promise<ChallengeFlags> {
  const [marker, deleted] = await Promise.all([getModeration(deps, chId), isReportDeleted(deps, "member", chId)]);
  const flags: ChallengeFlags = {};
  if (marker.memberHidden || deleted) flags.hiddenFromCohort = true;
  if (marker.shareModerated || deleted) flags.moderated = true;
  return flags;
}

async function importOne(deps: DbDeps, user: User, raw: Challenge, slots: Slots): Promise<Outcome> {
  const put = (ch: Challenge, flags: ChallengeFlags = {}) =>
    deps.db.send(new PutCommand({ TableName: deps.tableName, Item: toChallengeItem(user.id, user, ch, { ...flags, imported: true }) }));
  // Like a create: only known recipes (official, or community ones still published).
  const c: Challenge = { ...raw, recipeId: raw.recipeId && (await isKnownRecipe(deps, raw.recipeId)) ? raw.recipeId : null };

  const owner = await getChallengeOwner(deps, c.id);
  if (owner === user.id) {
    const existing = await getChallengeItem(deps, user.id, c.id);
    if (existing) {
      const current = toChallenge(existing);
      if (c.updatedAt <= current.updatedAt) return "skipped";
      // A reflected record stays closed (FR-6), and an import never reopens it.
      if (current.status === "done" && c.status !== "done") return "skipped";
      // Server-maintained fields (and moderation) stay as they are. `counted` is not carried over:
      // the import may change the verdict, so a later re-reflection must not move STATS (NF-3).
      const marker = await moderationOf(deps, c.id);
      await put(
        { ...c, cheers: current.cheers, shareId: current.shareId, createdAt: current.createdAt },
        {
          hiddenFromCohort: existing.hiddenFromCohort === true || marker.hiddenFromCohort === true,
          moderated: existing.moderated === true || marker.moderated === true,
        },
      );
      return "imported";
    }
    // Our id without an item (a create that failed half-way): a new item after all.
    if (!slots.take(c)) return "skipped";
    await put(c, await moderationOf(deps, c.id));
    return "imported";
  }
  if (!slots.take(c)) return "skipped";
  if (owner === undefined && (await claimChallengeId(deps, c.id, user.id))) {
    // The same id again (e.g. exported, deleted, imported): moderation of that id still applies.
    await put(c, await moderationOf(deps, c.id));
  } else {
    await put({ ...c, id: await claimFreshId(deps, user.id) });
  }
  return "imported";
}

export async function importBackup(deps: DbDeps, user: User, file: BackupFile): Promise<ImportResponse> {
  const now = deps.now();
  const nowMs = now.getTime();
  const today = todayIn(user.tz, now);
  let skipped = 0;
  // Same id twice in one file: keep the newest.
  const byId = new Map<string, Sanitised>();
  for (const raw of file.challenges.slice(0, LIMITS.importChallenges)) {
    const s = sanitise(raw, nowMs, today);
    if (!s) {
      skipped++;
      continue;
    }
    const prev = byId.get(s.challenge.id);
    if (prev) skipped++;
    if (!prev || s.challenge.updatedAt > prev.challenge.updatedAt) byId.set(s.challenge.id, s);
  }
  // Checked before anything is written: what the account holds now.
  const slots = slotsFor(await listChallengeStatuses(deps, user.id));
  let imported = 0;
  let notesDropped = 0;
  const list = [...byId.values()];
  for (let i = 0; i < list.length; i += 10) {
    const batch = list.slice(i, i + 10);
    const outcomes = await Promise.all(batch.map((s) => importOne(deps, user, s.challenge, slots)));
    outcomes.forEach((o, j) => {
      if (o === "imported") {
        imported++;
        notesDropped += batch[j]!.notesDropped;
      } else skipped++;
    });
  }
  return notesDropped > 0 ? { imported, skipped, notesDropped } : { imported, skipped };
}
