/**
 * SPEC "Error Handling" 429 and CUF-1: a 429 that clears soon never loses a write, and the wait is
 * shown on screen (not only in the sync pill's tooltip, which phones never show).
 *
 * - R9 / r2-web-1: API Gateway's shared stage throttle answers {"message":"Too Many Requests"} with
 *   no Retry-After. A new challenge and the stamp pressed meanwhile stay queued and are sent.
 * - r2-web-6 / R7: creating the anonymous account is limited per network and overall; while the
 *   server asks us to wait, a band says so and when sending resumes.
 */
import type { Page, Route } from "@playwright/test";
import { API } from "@thirty/shared";
import { expect, getChallenges, syncStatus, test, uniqueNickname, waitForToken } from "./fixtures";

const TITLE = "毎日20分歩く";
const RATE_LIMIT_TOAST = /今日はここまで/;

const band = (page: Page) => page.getByTestId("throttle-band");

async function startWalk(page: Page): Promise<void> {
  await page.goto("/recipes/walk");
  await page.getByRole("button", { name: "これを30日やる" }).click();
  const sheet = page.getByRole("dialog", { name: "新しい30日" });
  await sheet.getByLabel("ニックネーム（任意）").fill(uniqueNickname("歩"));
  await sheet.getByRole("button", { name: "30日、始める" }).click();
}

test("R9: a throttle 429 (no Retry-After) on a new challenge keeps it and the stamp pressed meanwhile, and sends both", async ({ page, request }) => {
  // The first two creates are throttled the way API Gateway does it; then the API answers.
  let throttled = 0;
  let release!: () => void;
  const stamped = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**${API.challenges}`, async (route: Route) => {
    if (route.request().method() !== "POST" || throttled >= 2) return route.fallback();
    throttled++;
    if (throttled === 1) await stamped; // hold the first answer until the stamp is queued behind it
    await route.fulfill({ status: 429, contentType: "application/json", body: '{"message":"Too Many Requests"}' });
  });

  await startWalk(page);
  const card = page.getByRole("article", { name: TITLE });
  await card.getByRole("button", { name: "きょう（1日目）の分を押す" }).click();
  await expect(card.getByText("1/30日 押した", { exact: true })).toBeVisible();
  release();

  // Waiting, visibly — not rolled back, not 「今日はここまで」.
  await expect(band(page)).toContainText("混み合っています。");
  await expect(band(page)).toContainText("記録はこの端末に保存されています。");
  await expect(syncStatus(page)).toHaveText("送信待ち");
  await expect(card.getByText("1/30日 押した", { exact: true })).toBeVisible();

  // The backoff retries (2 s, then 4 s) get through: both writes reach the server.
  await expect(syncStatus(page)).toHaveText("同期済み", { timeout: 20_000 });
  await expect(band(page)).toHaveCount(0);
  expect(throttled).toBe(2);
  await expect(page.getByText(RATE_LIMIT_TOAST)).toHaveCount(0);
  const token = await waitForToken(page);
  const [challenge, ...others] = await getChallenges(request, token);
  expect(others).toHaveLength(0);
  expect(challenge!.title).toBe(TITLE);
  expect(Object.keys(challenge!.stamps)).toEqual(["1"]);
});

test("r2-web-6: a 429 on creating the account shows a band with the reason and when it resumes; the challenge stays and syncs later", async ({ page, context, request }) => {
  let refused = 0;
  await page.route(`**${API.session}`, async (route: Route) => {
    if (route.request().method() !== "POST" || refused >= 1) return route.fallback();
    refused++;
    await route.fulfill({
      status: 429,
      contentType: "application/json",
      headers: { "Retry-After": "1200" },
      body: JSON.stringify({ error: { code: "rate_limited", message: "短い時間に操作が集中しています。しばらくしてからもう一度お試しください" } }),
    });
  });

  await startWalk(page);
  const card = page.getByRole("article", { name: TITLE });
  await expect(card.getByText("0/30日 押した", { exact: true })).toBeVisible();
  await expect(band(page)).toHaveText("混み合っています。約20分後に自動で送ります。記録はこの端末に保存されています。");
  await expect(syncStatus(page)).toHaveText("送信待ち");

  // Coming back online sends at once (the user does not have to wait the 20 minutes).
  await context.setOffline(true);
  await context.setOffline(false);
  await expect(syncStatus(page)).toHaveText("同期済み");
  await expect(band(page)).toHaveCount(0);
  const token = await waitForToken(page);
  expect((await getChallenges(request, token)).map((c) => c.title)).toEqual([TITLE]);
});
