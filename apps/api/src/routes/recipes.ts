import { Hono } from "hono";
import type { Deps } from "../ports";
import type { AppEnv } from "../types";

/**
 * Community recipes and stories (FR-10, FR-11).
 *   GET    /api/recipes                          → RecipeListResponse (optionalUser)
 *   POST   /api/recipes                          RecipeInput → { recipe }
 *   GET    /api/recipes/:id                      → RecipeDetailResponse (optionalUser)
 *   DELETE /api/recipes/:id                      → 204 (author)
 *   POST   /api/recipes/:id/stories              StoryInput → { story }
 *   DELETE /api/recipes/:id/stories/:storyId     → 204 (author)
 *
 * Authored items carry gsi2 AUTHOR#<uid> so DELETE /api/me finds them (db/account.ts).
 *
 * Mounted at "/" by app.ts: register absolute paths (API in @thirty/shared has them).
 * Attach middleware per route, e.g. r.post(path, requireUser(deps), handler). Never r.use("*", ...):
 * on a router mounted at "/" it would run for every route of the app.
 */
export function recipesRoutes(_deps: Deps) {
  const r = new Hono<AppEnv>();
  // TODO(recipes): implement the routes above.
  return r;
}
