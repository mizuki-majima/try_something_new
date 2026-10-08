/**
 * #20: the fonts changed (Klee One 600 only). The service worker caches them in "fonts-v2" and, when
 * it activates, deletes the old "fonts" cache, where participants' phones still hold the Dela Gothic
 * One and Zen Kaku Gothic New slices that no page asks for any more (apps/web/src/sw.ts,
 * lib/swCaches.ts). E2E because only a real service worker shows it.
 */
import { expect, test } from "./fixtures";

test.use({ serviceWorkers: "allow" });

test("the service worker deletes the pre-#20 font cache and caches Klee One in fonts-v2", async ({ page }) => {
  // Before the app (and its service worker) loads for the first time: the cache an older version left.
  await page.addInitScript(() => {
    if (sessionStorage.getItem("e2e.legacy-fonts")) return;
    sessionStorage.setItem("e2e.legacy-fonts", "1");
    void caches.open("fonts").then((c) => c.put("/assets/zen-kaku-gothic-new-japanese-400-normal-old.woff2", new Response("old", { headers: { "content-type": "font/woff2" } })));
  });

  await page.goto("/about");
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { message: "the service worker controls the page" }).toBe(true);
  await expect.poll(() => page.evaluate(() => caches.has("fonts")), { message: "the old font cache is deleted on activate" }).toBe(false);

  // Now through the worker: the handwritten headings' font files go into fonts-v2.
  await page.reload();
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const fontFiles = () =>
    page.evaluate(async () => {
      if (!(await caches.has("fonts-v2"))) return [];
      const keys = await (await caches.open("fonts-v2")).keys();
      return keys.map((r) => new URL(r.url).pathname);
    });
  await expect.poll(async () => (await fontFiles()).length, { message: "Klee One files are cached in fonts-v2" }).toBeGreaterThan(0);
  for (const file of await fontFiles()) expect(file).toMatch(/\/assets\/klee-one-[\w-]+-600-normal-[\w-]+\.woff2$/);
  expect(await page.evaluate(() => caches.has("fonts"))).toBe(false);
});
