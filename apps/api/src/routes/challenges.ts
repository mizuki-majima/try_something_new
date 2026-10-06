import { Hono } from "hono";
import type { Deps } from "../ports";
import type { AppEnv } from "../types";

/**
 * Challenges (FR-3, FR-4, FR-6).
 *   GET    /api/challenges                      → ChallengeListResponse (requireUser)
 *   POST   /api/challenges                      ChallengeCreate → ChallengeResponse (201, idempotent on id)
 *   PATCH  /api/challenges/:id                  ChallengePatch → ChallengeResponse
 *   DELETE /api/challenges/:id                  → 204
 *   PUT    /api/challenges/:id/stamps/:day      StampPut → ChallengeResponse
 *   DELETE /api/challenges/:id/stamps/:day      → ChallengeResponse
 *   POST   /api/challenges/:id/reflect          Reflect → ChallengeResponse
 *
 * Build on db/challenges.ts (toChallengeItem, cohortProjection, claimChallengeId).
 *
 * Mounted at "/" by app.ts: register absolute paths (API in @thirty/shared has them).
 * Attach middleware per route, e.g. r.post(path, requireUser(deps), handler). Never r.use("*", ...):
 * on a router mounted at "/" it would run for every route of the app.
 */
export function challengesRoutes(_deps: Deps) {
  const r = new Hono<AppEnv>();
  // TODO(challenges): implement the routes above.
  return r;
}
