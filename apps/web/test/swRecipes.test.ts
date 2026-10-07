import { describe, expect, it, vi } from "vitest";
import { ExpirationPlugin } from "workbox-expiration";
import { NetworkFirst, StaleWhileRevalidate } from "workbox-strategies";
import { RECIPE_CACHES, RECIPE_DETAIL_CACHE, RECIPE_LIST_CACHE, clearRecipeCaches } from "../src/lib/swCaches";
import { createRecipeStrategies, forgetGonePlugin } from "../src/swRecipes";

/** Workbox keeps these private; the test reads them to pin the configuration. */
const timeoutOf = (s: unknown) => (s as { _networkTimeoutSeconds?: number })._networkTimeoutSeconds;
const maxAgeOf = (s: { plugins: unknown[] }) =>
  (s.plugins.find((p) => p instanceof ExpirationPlugin) as unknown as { _config: { maxAgeSeconds?: number } } | undefined)?._config.maxAgeSeconds;

function fakeStorage() {
  const deleted: string[] = [];
  const cache = { delete: vi.fn(async (req: Request) => (deleted.push(req.url), true)) };
  const storage = { open: vi.fn(async () => cache) } as unknown as CacheStorage;
  return { storage, deleted, open: storage.open as unknown as ReturnType<typeof vi.fn> };
}

describe("recipe caching in the service worker", () => {
  it("fetches a recipe network-first (3 s), the cache only as a fallback", () => {
    const s = createRecipeStrategies();
    const detail = s.pick("/api/recipes/c0000000000001", "default");
    expect(detail).toBe(s.detail);
    expect(detail).toBeInstanceOf(NetworkFirst);
    expect(detail!.cacheName).toBe(RECIPE_DETAIL_CACHE);
    expect(timeoutOf(detail)).toBe(3);
    // Even a plain visit never gets a stale copy first (that was StaleWhileRevalidate).
    expect(s.pick("/api/recipes/photo", "default")).not.toBeInstanceOf(StaleWhileRevalidate);
  });

  it("serves the list stale-while-revalidate for at most a day, network-first right after a write", () => {
    const s = createRecipeStrategies();
    const list = s.pick("/api/recipes", "default");
    expect(list).toBeInstanceOf(StaleWhileRevalidate);
    expect(list!.cacheName).toBe(RECIPE_LIST_CACHE);
    expect(maxAgeOf(list!)).toBe(24 * 60 * 60);
    for (const mode of ["no-cache", "reload", "no-store"] as const) expect(s.pick("/api/recipes", mode)).toBe(s.listFresh);
    expect(s.listFresh.cacheName).toBe(RECIPE_LIST_CACHE);
  });

  it("leaves other routes alone", () => {
    const s = createRecipeStrategies();
    for (const path of ["/api/recipes/photo/stories", "/api/challenges", "/api/recipesx", "/recipes/photo"]) {
      expect(s.pick(path, "default")).toBeNull();
    }
  });

  it("forgets the cached copy when the network says 404 or 410, and passes the response through", async () => {
    for (const status of [404, 410]) {
      const { storage, deleted } = fakeStorage();
      const plugin = forgetGonePlugin(RECIPE_DETAIL_CACHE, () => storage);
      const request = new Request("http://localhost/api/recipes/c0000000000001");
      const response = new Response("{}", { status });
      const out = await plugin.fetchDidSucceed!({ request, response, event: {} as ExtendableEvent });
      expect(out).toBe(response);
      expect(storage.open).toHaveBeenCalledWith(RECIPE_DETAIL_CACHE);
      expect(deleted).toEqual([request.url]);
    }
  });

  it("keeps the cache for other answers and survives a broken Cache Storage", async () => {
    const { storage, open } = fakeStorage();
    const plugin = forgetGonePlugin(RECIPE_DETAIL_CACHE, () => storage);
    const ok = new Response("{}", { status: 200 });
    expect(await plugin.fetchDidSucceed!({ request: new Request("http://localhost/api/recipes/a1"), response: ok, event: {} as ExtendableEvent })).toBe(ok);
    expect(open).not.toHaveBeenCalled();

    const broken = { open: vi.fn(async () => Promise.reject(new Error("SecurityError"))) } as unknown as CacheStorage;
    const gone = new Response("{}", { status: 404 });
    const out = await forgetGonePlugin(RECIPE_DETAIL_CACHE, () => broken).fetchDidSucceed!({
      request: new Request("http://localhost/api/recipes/a1"),
      response: gone,
      event: {} as ExtendableEvent,
    });
    expect(out).toBe(gone);
  });

  it("clearRecipeCaches deletes every recipe cache, old ones included, and tolerates no Cache Storage", async () => {
    const del = vi.fn(async (_name: string) => true);
    vi.stubGlobal("caches", { delete: del });
    await clearRecipeCaches();
    expect(del.mock.calls.map(([name]) => name)).toEqual([...RECIPE_CACHES]);
    expect(RECIPE_CACHES).toContain("api-recipes");
    vi.unstubAllGlobals();

    vi.stubGlobal("caches", undefined);
    await expect(clearRecipeCaches()).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });
});
