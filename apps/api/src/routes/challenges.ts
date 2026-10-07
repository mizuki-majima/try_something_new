import { Hono, type Context } from "hono";
import {
  API,
  ChallengeCreateSchema,
  ChallengePatchSchema,
  DaySchema,
  EARLY_REFLECT_FROM_DAY,
  IdSchema,
  LIMITS,
  QUOTAS,
  ReflectSchema,
  StampPutSchema,
  TOTAL_DAYS,
  challengePhase,
  dayIndex,
  diffDays,
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
  countOpenChallenges,
  deleteChallenge,
  getChallengeItem,
  getChallengeOwner,
  isKnownRecipe,
  listUserChallenges,
  putNewChallenge,
  toChallenge,
  updateChallenge,
  type ChallengeUpdate,
} from "../db/challenges";
import { enforceQuota, refundQuota } from "../db/rate";
import { bumpStats } from "../db/stats";
import { badRequest, conflict, MESSAGES, notFound } from "../errors";
import { log } from "../log";
import type { Deps } from "../ports";
import type { AppEnv } from "../types";
import { parseWith, readJson } from "../validate";

export const CHALLENGE_MESSAGES = {
  idTaken: "このIDはすでに使われています。画面を読み込み直して、もう一度お試しください",
  startDate: "開始日は「今日」か「次の1日」を選んでください",
  openLimit: `同時に進められるチャレンジは${LIMITS.openChallenges}件までです。振り返るか削除してから始めてください`,
  done: "振り返りが済んだチャレンジは変更できません",
  started: "始まったチャレンジの開始日は変えられません",
  futureDay: "まだ来ていない日には印を押せません",
  tooEarly: `「ここで区切る」は${EARLY_REFLECT_FROM_DAY}日目からできます`,
  busy: "ほかの端末での変更と重なりました。もう一度お試しください",
} as const;
const M = CHALLENGE_MESSAGES;

/** Rate-limit scope of QUOTAS.challengesPerUserPerDay. */
export const CREATE_QUOTA_SCOPE = "challenge-create";

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
type PlanContext = { today: string; now: number };

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
      const p = plan(before, { today: todayIn(user.tz, nowDate), now });
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
    if ((await countOpenChallenges(deps, user.id)) >= LIMITS.openChallenges) throw conflict(M.openLimit);

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
    const { after } = await mutate(c.var.user, id, (ch, { today, now }) => {
      if (ch.status === "done") throw conflict(M.done);
      // Missed days can be filled in; the future cannot (+1 day of slack for clocks and time zones).
      if (day > Math.min(TOTAL_DAYS, dayIndex(ch.startDate, today) + 1)) throw badRequest(M.futureDay);
      const prev = ch.stamps[String(day)];
      const note = input.note === undefined ? prev?.note : input.note;
      return {
        stamp: { day, value: note ? { at: prev?.at ?? now, note } : { at: prev?.at ?? now } },
        expect: { status: "active", startDate: ch.startDate },
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

  // ---------- reflect (FR-6) ----------

  r.post(`${idPath}/reflect`, auth, async (c) => {
    const id = parseWith(IdSchema, c.req.param("id"));
    const input = await readJson(c, ReflectSchema);
    const { before, after } = await mutate(c.var.user, id, (ch, { today, now }) => {
      if (ch.status === "done") {
        // Changing one's mind later: verdict / reflection only, the record stays closed. Conditioned
        // on the verdict read, so the verdict counters below move exactly once per change. An
        // imported record stays private (a re-reflection is not the owner using the challenge).
        return {
          set: { verdict: input.verdict, reflection: input.reflection === undefined ? undefined : input.reflection || null },
          expect: { status: "done", ...(ch.verdict ? { verdict: ch.verdict } : {}) },
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
      };
    });
    if (before.status === "active") {
      // The write was conditioned on "active", so this runs once per challenge.
      await bumpStats(deps, { challengesDone: 1, [`verdict_${input.verdict}`]: 1 });
      log.info("challenge reflected", { uid: c.var.uid, verdict: input.verdict, day: after.finishedDay });
    } else if (before.verdict && after.verdict && before.verdict !== after.verdict) {
      // A changed verdict moves between the counters (the write was conditioned on before.verdict).
      await bumpStats(deps, { [`verdict_${before.verdict}`]: -1, [`verdict_${after.verdict}`]: 1 });
    }
    return c.json<ChallengeResponse>({ challenge: after });
  });

  return r;
}
