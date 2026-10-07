/**
 * Cache Storage names the service worker (sw.ts, swRecipes.ts) uses for API responses, and a way
 * for the page to forget them. Recipe responses carry per-account fields (isMine) and may show a
 * recipe that was deleted or hidden since, so they are dropped whenever the account on this device
 * is deleted, replaced or restored.
 */
export const RECIPE_DETAIL_CACHE = "api-recipe-detail";
export const RECIPE_LIST_CACHE = "api-recipe-list";
/** Older service worker versions kept list and detail together in this cache. */
export const LEGACY_RECIPE_CACHE = "api-recipes";

export const RECIPE_CACHES: readonly string[] = [RECIPE_DETAIL_CACHE, RECIPE_LIST_CACHE, LEGACY_RECIPE_CACHE];

/** Best effort: Cache Storage may be missing (old browsers, plain http, tests) or refuse. */
export async function clearRecipeCaches(): Promise<void> {
  const storage = typeof caches !== "undefined" ? caches : undefined;
  if (!storage) return;
  await Promise.all(RECIPE_CACHES.map((name) => storage.delete(name).catch(() => false)));
}
