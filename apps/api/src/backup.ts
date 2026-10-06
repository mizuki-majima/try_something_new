/**
 * Backup export / import (SPEC FR-16). Import merges challenges into the caller's account;
 * the profile is left as it is (the client can PATCH /api/me from backup.user if it wants).
 */
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  DateSchema,
  IdSchema,
  LIMITS,
  RecipeIdSchema,
  SealSchema,
  TOTAL_DAYS,
  VerdictSchema,
  newId,
  text,
  type BackupFile,
  type Challenge,
  type ImportResponse,
  type User,
} from "@thirty/shared";
import { z } from "zod";
import { claimChallengeId, getChallengeItem, getChallengeOwner, listUserChallenges, toChallenge, toChallengeItem } from "./db/challenges";
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
 * cohort list, so they go through the same rules as a normal create.
 */
const DAY_KEY_RE = new RegExp(`^([1-9]|[12]\\d|${TOTAL_DAYS})$`);
const ImportedChallengeSchema = z.object({
  id: IdSchema,
  recipeId: RecipeIdSchema.nullable(),
  title: text({ max: LIMITS.challengeTitle, noUrl: true, label: "チャレンジ名" }),
  seal: SealSchema,
  startDate: DateSchema,
  status: z.enum(["active", "done"]),
  stamps: z.record(
    z.string().regex(DAY_KEY_RE),
    z.object({ at: z.number().nonnegative(), note: text({ min: 0, max: LIMITS.note, label: "ひとこと" }).optional() }),
  ),
  verdict: VerdictSchema.nullable(),
  reflection: text({ min: 0, max: LIMITS.reflection, multiline: true, noUrl: true, label: "ひとこと" }).nullable(),
  finishedAt: z.number().nonnegative().nullable(),
  finishedDay: z.number().int().min(1).max(TOTAL_DAYS).nullable(),
  createdAt: z.number().nonnegative(),
  updatedAt: z.number().nonnegative(),
});

/** Strict re-validation; timestamps from the future are clamped so they cannot win every merge. */
function sanitise(c: Challenge, nowMs: number): Challenge | null {
  const parsed = ImportedChallengeSchema.safeParse(c);
  if (!parsed.success) return null;
  const v = parsed.data;
  const clamp = (n: number) => Math.min(n, nowMs);
  const stamps: Challenge["stamps"] = {};
  for (const [day, s] of Object.entries(v.stamps)) stamps[day] = s.note ? { at: clamp(s.at), note: s.note } : { at: clamp(s.at) };
  return {
    id: v.id,
    recipeId: v.recipeId,
    title: v.title,
    seal: v.seal,
    startDate: v.startDate,
    status: v.status,
    stamps,
    verdict: v.verdict,
    reflection: v.reflection || null,
    finishedAt: v.finishedAt === null ? null : clamp(v.finishedAt),
    finishedDay: v.finishedDay,
    cheers: 0,
    shareId: null,
    createdAt: clamp(v.createdAt),
    updatedAt: clamp(v.updatedAt),
  };
}

type Outcome = "imported" | "skipped";

async function claimFreshId(deps: DbDeps, uid: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const id = newId(16);
    if (await claimChallengeId(deps, id, uid)) return id;
  }
  throw new Error("could not allocate a challenge id");
}

async function importOne(deps: DbDeps, user: User, c: Challenge): Promise<Outcome> {
  const put = (ch: Challenge, hiddenFromCohort?: boolean) =>
    deps.db.send(new PutCommand({ TableName: deps.tableName, Item: toChallengeItem(user.id, user, ch, { hiddenFromCohort }) }));

  const owner = await getChallengeOwner(deps, c.id);
  if (owner === user.id) {
    const existing = await getChallengeItem(deps, user.id, c.id);
    if (!existing) {
      await put(c);
      return "imported";
    }
    const current = toChallenge(existing);
    if (c.updatedAt <= current.updatedAt) return "skipped";
    // Server-maintained fields stay as they are.
    await put({ ...c, cheers: current.cheers, shareId: current.shareId, createdAt: current.createdAt }, existing.hiddenFromCohort === true);
    return "imported";
  }
  const id = owner === undefined && (await claimChallengeId(deps, c.id, user.id)) ? c.id : await claimFreshId(deps, user.id);
  await put({ ...c, id });
  return "imported";
}

export async function importBackup(deps: DbDeps, user: User, file: BackupFile): Promise<ImportResponse> {
  const nowMs = deps.now().getTime();
  let skipped = 0;
  // Same id twice in one file: keep the newest.
  const byId = new Map<string, Challenge>();
  for (const raw of file.challenges.slice(0, LIMITS.importChallenges)) {
    const c = sanitise(raw, nowMs);
    if (!c) {
      skipped++;
      continue;
    }
    const prev = byId.get(c.id);
    if (prev) skipped++;
    if (!prev || c.updatedAt > prev.updatedAt) byId.set(c.id, c);
  }
  let imported = 0;
  const list = [...byId.values()];
  for (let i = 0; i < list.length; i += 10) {
    const outcomes = await Promise.all(list.slice(i, i + 10).map((c) => importOne(deps, user, c)));
    for (const o of outcomes) {
      if (o === "imported") imported++;
      else skipped++;
    }
  }
  return { imported, skipped };
}
