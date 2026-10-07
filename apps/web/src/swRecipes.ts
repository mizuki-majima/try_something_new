/**
 * Service worker caching for the recipe API (sw.ts), kept apart so it can be unit-tested.
 *
 * - GET /api/recipes/:id → network first (3 s timeout), the cache only as the offline / slow-network
 *   fallback. A recipe can be deleted by its author or hidden by moderation (FR-18) at any time,
 *   so a cached copy must never stand in for a live answer.
 * - GET /api/recipes → stale-while-revalidate, entries older than a day are not used; a request
 *   made with cache "no-cache" / "reload" / "no-store" (right after posting) goes to the network
 *   first.
 * - A 404 / 410 from the network removes the cached copy, so it is not served offline later
 *   either. Only 200s are cached.
 */
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import type { WorkboxPlugin } from "workbox-core";
import { ExpirationPlugin } from "workbox-expiration";
import { NetworkFirst, StaleWhileRevalidate, type Strategy } from "workbox-strategies";
import { RECIPE_DETAIL_CACHE, RECIPE_LIST_CACHE } from "./lib/swCaches";

export const RECIPE_LIST_PATH = /^\/api\/recipes$/;
export const RECIPE_DETAIL_PATH = /^\/api\/recipes\/[0-9a-z][0-9a-z-]*$/;

export const DETAIL_NETWORK_TIMEOUT_SECONDS = 3;
export const LIST_MAX_AGE_SECONDS = 24 * 60 * 60;
const DETAIL_MAX_AGE_SECONDS = 14 * 24 * 60 * 60;
const FRESH_NETWORK_TIMEOUT_SECONDS = 6;

const GONE = new Set([404, 410]);

/** Drop the cached copy of a request the server says is gone (and never cache the 404 itself). */
export function forgetGonePlugin(cacheName: string, storage: () => CacheStorage | undefined = () => globalThis.caches): WorkboxPlugin {
  return {
    fetchDidSucceed: async ({ request, response }) => {
      if (GONE.has(response.status)) {
        try {
          const cache = await storage()?.open(cacheName);
          await cache?.delete(request);
        } catch {
          // Cache Storage refused: the response itself is still right.
        }
      }
      return response;
    },
  };
}

const freshMode = (mode: RequestCache) => mode === "no-cache" || mode === "reload" || mode === "no-store";

export type RecipeStrategies = {
  detail: NetworkFirst;
  list: StaleWhileRevalidate;
  listFresh: NetworkFirst;
  /** The strategy for a same-origin GET, or null when it is not a recipe route. */
  pick(pathname: string, mode: RequestCache): Strategy | null;
};

export function createRecipeStrategies(storage?: () => CacheStorage | undefined): RecipeStrategies {
  const detail = new NetworkFirst({
    cacheName: RECIPE_DETAIL_CACHE,
    networkTimeoutSeconds: DETAIL_NETWORK_TIMEOUT_SECONDS,
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({ maxEntries: 80, maxAgeSeconds: DETAIL_MAX_AGE_SECONDS }),
      forgetGonePlugin(RECIPE_DETAIL_CACHE, storage),
    ],
  });
  // One set of plugins for both list strategies: they share the cache and its expiration.
  const listPlugins = [
    new CacheableResponsePlugin({ statuses: [200] }),
    new ExpirationPlugin({ maxEntries: 20, maxAgeSeconds: LIST_MAX_AGE_SECONDS }),
    forgetGonePlugin(RECIPE_LIST_CACHE, storage),
  ];
  const list = new StaleWhileRevalidate({ cacheName: RECIPE_LIST_CACHE, plugins: listPlugins });
  const listFresh = new NetworkFirst({ cacheName: RECIPE_LIST_CACHE, networkTimeoutSeconds: FRESH_NETWORK_TIMEOUT_SECONDS, plugins: listPlugins });

  return {
    detail,
    list,
    listFresh,
    pick(pathname, mode) {
      if (RECIPE_DETAIL_PATH.test(pathname)) return detail;
      if (RECIPE_LIST_PATH.test(pathname)) return freshMode(mode) ? listFresh : list;
      return null;
    },
  };
}
