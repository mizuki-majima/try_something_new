import { Hono } from "hono";
import {
  API,
  DEFAULT_TIMEZONE,
  IdSchema,
  QUOTAS,
  nextFirst,
  todayIn,
  type CheerResponse,
  type CohortResponse,
  type MemberNotesResponse,
  type UpcomingResponse,
} from "@thirty/shared";
import { optionalUser, requireUser } from "../auth";
import { addCheer, getChallengeItem, getChallengeOwner } from "../db/challenges";
import {
  cheeredOn,
  isInCohort,
  MONTH_RE,
  putCheerMarker,
  queryCohort,
  queryStartingOn,
  summariseUpcoming,
  toCohortMember,
  visibleNotes,
} from "../db/cohorts";
import { enforceQuota } from "../db/rate";
import { getUser } from "../db/users";
import { badRequest, conflict, notFound } from "../errors";
import type { Deps } from "../ports";
import { viewer, type AppEnv } from "../types";
import { parseWith } from "../validate";

export const COHORT_MESSAGES = {
  month: "月の形式が正しくありません（例: 2026-10）",
  cheerOwn: "自分のチャレンジは応援できません",
  cheerTwice: "今日はもう応援しました",
} as const;

/**
 * Cohorts "1日組", the day notes members show, and cheers (FR-8, FR-9, #17).
 *   GET  /api/cohorts/upcoming            → UpcomingResponse (optionalUser)
 *   GET  /api/cohorts/:month              → CohortResponse (optionalUser)
 *   GET  /api/members/:challengeId/notes  → MemberNotesResponse (public)
 *   POST /api/cheers/:challengeId         → CheerResponse (requireUser)
 *
 * "Today" is the viewer's calendar day (Asia/Tokyo for anonymous visitors).
 */
export function cohortsRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  const optional = optionalUser(deps);

  // Registered before /:month so "upcoming" is not read as a month.
  r.get(API.cohortUpcoming, optional, async (c) => {
    const startDate = nextFirst(todayIn(viewer(c)?.tz ?? DEFAULT_TIMEZONE, deps.now()));
    const items = await queryStartingOn(deps, startDate);
    return c.json<UpcomingResponse>(summariseUpcoming(items, startDate));
  });

  r.get(API.cohort(":month"), optional, async (c) => {
    const month = c.req.param("month") ?? "";
    if (!MONTH_RE.test(month)) throw badRequest(COHORT_MESSAGES.month);
    const items = await queryCohort(deps, month);
    const me = viewer(c);
    const cheered = me
      ? await cheeredOn(
          deps,
          me.id,
          todayIn(me.tz, deps.now()),
          items.filter((i) => i.userId !== me.id).map((i) => String(i.id)),
        )
      : new Set<string>();
    return c.json<CohortResponse>({ month, members: items.map((i) => toCohortMember(i, me?.id, cheered)) });
  });

  // Read on every open of a member's details, never cached (/api is no-store). Strongly consistent
  // reads of the challenge and of the owner's shareProgress: an un-share, turning progress off, a
  // moderator's hide or a deleted account applies to the very next request, whatever gsi1 still holds
  // (it is eventually consistent, and syncUserProjection may give up). Every refusal is the same 404.
  r.get(API.memberNotes(":challengeId"), async (c) => {
    const chId = parseWith(IdSchema, c.req.param("challengeId"));
    const owner = await getChallengeOwner(deps, chId);
    if (owner === undefined) throw notFound();
    const [item, user] = await Promise.all([
      getChallengeItem(deps, owner, chId, { consistent: true }),
      getUser(deps, owner, { consistent: true }),
    ]);
    if (!item || user?.shareProgress !== true || !isInCohort(item)) throw notFound();
    return c.json<MemberNotesResponse>({ challengeId: chId, notes: visibleNotes(item) });
  });

  r.post(API.cheer(":challengeId"), requireUser(deps), async (c) => {
    const chId = parseWith(IdSchema, c.req.param("challengeId"));
    const user = c.var.user;
    await enforceQuota(deps, "cheer", user.id, QUOTAS.cheersPerUserPerDay, "day");

    const owner = await getChallengeOwner(deps, chId);
    if (owner === undefined) throw notFound();
    if (owner === user.id) throw badRequest(COHORT_MESSAGES.cheerOwn);
    // Only what the cohort list shows can be cheered; anything else is "not found".
    const item = await getChallengeItem(deps, owner, chId);
    if (!item || !isInCohort(item)) throw notFound();

    if (!(await putCheerMarker(deps, user.id, chId, todayIn(user.tz, deps.now())))) throw conflict(COHORT_MESSAGES.cheerTwice);
    const cheers = await addCheer(deps, owner, chId);
    if (cheers === undefined) throw notFound(); // deleted meanwhile
    return c.json<CheerResponse>({ cheers, cheeredToday: true });
  });

  return r;
}
