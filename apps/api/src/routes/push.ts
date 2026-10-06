import { Hono } from "hono";
import type { Deps } from "../ports";
import type { AppEnv } from "../types";

/**
 * Web Push reminders (FR-14).
 *   GET    /api/push/public-key     → PushPublicKeyResponse
 *   POST   /api/push/subscriptions  PushSubscriptionInput → 204 (requireUser)
 *   DELETE /api/push/subscriptions  PushUnsubscribe → 204 (requireUser; DELETE with a JSON body)
 *   POST   /api/push/test           → 204 (requireUser)
 *
 * Build on db/push.ts (updateUserSlots, reminderSlot) and deps.push.
 *
 * Mounted at "/" by app.ts: register absolute paths (API in @thirty/shared has them).
 * Attach middleware per route, e.g. r.post(path, requireUser(deps), handler). Never r.use("*", ...):
 * on a router mounted at "/" it would run for every route of the app.
 */
export function pushRoutes(_deps: Deps) {
  const r = new Hono<AppEnv>();
  // TODO(push): implement the routes above.
  return r;
}
