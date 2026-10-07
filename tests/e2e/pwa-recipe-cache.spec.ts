/**
 * The service worker must not keep showing a recipe the server no longer has (deleted by its
 * author, or hidden by moderation, FR-18). GET /api/recipes/:id is network-first; a 404 removes the
 * cached copy (apps/web/src/swRecipes.ts). E2E because only a real service worker shows it.
 */
import { API, type Recipe } from "@thirty/shared";
import { createSession, expect, test, uniqueNickname } from "./fixtures";

test.use({ serviceWorkers: "allow" });

test("a recipe deleted on the server is not served from the service worker's cache", async ({ page, request }) => {
  const author = await createSession(request, uniqueNickname("R"));
  const auth = { Authorization: `Bearer ${author.token}` };
  const created = await request.post(API.recipes, {
    headers: auth,
    data: { seal: "跳", title: "毎朝なわとび", category: "body", minutes: 5, place: "out", difficulty: 1, summary: "毎朝100回とぶ。", how: [], after: "" },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { recipe } = (await created.json()) as { recipe: Recipe };

  // First visit installs the worker; the next one goes through it and caches the recipe.
  await page.goto(`/recipes/${recipe.id}`);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { message: "the service worker controls the page" }).toBe(true);
  await page.goto(`/recipes/${recipe.id}`);
  await expect(page.getByRole("heading", { level: 1, name: "毎朝なわとび" })).toBeVisible();
  const cached = (id: string) =>
    page.evaluate(async (path) => {
      const names = await caches.keys();
      for (const name of names) if (await (await caches.open(name)).match(path)) return true;
      return false;
    }, API.recipe(id));
  await expect.poll(() => cached(recipe.id), { message: "the recipe is cached for offline use" }).toBe(true);

  const del = await request.delete(API.recipe(recipe.id), { headers: auth });
  expect(del.status()).toBe(204);

  for (let visit = 0; visit < 2; visit++) {
    await page.goto(`/recipes/${recipe.id}`);
    await expect(page.getByText("レシピが見つかりませんでした")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "毎朝なわとび" })).toHaveCount(0);
  }
  expect(await cached(recipe.id)).toBe(false);
});
