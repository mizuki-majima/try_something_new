import { Hono } from "hono";
import type { Deps } from "../ports";
import type { AppEnv } from "../types";

/**
 * Cohorts "1日組" and cheers (FR-8, FR-9).
 *   GET  /api/cohorts/:month       → CohortResponse (optionalUser)
 *   GET  /api/cohorts/upcoming     → UpcomingResponse (register before /:month)
 *   POST /api/cheers/:challengeId  → CheerResponse (requireUser)
 *
 * Cohort members come from gsi1 COHORT#<YYYY-MM>; never expose notes or user ids.
 *
 * Mounted at "/" by app.ts: register absolute paths (API in @thirty/shared has them).
 * Attach middleware per route, e.g. r.post(path, requireUser(deps), handler). Never r.use("*", ...):
 * on a router mounted at "/" it would run for every route of the app.
 */
export function cohortsRoutes(_deps: Deps) {
  const r = new Hono<AppEnv>();
  // TODO(cohorts): implement the routes above.
  return r;
}
