/**
 * Smoke: every screen in SPEC "UI" loads at the project's viewport with no console errors and no
 * horizontal scrolling; unknown paths get the 404 page; /s/<unknown> is the server's HTML 404.
 */
import type { Page } from "@playwright/test";
import { expect, test, watchRequests } from "./fixtures";

type Route = { path: string; heading: string | RegExp };

const ROUTES: Route[] = [
  { path: "/", heading: /どうせ過ぎる\s*30日\s*なら/ },
  { path: "/recipes", heading: "チャレンジレシピ" },
  { path: "/recipes/photo", heading: "毎日1枚、写真を撮る" },
  { path: "/recipes/new", heading: "レシピを書く" },
  { path: "/gacha", heading: "次の30日ガチャ" },
  { path: "/together", heading: "みんなの30日" },
  { path: "/log", heading: "記録" },
  { path: "/settings", heading: "設定" },
  { path: "/about", heading: "「30日だけ」について" },
  { path: "/terms", heading: "利用規約" },
  { path: "/privacy", heading: "プライバシーポリシー" },
  { path: "/contact", heading: "お問い合わせ" },
  { path: "/admin", heading: "管理" },
  { path: "/no-such-page", heading: "ページが見つかりません" },
];

/** Console errors and uncaught exceptions for the whole test. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()} (${msg.location().url})`);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

/** Pixels the page can be scrolled sideways (0 = fits the viewport). */
async function horizontalOverflow(page: Page): Promise<number> {
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

for (const route of ROUTES) {
  test(`${route.path} loads without console errors or horizontal overflow`, async ({ page }) => {
    const errors = watchErrors(page);
    const settled = watchRequests(page);
    await page.goto(route.path);
    await expect(page.getByRole("main").getByRole("heading", { level: 1, name: route.heading })).toBeVisible();
    // Let the screen finish its requests (lists, counters) before measuring it.
    await settled();
    await expect(page.getByRole("main").getByRole("status").filter({ hasText: /読み込んでいます|確認しています/ })).toHaveCount(0);
    expect(await horizontalOverflow(page), "horizontal overflow in px").toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
}

test("/gacha: one roll shows a result, ひらめき提案 shows 3 ideas and the no-AI note", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/gacha");

  await page.getByRole("button", { name: "ガチャを回す" }).click();
  const result = page.getByTestId("gacha-result");
  await expect(result.getByRole("heading", { level: 2 })).toBeVisible();
  await expect(result.getByRole("button", { name: "これを30日やる" })).toBeVisible();
  await expect(page.getByRole("button", { name: "もう一回まわす" })).toBeEnabled();

  const ideas = page.getByRole("region", { name: "ひらめき提案（お試し）" });
  await expect(ideas.getByText("いまは AI を使わず、ルールで選んでいます")).toBeVisible();
  await ideas.getByRole("button", { name: "提案してもらう" }).click();
  await expect(ideas.getByTestId("suggestion")).toHaveCount(3);
  for (const idea of await ideas.getByTestId("suggestion").all()) {
    await expect(idea.getByRole("heading", { level: 3 })).not.toBeEmpty();
    await expect(idea.getByRole("button", { name: /^これを30日やる/ })).toBeVisible();
  }
  await expect(ideas.getByText(/今日はあと \d+ 回/)).toBeVisible();
  expect(await horizontalOverflow(page), "horizontal overflow in px").toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test("/s/<unknown> is the server-rendered HTML 404", async ({ page, request }) => {
  const res = await request.get("/s/zzzzzzzzzzzzzzzz");
  expect(res.status()).toBe(404);
  expect(res.headers()["content-type"]).toContain("text/html");
  expect(await res.text()).toContain("カードが見つかりません");

  const nav = await page.goto("/s/zzzzzzzzzzzzzzzz");
  expect(nav?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1, name: "カードが見つかりません" })).toBeVisible();
  await expect(page.getByRole("link", { name: "自分も30日やってみる" })).toHaveAttribute("href", "/");
  // FR-21 / D13: the Terms and the Privacy Policy are reachable from this page too.
  const footerNav = page.getByRole("contentinfo").getByRole("navigation", { name: "このサイトについて" });
  await expect(footerNav.getByRole("link", { name: "利用規約" })).toHaveAttribute("href", "/terms");
  await expect(footerNav.getByRole("link", { name: "プライバシーポリシー" })).toHaveAttribute("href", "/privacy");
  expect(await horizontalOverflow(page), "horizontal overflow in px").toBeLessThanOrEqual(0);
});
