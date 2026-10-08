// The service worker's font cache after #20 (sw.ts, lib/swCaches.ts): Klee One 600 goes into a new,
// smaller cache, and the old "fonts" cache (Dela Gothic One / Zen Kaku Gothic New slices nothing
// loads any more) is deleted when the new worker activates. tests/e2e/pwa-font-cache.spec.ts checks
// the same with a real service worker.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  FONT_CACHE,
  FONT_CACHE_MAX_ENTRIES,
  LEGACY_CACHES,
  LEGACY_FONT_CACHE,
  LEGACY_RECIPE_CACHE,
  RECIPE_CACHES,
  deleteLegacyCaches,
} from "../src/lib/swCaches";

const repoRoot = path.resolve(__dirname, "../../..");
const swSource = readFileSync(path.resolve(__dirname, "../src/sw.ts"), "utf8");

describe("font cache", () => {
  it("is a new cache, not the pre-#20 one", () => {
    expect(FONT_CACHE).toBe("fonts-v2");
    expect(LEGACY_FONT_CACHE).toBe("fonts");
  });

  it("holds every Klee One 600 file, and is much smaller than the old 400 entries", () => {
    const css = readFileSync(path.join(repoRoot, "node_modules/@fontsource/klee-one/600.css"), "utf8");
    const faces = css.match(/@font-face/g)?.length ?? 0;
    expect(faces).toBe(124);
    expect(FONT_CACHE_MAX_ENTRIES).toBeGreaterThanOrEqual(faces);
    expect(FONT_CACHE_MAX_ENTRIES).toBe(160);
  });

  it("sw.ts caches fonts in FONT_CACHE with FONT_CACHE_MAX_ENTRIES and deletes the old caches on activate", () => {
    expect(swSource).toContain("cacheName: FONT_CACHE,");
    expect(swSource).toContain("maxEntries: FONT_CACHE_MAX_ENTRIES");
    expect(swSource).not.toMatch(/cacheName:\s*["']fonts["']/);
    const activate = swSource.slice(swSource.indexOf('addEventListener("activate"'));
    expect(activate).toContain("deleteLegacyCaches()");
    expect(activate).toContain("new CacheExpiration(LEGACY_FONT_CACHE");
  });
});

describe("deleteLegacyCaches", () => {
  it("deletes the old recipe cache and the old font cache, nothing in use", async () => {
    const deleted: string[] = [];
    await deleteLegacyCaches({ delete: async (name: string) => (deleted.push(name), true) });
    expect(deleted.sort()).toEqual([LEGACY_FONT_CACHE, LEGACY_RECIPE_CACHE].sort());
    expect(LEGACY_CACHES).not.toContain(FONT_CACHE);
    for (const inUse of RECIPE_CACHES.filter((c) => c !== LEGACY_RECIPE_CACHE)) expect(LEGACY_CACHES).not.toContain(inUse);
  });

  it("does not fail (activation must go on) when Cache Storage refuses", async () => {
    const del = vi.fn(async () => {
      throw new Error("SecurityError");
    });
    await expect(deleteLegacyCaches({ delete: del })).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledTimes(LEGACY_CACHES.length);
  });
});
