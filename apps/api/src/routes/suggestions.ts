import { Hono } from "hono";
import type { Deps } from "../ports";
import type { AppEnv } from "../types";

/**
 * "ひらめき提案" (FR-13). No generative AI (ADR 0003).
 *   POST /api/suggestions  SuggestRequest → SuggestResponse (requireUser)
 *
 * Use deps.suggestions (providers/suggestions.ts) and enforceQuota for QUOTAS.suggestionsPerUserPerDay. Never store the hint.
 *
 * Mounted at "/" by app.ts: register absolute paths (API in @thirty/shared has them).
 * Attach middleware per route, e.g. r.post(path, requireUser(deps), handler). Never r.use("*", ...):
 * on a router mounted at "/" it would run for every route of the app.
 */
export function suggestionRoutes(_deps: Deps) {
  const r = new Hono<AppEnv>();
  // TODO(suggestions): implement the route above.
  return r;
}
