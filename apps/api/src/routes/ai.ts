import { Hono } from "hono";
import type { Deps } from "../ports";
import type { AppEnv } from "../types";

/**
 * AI suggestions (FR-13).
 *   POST /api/ai/suggest  AiSuggestRequest → AiSuggestResponse (requireUser; 503 ai_unavailable when off)
 *
 * Use deps.ai (providers/ai.ts) and enforceQuota for QUOTAS.aiPerUserPerDay / config.aiGlobalDailyLimit. Never retry automatically.
 *
 * Mounted at "/" by app.ts: register absolute paths (API in @thirty/shared has them).
 * Attach middleware per route, e.g. r.post(path, requireUser(deps), handler). Never r.use("*", ...):
 * on a router mounted at "/" it would run for every route of the app.
 */
export function aiRoutes(_deps: Deps) {
  const r = new Hono<AppEnv>();
  // TODO(ai): implement the routes above.
  return r;
}
