import { Hono } from "hono";
import {
  API,
  IdSchema,
  QUOTAS,
  RecipeIdSchema,
  RecipeInputSchema,
  StoryInputSchema,
  findOfficialRecipe,
  type Recipe,
  type RecipeDetailResponse,
  type RecipeListResponse,
  type Story,
} from "@thirty/shared";
import { optionalUser, requireUser } from "../auth";
import { enforceQuota } from "../db/rate";
import {
  communityToRecipe,
  createRecipe,
  createStory,
  deleteRecipeAndStories,
  deleteStoryItem,
  findStoryItem,
  getRecipeItem,
  getRecipeStats,
  isPublished,
  listRecipes,
  listStories,
  officialToRecipe,
  toStory,
} from "../db/recipes";
import { bumpStats } from "../db/stats";
import { notFound } from "../errors";
import { log } from "../log";
import type { Deps } from "../ports";
import { viewer, type AppContext, type AppEnv } from "../types";
import { readJson } from "../validate";

const RECIPE_NOT_FOUND = "レシピが見つかりませんでした";
const STORY_NOT_FOUND = "体験談が見つかりませんでした";

/** Path ids that do not match the format are simply "not found". */
function recipeIdParam(c: AppContext, name = "id"): string {
  const parsed = RecipeIdSchema.safeParse(c.req.param(name));
  if (!parsed.success) throw notFound(RECIPE_NOT_FOUND);
  return parsed.data;
}

/**
 * Community recipes and stories (FR-10, FR-11).
 *   GET    /api/recipes                          → RecipeListResponse (optionalUser)
 *   POST   /api/recipes                          RecipeInput → 201 { recipe }
 *   GET    /api/recipes/:id                      → RecipeDetailResponse (optionalUser)
 *   DELETE /api/recipes/:id                      → 204 (author)
 *   POST   /api/recipes/:id/stories              StoryInput → 201 { story }
 *   DELETE /api/recipes/:id/stories/:storyId     → 204 (author)
 *
 * Authored items carry gsi2 AUTHOR#<uid> so DELETE /api/me finds them (db/account.ts).
 */
export function recipesRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  const auth = requireUser(deps);
  const maybeUser = optionalUser(deps);

  /** A recipe visitors may see: official, or a published community one. */
  async function visibleRecipe(rid: string, viewerId: string | undefined): Promise<Recipe | undefined> {
    const official = findOfficialRecipe(rid);
    if (official) return officialToRecipe(official, await getRecipeStats(deps, rid));
    const item = await getRecipeItem(deps, rid);
    if (!item || !isPublished(item)) return undefined;
    return communityToRecipe(item, await getRecipeStats(deps, rid), viewerId);
  }

  r.get(API.recipes, maybeUser, async (c) => {
    const recipes = await listRecipes(deps, viewer(c)?.id);
    return c.json<RecipeListResponse>({ recipes });
  });

  r.post(API.recipes, auth, async (c) => {
    const input = await readJson(c, RecipeInputSchema);
    await enforceQuota(deps, "recipe", c.var.uid, QUOTAS.recipesPerUserPerDay, "day");
    const item = await createRecipe(deps, c.var.user, input);
    await bumpStats(deps, { communityRecipes: 1 });
    log.info("recipe created", { uid: c.var.uid, recipe: item.id });
    const recipe = communityToRecipe(item, { startCount: 0, storyCount: 0, featured: false }, c.var.uid);
    return c.json<{ recipe: Recipe }>({ recipe }, 201);
  });

  r.get(API.recipe(":id"), maybeUser, async (c) => {
    const rid = recipeIdParam(c);
    const viewerId = viewer(c)?.id;
    const [recipe, stories] = await Promise.all([visibleRecipe(rid, viewerId), listStories(deps, rid, viewerId)]);
    if (!recipe) throw notFound(RECIPE_NOT_FOUND);
    return c.json<RecipeDetailResponse>({ recipe, stories });
  });

  r.delete(API.recipe(":id"), auth, async (c) => {
    const rid = recipeIdParam(c);
    const item = await getRecipeItem(deps, rid);
    if (!item || item.userId !== c.var.uid) throw notFound(RECIPE_NOT_FOUND);
    await deleteRecipeAndStories(deps, rid);
    log.info("recipe deleted", { uid: c.var.uid, recipe: rid });
    return c.body(null, 204);
  });

  r.post(API.stories(":id"), auth, async (c) => {
    const rid = recipeIdParam(c);
    const input = await readJson(c, StoryInputSchema);
    if (!(await visibleRecipe(rid, c.var.uid))) throw notFound(RECIPE_NOT_FOUND);
    await enforceQuota(deps, "story", c.var.uid, QUOTAS.storiesPerUserPerDay, "day");
    const item = await createStory(deps, c.var.user, rid, input);
    await bumpStats(deps, { stories: 1 });
    log.info("story created", { uid: c.var.uid, recipe: rid });
    return c.json<{ story: Story }>({ story: toStory(item, c.var.uid) }, 201);
  });

  r.delete(API.story(":id", ":storyId"), auth, async (c) => {
    const rid = recipeIdParam(c);
    const sid = IdSchema.safeParse(c.req.param("storyId"));
    if (!sid.success) throw notFound(STORY_NOT_FOUND);
    const item = await findStoryItem(deps, rid, sid.data);
    if (!item || item.userId !== c.var.uid) throw notFound(STORY_NOT_FOUND);
    await deleteStoryItem(deps, item);
    log.info("story deleted", { uid: c.var.uid, recipe: rid });
    return c.body(null, 204);
  });

  return r;
}
