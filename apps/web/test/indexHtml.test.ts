import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PUBLIC_ORIGIN_PLACEHOLDER, applyPublicOrigin, normalizeOrigin, publicOrigin } from "../vite.config";

const webRoot = path.resolve(__dirname, "..");
const indexHtml = readFileSync(path.join(webRoot, "index.html"), "utf8");
const jitlessJs = readFileSync(path.join(webRoot, "public/zod-jitless.js"), "utf8");

const meta = (html: string, attr: string) => new RegExp(`<meta ${attr} content="([^"]*)"`).exec(html)?.[1];

describe("index.html: absolute og:image / twitter:image (PUBLIC_ORIGIN)", () => {
  it("uses the build's public origin for the share images", () => {
    const html = applyPublicOrigin(indexHtml, normalizeOrigin("https://d1zw3n37kpuo7t.cloudfront.net/"));
    expect(meta(html, 'property="og:image"')).toBe("https://d1zw3n37kpuo7t.cloudfront.net/og-default.png");
    expect(meta(html, 'name="twitter:image"')).toBe("https://d1zw3n37kpuo7t.cloudfront.net/og-default.png");
    expect(html).not.toContain(PUBLIC_ORIGIN_PLACEHOLDER);
  });

  it("stays relative when PUBLIC_ORIGIN is not set (local dev, E2E)", () => {
    const html = applyPublicOrigin(indexHtml, normalizeOrigin(undefined));
    expect(meta(html, 'property="og:image"')).toBe("/og-default.png");
    expect(meta(html, 'name="twitter:image"')).toBe("/og-default.png");
  });

  it("refuses anything that is not an origin", () => {
    expect(normalizeOrigin("  ")).toBe("");
    expect(normalizeOrigin("http://127.0.0.1:4173")).toBe("http://127.0.0.1:4173");
    for (const bad of ["d1zw3n37kpuo7t.cloudfront.net", "https://example.com/app", "ftp://example.com", "https://example.com/?a=1"]) {
      expect(() => normalizeOrigin(bad)).toThrow(/PUBLIC_ORIGIN/);
    }
  });

  it("the Vite plugin rewrites index.html before Vite's own HTML processing", () => {
    const plugin = publicOrigin("https://example.com");
    const hook = plugin.transformIndexHtml as { order: string; handler: (html: string) => string };
    expect(hook.order).toBe("pre");
    expect(meta(hook.handler(indexHtml), 'property="og:image"')).toBe("https://example.com/og-default.png");
  });
});

describe("index.html: zod jitless before the app (CSP without 'unsafe-eval')", () => {
  afterEach(() => {
    delete (globalThis as { __zod_globalConfig?: unknown }).__zod_globalConfig;
  });

  it("loads /zod-jitless.js as a deferred classic script ahead of every module script", () => {
    const jitless = indexHtml.indexOf('<script src="/zod-jitless.js" defer></script>');
    const firstModule = indexHtml.indexOf('<script type="module"');
    expect(jitless).toBeGreaterThan(-1);
    expect(firstModule).toBeGreaterThan(jitless);
    // Vite appends the built entry (a module script) to <head>: the jitless script is the first script there.
    expect(indexHtml.slice(0, jitless)).not.toContain("<script");
  });

  it("sets zod's global jitless flag, keeping a config zod may already have", () => {
    (globalThis as { __zod_globalConfig?: Record<string, unknown> }).__zod_globalConfig = { locale: "ja" };
    new Function(jitlessJs)();
    expect((globalThis as { __zod_globalConfig?: Record<string, unknown> }).__zod_globalConfig).toEqual({ locale: "ja", jitless: true });

    delete (globalThis as { __zod_globalConfig?: unknown }).__zod_globalConfig;
    new Function(jitlessJs)();
    expect((globalThis as { __zod_globalConfig?: Record<string, unknown> }).__zod_globalConfig).toEqual({ jitless: true });
  });
});
