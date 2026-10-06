import { Hono } from "hono";
import type { Deps } from "../ports";
import type { AppEnv } from "../types";

/**
 * Reports and contact (FR-18, FR-19).
 *   POST /api/reports  ReportCreate → 204 (requireUser)
 *   POST /api/contact  ContactCreate → 204 (optionalUser)
 *
 * Put gsi2 AUTHOR#<uid> on reporter (BY#<uid>) items if they should be removed by DELETE /api/me.
 *
 * Mounted at "/" by app.ts: register absolute paths (API in @thirty/shared has them).
 * Attach middleware per route, e.g. r.post(path, requireUser(deps), handler). Never r.use("*", ...):
 * on a router mounted at "/" it would run for every route of the app.
 */
export function reportsRoutes(_deps: Deps) {
  const r = new Hono<AppEnv>();
  // TODO(reports): implement the routes above.
  return r;
}
