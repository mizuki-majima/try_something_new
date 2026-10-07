/**
 * CUF-1 step E (SPEC "Critical User Flow", "Error Handling"): while offline or while the API is
 * down, a stamp stays on screen with 「オフライン・あとで同期」 and is sent once the API is back.
 */
import type { Locator, Page } from "@playwright/test";
import { expect, getChallenges, syncStatus, test, uniqueNickname, waitForToken } from "./fixtures";

const TITLE = "毎日20分歩く";

/** Start 「毎日20分歩く」 today from its recipe page and wait until the server has it. */
async function startWalk(page: Page): Promise<{ token: string; card: Locator }> {
  await page.goto("/recipes/walk");
  await page.getByRole("button", { name: "これを30日やる" }).click();
  const sheet = page.getByRole("dialog", { name: "新しい30日" });
  await sheet.getByLabel("ニックネーム（任意）").fill(uniqueNickname("歩"));
  await sheet.getByRole("button", { name: "30日、始める" }).click();
  const card = page.getByRole("article", { name: TITLE });
  await expect(card.getByText("0/30日 押した", { exact: true })).toBeVisible();
  await expect(syncStatus(page)).toHaveText("同期済み");
  return { token: await waitForToken(page), card };
}

const firstCell = (card: Locator) => card.getByRole("group", { name: `「${TITLE}」の30日カード` }).getByRole("button", { name: /^1日目/ });

test("CUF-1 E: stamping offline keeps the stamp, shows 「オフライン・あとで同期」 and syncs when back online", async ({ page, context, request }) => {
  const { token, card } = await startWalk(page);

  await context.setOffline(true);
  await expect(page.getByRole("status").filter({ hasText: "オフラインです" })).toBeVisible();
  await expect(syncStatus(page)).toHaveText("オフライン・あとで同期");

  await card.getByRole("button", { name: "きょう（1日目）の分を押す" }).click();
  await expect(firstCell(card)).toHaveAttribute("aria-pressed", "true");
  await expect(card.getByText("1/30日 押した", { exact: true })).toBeVisible();
  await expect(syncStatus(page)).toHaveText("オフライン・あとで同期");
  await expect(syncStatus(page)).toHaveAttribute("title", /送信待ち 1件/);
  // Nothing reached the server yet.
  expect(Object.keys((await getChallenges(request, token))[0]!.stamps)).toEqual([]);

  await context.setOffline(false);
  await expect(syncStatus(page)).toHaveText("同期済み");
  await expect(page.getByRole("status").filter({ hasText: "オフラインです" })).toHaveCount(0);
  await expect.poll(async () => Object.keys((await getChallenges(request, token))[0]!.stamps)).toEqual(["1"]);
  await expect(firstCell(card)).toHaveAttribute("aria-pressed", "true");
});

test.describe("with the service worker", () => {
  test.use({ serviceWorkers: "allow" });

  test("FR-20: after one online visit, きょう and an official recipe open offline (PWA), and an offline stamp syncs later", async ({ page, context, request }) => {
    const { token, card } = await startWalk(page);
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { message: "the service worker controls the page" }).toBe(true);

    await context.setOffline(true);
    const reloaded = await page.reload();
    expect(reloaded?.fromServiceWorker()).toBe(true);
    await expect(page.getByRole("status").filter({ hasText: "オフラインです" })).toBeVisible();
    await expect(card.getByText("0/30日 押した", { exact: true })).toBeVisible();
    await card.getByRole("button", { name: "きょう（1日目）の分を押す" }).click();
    await expect(card.getByText("1/30日 押した", { exact: true })).toBeVisible();

    await page.goto("/recipes/photo");
    await expect(page.getByRole("heading", { level: 1, name: "毎日1枚、写真を撮る" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "やり方のコツ" })).toBeVisible();

    await context.setOffline(false);
    await expect(syncStatus(page)).toHaveText("同期済み");
    await expect.poll(async () => Object.keys((await getChallenges(request, token))[0]!.stamps)).toEqual(["1"]);
  });
});

test("CUF-1 E: stamping while the API answers 503 keeps the stamp and sends it when the API is back", async ({ page, request }) => {
  const { token, card } = await startWalk(page);

  // The API is down (5xx): the device still believes it is online.
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":{"code":"internal","message":"down"}}' }));
  await card.getByRole("button", { name: "きょう（1日目）の分を押す" }).click();
  await expect(firstCell(card)).toHaveAttribute("aria-pressed", "true");
  await expect(card.getByText("1/30日 押した", { exact: true })).toBeVisible();
  await expect(syncStatus(page)).toHaveText("オフライン・あとで同期");
  expect(Object.keys((await getChallenges(request, token))[0]!.stamps)).toEqual([]);

  // The API recovers: the queued stamp is re-sent on the next retry (backoff starts at 2 s).
  await page.unroute("**/api/**");
  await expect(syncStatus(page)).toHaveText("同期済み", { timeout: 15_000 });
  expect(Object.keys((await getChallenges(request, token))[0]!.stamps)).toEqual(["1"]);

  await page.reload();
  await expect(firstCell(card)).toHaveAttribute("aria-pressed", "true");
});
