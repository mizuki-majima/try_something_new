/**
 * Cache Storage names the service worker (sw.ts, swRecipes.ts) uses for API responses and fonts, and
 * a way for the page to forget the API ones. Recipe responses carry per-account fields (isMine) and may show a
 * recipe that was deleted or hidden since, so they are dropped whenever the account on this device
 * is deleted, replaced or restored.
 */
export const RECIPE_DETAIL_CACHE = "api-recipe-detail";
export const RECIPE_LIST_CACHE = "api-recipe-list";
/** Older service worker versions kept list and detail together in this cache. */
export const LEGACY_RECIPE_CACHE = "api-recipes";

export const RECIPE_CACHES: readonly string[] = [RECIPE_DETAIL_CACHE, RECIPE_LIST_CACHE, LEGACY_RECIPE_CACHE];

/** Self-hosted fonts (sw.ts, cache-first). Since #20: Klee One 600 only, 124 files (@font-face rules). */
export const FONT_CACHE = "fonts-v2";
/** Room for every Klee One 600 file with some to spare; least recently used ones go first. */
export const FONT_CACHE_MAX_ENTRIES = 160;
/**
 * Before #20 fonts were cached here: slices of the old display and body fonts that no page asks for
 * any more (up to 400 files). The service worker deletes it when it activates.
 */
export const LEGACY_FONT_CACHE = "fonts";

/** Caches no version of the app uses any more (deleted by the service worker on activate). */
export const LEGACY_CACHES: readonly string[] = [LEGACY_RECIPE_CACHE, LEGACY_FONT_CACHE];

/** Delete LEGACY_CACHES. Best effort: a failure leaves a cache behind, never fails activation. */
export async function deleteLegacyCaches(storage: Pick<CacheStorage, "delete"> = caches): Promise<void> {
  await Promise.all(LEGACY_CACHES.map((name) => storage.delete(name).catch(() => false)));
}

/** Best effort: Cache Storage may be missing (old browsers, plain http, tests) or refuse. */
export async function clearRecipeCaches(): Promise<void> {
  const storage = typeof caches !== "undefined" ? caches : undefined;
  if (!storage) return;
  await Promise.all(RECIPE_CACHES.map((name) => storage.delete(name).catch(() => false)));
}
