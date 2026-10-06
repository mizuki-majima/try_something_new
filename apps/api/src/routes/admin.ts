import { Hono } from "hono";
import type { Deps } from "../ports";
import type { AppEnv } from "../types";

/**
 * Admin (FR-18).
 *   GET   /api/admin/reports       → AdminReportsResponse
 *   POST  /api/admin/moderate      AdminModerate → 204
 *   PATCH /api/admin/recipes/:id   { featured } → 204
 *   GET   /api/admin/stats         → AdminStats
 *   GET   /api/admin/contacts      → AdminContactsResponse
 *
 * Every route uses requireAdmin(deps) (X-Admin-Token).
 *
 * Mounted at "/" by app.ts: register absolute paths (API in @thirty/shared has them).
 * Attach middleware per route, e.g. r.post(path, requireUser(deps), handler). Never r.use("*", ...):
 * on a router mounted at "/" it would run for every route of the app.
 */
export function adminRoutes(_deps: Deps) {
  const r = new Hono<AppEnv>();
  // TODO(admin): implement the routes above.
  return r;
}
