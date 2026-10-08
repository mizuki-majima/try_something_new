import { Hono, type Context } from "hono";
import {
  API,
  ChallengeCreateSchema,
  ChallengePatchSchema,
  DaySchema,
  EARLY_REFLECT_FROM_DAY,
  IdSchema,
  LIMITS,
  NoteVisibilitySchema,
  PublicNoteSchema,
  QUOTAS,
  ReflectSchema,
  StampPutSchema,
  TOTAL_DAYS,
  challengePhase,
  dayIndex,
  diffDays,
  isPublicNote,
  nextFirst,
  todayIn,
  type Challenge,
  type ChallengeListResponse,
  type ChallengeResponse,
  type User,
} from "@thirty/shared";
import type { z } from "zod";
import { requireUser } from "../auth";
import {
  bumpRecipeStarts,
  claimChallengeId,
  countChallenges,
  deleteChallenge,
  getChallengeItem,
  getChallengeOwner,
  isKnownRecipe,
  listUserChallenges,
  putNewChallenge,
  setStampShown,
  toChallenge,
  updateChallenge,
  type ChallengeUpdate,
} from "../db/challenges";
import type { StoredStamp } from "../db/notes";
import { enforceQuota, refundQuota } from "../db/rate";
import { bumpStats } from "../db/stats";
import { getUser } from "../db/users";
import type { Item } from "../db/util";
import { badRequest, conflict, MESSAGES, notFound } from "../errors";
import { log } from "../log";
import type { Deps } from "../ports";
import type { AppEnv } from "../types";
import { parseWith, readJson } from "../validate";

export const CHALLENGE_MESSAGES = {
  idTaken: "このIDはすでに使われています。画面を読み込み直して、もう一度お試しください",
  startDate: "開始日は「今日」か「次の1日」を選んでください",
  openLimit: `同時に進められるチャレンジは${LIMITS.openChallenges}件までです。振り返るか削除してから始めてください`,
  totalLimit: `持てるチャレンジは全部で${LIMITS.challengesPerUser}件までです。終わったチャレンジを削除してから始めてください`,
  done: "振り返りが済んだチャレンジは変更できません",
  started: "始まったチャレンジの開始日は変えられません",
  futureDay: "まだ来ていない日には印を押せません",
  tooEarly: `「ここで区切る」は${EARLY_REFLECT_FROM_DAY}日目からできます`,
  busy: "ほかの端末での変更と重なりました。もう一度お試しください",
  // Showing a day note in 「みんな」 (#17).
  noteMissing: "ひとことがある日だけ、みんなに見せられます。",
  noteChanged: "ひとことが変わっていたため、見せませんでした。内容を確かめてから、もう一度選んでください。",
  noteNotNormal: "このひとことは今の決まりに合わないため、見せられません。書き直して保存してから選んでください。",
  progressOff: "進捗の表示がオフのため、見せられません。設定でオンにしてから選んでください。",
  notListed: "この記録は「みんな」に表示されていないため、見せられません。",
} as const;
const M = CHALLENGE_MESSAGES;

/** Rate-limit scope of QUOTAS.challengesPerUserPerDay. */
export const CREATE_QUOTA_SCOPE = "challenge-create";
/** Rate-limit scope of QUOTAS.noteShowsPerUserPerDay. */
export const NOTE_SHOW_QUOTA_SCOPE = "note-show";

/** How far back a create's start date may be: an offline create can reach the server days later. */
export const CREATE_REPLAY_DAYS = 7;

/**
 * Start dates accepted on create. The client offers "today" or "the next 1st"; the server also
 * accepts up to CREATE_REPLAY_DAYS days back (a create queued offline and replayed later keeps the
 * date chosen on the device, and its queued stamps with it) and tomorrow (clock / time-zone slack).
 */
export function isAllowedStartDate(startDate: string, today: string): boolean {
  if (startDate === nextFirst(today)) return true;
  const offset = diffDays(today, startDate);
  return offset >= -CREATE_REPLAY_DAYS && offset <= 1;
}

type Plan = Omit<ChallengeUpdate, "owner" | "now">;
/** `counted`: this challenge's verdict is in STATS (see ChallengeItem.counted). `item`: the raw item read. */
type PlanContext = { today: string; now: number; counted: boolean; item: Item };

/** stamps.<day> as stored (with the consent `shownNote`, which toChallenge leaves out). */
function storedStamp(item: Item, day: number): Partial<StoredStamp> | undefined {
  const stamps = item.stamps && typeof item.stamps === "object" ? (item.stamps as Record<string, unknown>) : undefined;
  const s = stamps?.[String(day)];
  return s && typeof s === "object" ? (s as Partial<StoredStamp>) : undefined;
}

/** A JSON body that may also be empty (PUT /stamps/:day with nothing to say). */
async function readOptionalJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  const text = await c.req.text();
  if (!text.trim()) return schema.parse({});
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw badRequest(MESSAGES.badJson);
  }
  return schema.parse(body);
}

export function challengesRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  const auth = requireUser(deps);
  const idPath = `${API.challenges}/:id`;
  const stampPath = `${API.challenges}/:id/stamps/:day`;

  /**
   * Read → decide (plan may throw 4xx) → conditional write. The write is conditioned on what the
   * plan relied on (status, start date); if another request changed it meanwhile, decide again.
   * Only the owner's partition is read, so someone else's id is simply 404.
   */
  async function mutate(user: User, id: string, plan: (c: Challenge, ctx: PlanContext) => Plan) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const item = await getChallengeItem(deps, user.id, id);
      if (!item) throw notFound();
      const before = toChallenge(item);
      const nowDate = deps.now();
      const now = nowDate.getTime();
      const p = plan(before, { today: todayIn(user.tz, nowDate), now, counted: item.counted === true, item });
      const after = await updateChallenge(deps, user.id, item, { ...p, owner: user, now });
      if (after) return { before, after };
    }
    throw conflict(M.busy);
  }

  // ---------- list / create ----------

  r.get(API.challenges, auth, async (c) => {
    const user = c.var.user;
    const challenges = await listUserChallenges(deps, user.id);
    return c.json<ChallengeListResponse>({ challenges, today: todayIn(user.tz, deps.now()) });
  });

  r.post(API.challenges, auth, async (c) => {
    const input = await readJson(c, ChallengeCreateSchema);
    const user = c.var.user;

    // Idempotent on the client-generated id: a replay returns what was created.
    const existing = await getChallengeItem(deps, user.id, input.id);
    if (existing) return c.json<ChallengeResponse>({ challenge: toChallenge(existing) }, 200);
    const owner = await getChallengeOwner(deps, input.id);
    if (owner !== undefined && owner !== user.id) throw conflict(M.idTaken);

    const nowDate = deps.now();
    const today = todayIn(user.tz, nowDate);
    if (!isAllowedStartDate(input.startDate, today)) throw badRequest(M.startDate, { startDate: M.startDate });
    const held = await countChallenges(deps, user.id);
    if (held.open >= LIMITS.openChallenges) throw conflict(M.openLimit);
    // An account holds at most LIMITS.challengesPerUser (like an import), so the list and the export
    // never need to read more than that (R15).
    if (held.total >= LIMITS.challengesPerUser) throw conflict(M.totalLimit);

    // Counted only for a create that passed every check above (a replay returned earlier); given
    // back below when it turns out not to create after all.
    await enforceQuota(deps, CREATE_QUOTA_SCOPE, user.id, QUOTAS.challengesPerUserPerDay, "day");
    const refund = () => refundQuota(deps, CREATE_QUOTA_SCOPE, user.id, "day");

    if (owner === undefined && !(await claimChallengeId(deps, input.id, user.id))) {
      // Someone claimed it between our read and the claim (or our own concurrent replay did).
      if ((await getChallengeOwner(deps, input.id)) !== user.id) {
        await refund();
        throw conflict(M.idTaken);
      }
    }

    const recipeId = input.recipeId && (await isKnownRecipe(deps, input.recipeId)) ? input.recipeId : null;
    const now = nowDate.getTime();
    const challenge: Challenge = {
      id: input.id,
      recipeId,
      title: input.title,
      seal: input.seal,
      startDate: input.startDate,
      status: "active",
      stamps: {},
      verdict: null,
      reflection: null,
      finishedAt: null,
      finishedDay: null,
      cheers: 0,
      shareId: null,
      createdAt: now,
      updatedAt: now,
    };
    if (!(await putNewChallenge(deps, user.id, user, challenge))) {
      // A concurrent replay of the same create wrote it first and was counted itself.
      await refund();
      const raced = await getChallengeItem(deps, user.id, input.id);
      if (raced) return c.json<ChallengeResponse>({ challenge: toChallenge(raced) }, 200);
      throw conflict(M.busy);
    }
    await Promise.all([bumpStats(deps, { challengesStarted: 1 }), recipeId ? bumpRecipeStarts(deps, recipeId) : undefined]);
    log.info("challenge created", { uid: user.id, recipe: recipeId ?? "custom" });
    return c.json<ChallengeResponse>({ challenge }, 201);
  });

  // ---------- edit / delete ----------

  r.patch(idPath, auth, async (c) => {
    const id = parseWith(IdSchema, c.req.param("id"));
    const input = await readJson(c, ChallengePatchSchema);
    const { after } = await mutate(c.var.user, id, (ch, { today }) => {
      if (ch.status === "done") throw conflict(M.done);
      if (input.startDate !== undefined && input.startDate !== ch.startDate) {
        if (challengePhase(ch, today) !== "waiting") throw conflict(M.started);
        if (input.startDate !== today && input.startDate !== nextFirst(today)) {
          throw badRequest(M.startDate, { startDate: M.startDate });
        }
      }
      return {
        set: { title: input.title, seal: input.seal, startDate: input.startDate },
        expect: { status: "active", startDate: ch.startDate },
      };
    });
    return c.json<ChallengeResponse>({ challenge: after });
  });

  r.delete(idPath, auth, async (c) => {
    const id = parseWith(IdSchema, c.req.param("id"));
    if (!(await deleteChallenge(deps, c.var.uid, id))) throw notFound();
    return c.body(null, 204);
  });

  // ---------- stamps (FR-4) ----------

  r.put(stampPath, auth, async (c) => {
    const id = parseWith(IdSchema, c.req.param("id"));
    const day = parseWith(DaySchema, c.req.param("day"));
    const input = await readOptionalJson(c, StampPutSchema);
    const { after } = await mutate(c.var.user, id, (ch, { today, now, item }) => {
      if (ch.status === "done") throw conflict(M.done);
      // Missed days can be filled in; the future cannot (+1 day of slack for clocks and time zones).
      if (day > Math.min(TOTAL_DAYS, dayIndex(ch.startDate, today) + 1)) throw badRequest(M.futureDay);
      const prev = ch.stamps[String(day)];
      const shownNote = storedStamp(item, day)?.shownNote;
      const note = input.note === undefined ? prev?.note : input.note;
      // A note shown in 「みんな」 stays shown only for the very text the owner chose (a re-stamp, or
      // saving it unchanged). Any other text, an empty note included, is private again: so is every
      // save from a client that does not know about showing (an old PWA, an offline replay).
      const keepShown = !!note && shownNote === note && note === prev?.note && isPublicNote(note);
      return {
        stamp: { day, value: note ? { at: prev?.at ?? now, note, ...(keepShown ? { shownNote: note } : {}) } : { at: prev?.at ?? now } },
        expect: { status: "active", startDate: ch.startDate },
        // A whole-stamp write: if the owner stopped showing the note meanwhile, decide again.
        expectShownNote: typeof shownNote === "string" ? shownNote : null,
      };
    });
    return c.json<ChallengeResponse>({ challenge: after });
  });

  r.delete(stampPath, auth, async (c) => {
    const id = parseWith(IdSchema, c.req.param("id"));
    const day = parseWith(DaySchema, c.req.param("day"));
    const { after } = await mutate(c.var.user, id, (ch) => {
      if (ch.status === "done") throw conflict(M.done);
      return { stamp: { day, value: null }, expect: { status: "active" } };
    });
    return c.json<ChallengeResponse>({ challenge: after });
  });

  // ---------- day notes in 「みんな」 (#17) ----------

  /**
   * Show the day's note in 「みんな」, or stop showing it. Online only, never through mutate: the write
   * leaves updatedAt and the cohort projection alone (db/challenges.ts setStampShown). Stopping is a
   * privacy action: never counted, and allowed on any challenge (done, imported, hidden). Showing is
   * refused unless the stored note is the text the owner saw and can be public, progress is shared and
   * the challenge is listed; only a real private → shown change counts towards the daily quota.
   * Note text is never logged, and only the owner's own challenge is ever returned (someone else's id
   * is a plain 404, as on every route here). The route reads strongly consistent (and reads the user
   * again before refusing for progress off): an answer made from a replica that has not seen a write
   * of a moment ago (an un-share, a saved note, progress turned on) would say "already shown" without
   * writing, or refuse what the owner has just done.
   */
  r.put(`${stampPath}/visibility`, auth, async (c) => {
    const id = parseWith(IdSchema, c.req.param("id"));
    const day = parseWith(DaySchema, c.req.param("day"));
    const input = await readJson(c, NoteVisibilitySchema);
    const user = c.var.user;

    if (!input.show) {
      let after = await setStampShown(deps, user.id, id, day, null);
      if (!after) {
        // No stamp that day (nothing to stop showing), or no such challenge in the caller's partition.
        const item = await getChallengeItem(deps, user.id, id, { consistent: true });
        if (!item) throw notFound();
        after = toChallenge(item);
      }
      log.info("note visibility", { uid: user.id, day, show: false });
      return c.json<ChallengeResponse>({ challenge: after });
    }

    const item = await getChallengeItem(deps, user.id, id, { consistent: true });
    if (!item) throw notFound();
    const stored = storedStamp(item, day);
    const note = typeof stored?.at === "number" && typeof stored.note === "string" ? stored.note : "";
    if (!note) throw badRequest(M.noteMissing, { note: M.noteMissing });
    // Consent is for the text the owner saw: not one changed on another device meanwhile.
    if (input.note !== note) throw conflict(M.noteChanged);
    const parsed = PublicNoteSchema.safeParse(note);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? M.noteNotNormal;
      throw badRequest(message, { note: message });
    }
    if (parsed.data !== note) throw badRequest(M.noteNotNormal, { note: M.noteNotNormal });
    // The session's copy of the user is a plain read: look again before refusing.
    if (!user.shareProgress && (await getUser(deps, user.id, { consistent: true }))?.shareProgress !== true) throw conflict(M.progressOff);
    if (item.hiddenFromCohort === true || item.imported === true) throw conflict(M.notListed);
    if (stored?.shownNote === note) return c.json<ChallengeResponse>({ challenge: toChallenge(item) });

    await enforceQuota(deps, NOTE_SHOW_QUOTA_SCOPE, user.id, QUOTAS.noteShowsPerUserPerDay, "day");
    const after = await setStampShown(deps, user.id, id, day, note);
    if (!after) {
      // Changed between the read and the write: nothing was shown, so the use is given back.
      await refundQuota(deps, NOTE_SHOW_QUOTA_SCOPE, user.id, "day");
      const current = await getChallengeItem(deps, user.id, id, { consistent: true });
      if (!current) throw notFound();
      if (current.hiddenFromCohort === true || current.imported === true) throw conflict(M.notListed);
      throw conflict(storedStamp(current, day)?.note === note ? M.busy : M.noteChanged);
    }
    log.info("note visibility", { uid: user.id, day, show: true });
    return c.json<ChallengeResponse>({ challenge: after });
  });

  // ---------- reflect (FR-6) ----------

  r.post(`${idPath}/reflect`, auth, async (c) => {
    const id = parseWith(IdSchema, c.req.param("id"));
    const input = await readJson(c, ReflectSchema);
    let counted = false;
    const { before, after } = await mutate(c.var.user, id, (ch, { today, now, counted: wasCounted }) => {
      counted = wasCounted;
      if (ch.status === "done") {
        // Changing one's mind later: verdict / reflection only, the record stays closed. Conditioned
        // on the verdict (and `counted`) read, so the verdict counters below move exactly once per
        // change, and only for a verdict STATS holds. An imported record stays private (a
        // re-reflection is not the owner using the challenge) and was never counted (NF-3).
        return {
          set: { verdict: input.verdict, reflection: input.reflection === undefined ? undefined : input.reflection || null },
          expect: { status: "done", counted: wasCounted, ...(ch.verdict ? { verdict: ch.verdict } : {}) },
          keepImported: true,
        };
      }
      const index = dayIndex(ch.startDate, today);
      if (index < EARLY_REFLECT_FROM_DAY) throw badRequest(M.tooEarly);
      return {
        set: {
          status: "done",
          verdict: input.verdict,
          reflection: input.reflection || null,
          finishedAt: now,
          finishedDay: Math.min(TOTAL_DAYS, index),
        },
        expect: { status: "active", startDate: ch.startDate },
        // Same write: this challenge's verdict is about to be added to STATS (below).
        markCounted: true,
      };
    });
    if (before.status === "active") {
      // The write was conditioned on "active", so this runs once per challenge.
      await bumpStats(deps, { challengesDone: 1, [`verdict_${input.verdict}`]: 1 });
      log.info("challenge reflected", { uid: c.var.uid, verdict: input.verdict, day: after.finishedDay });
    } else if (counted && before.verdict && after.verdict && before.verdict !== after.verdict) {
      // A changed verdict moves between the counters (the write was conditioned on before.verdict
      // and on `counted`). Never for a verdict that was not counted: it would go below its true value.
      await bumpStats(deps, { [`verdict_${before.verdict}`]: -1, [`verdict_${after.verdict}`]: 1 });
    }
    return c.json<ChallengeResponse>({ challenge: after });
  });

  return r;
}
