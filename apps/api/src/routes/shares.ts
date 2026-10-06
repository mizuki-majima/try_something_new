import { Hono } from "hono";
import type { Deps } from "../ports";
import type { AppEnv } from "../types";

/**
 * Share cards (FR-7).
 *   POST   /api/shares      ShareCreate → ShareResponse (requireUser)
 *   DELETE /api/shares/:id  → 204 (owner)
 *   GET    /s/:id           public HTML page with OGP tags (everything HTML-escaped)
 *
 * Images go to deps.media at shareMediaKey(id); SHARE items carry gsi2 AUTHOR#<uid>.
 *
 * Mounted at "/" by app.ts: register absolute paths (API in @thirty/shared has them).
 * Attach middleware per route, e.g. r.post(path, requireUser(deps), handler). Never r.use("*", ...):
 * on a router mounted at "/" it would run for every route of the app.
 */
export function sharesRoutes(_deps: Deps) {
  const r = new Hono<AppEnv>();
  // TODO(shares): implement the routes above.
  return r;
}
