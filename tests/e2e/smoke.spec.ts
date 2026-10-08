/**
 * Smoke: every screen in SPEC "UI" loads at the project's viewport with no console errors, no
 * horizontal scrolling and no handwriting below 17px (#20); unknown paths get the 404 page;
 * /s/<unknown> is the server's HTML 404.
 */
import type { Page } from "@playwright/test";
import {
  addDays,
  createChallenge,
  createSession,
  expect,
  importChallenges,
  menuLink,
  pastChallenge,
  syncStatus,
  test,
  today,
  uniqueNickname,
  useToken,
  watchRequests,
} from "./fixtures";

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

/**
 * Visible text set in the handwriting font (Klee One) below 17px. docs/design.md: handwriting only at
 * 17px and up; seal characters (in their rings, any size) are the one exception.
 */
async function smallHandwriting(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      const el = node.parentElement;
      if (!text || !el || el.closest('.seal, .st, [class*="seal"], .sr-only') || !el.checkVisibility()) continue;
      const style = getComputedStyle(el);
      const size = parseFloat(style.fontSize);
      if (style.fontFamily.replace(/["']/g, "").startsWith("Klee One") && size < 17) out.push(`<${el.tagName.toLowerCase()} class="${el.className}"> ${size}px 「${text.slice(0, 16)}」`);
    }
    return out;
  });
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
    expect(await smallHandwriting(page), "handwriting below 17px").toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("with an account (cards, notes, every 設定 section): no handwriting below 17px except seals (#20)", async ({ page, request }) => {
  const nickname = uniqueNickname("K");
  const { token } = await createSession(request, nickname);
  const active = await createChallenge(request, token, { recipeId: "photo", title: "毎日1枚、写真を撮る", seal: "写", startDate: addDays(today(), -5) });
  const done = pastChallenge({ title: "寝る前に日記を書く", seal: "記", recipeId: null, startDate: addDays(today(), -60), stampedDays: [1, 2, 3, 5, 8] });
  done.stamps["3"] = { ...done.stamps["3"]!, note: "少しずつ慣れてきた" };
  const ended = pastChallenge({ title: "朝に白湯を飲む", seal: "湯", recipeId: null, startDate: addDays(today(), -30), stampedDays: [1, 2, 4] });
  await importChallenges(request, token, nickname, [{ ...done, status: "done", verdict: "continue", reflection: "続ける", finishedAt: done.updatedAt, finishedDay: 30 }, ended]);
  await useToken(page, token);
  for (const path of ["/", `/c/${active.id}`, `/c/${done.id}`, `/c/${ended.id}/reflect`, "/log", "/settings", "/together"]) {
    const settled = watchRequests(page);
    await page.goto(path);
    await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
    await settled();
    expect(await smallHandwriting(page), `handwriting below 17px on ${path}`).toEqual([]);
  }
});

test("the menu has four tabs: きょう / えらぶ / みんな / 記録 (#20)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
  // Only one menu is displayed (the tab bar on phones, the top nav on desktop).
  const menu = page.getByRole("navigation", { name: "メニュー" });
  await expect(menu.getByRole("link")).toHaveText(["きょう", "えらぶ", "みんな", "記録"]);
  for (const [name, href] of [
    ["きょう", "/"],
    ["えらぶ", "/recipes"],
    ["みんな", "/together"],
    ["記録", "/log"],
  ]) {
    await expect(menu.getByRole("link", { name, exact: true })).toHaveAttribute("href", href!);
  }
  await expect(menu.getByRole("link", { name: "きょう", exact: true })).toHaveAttribute("aria-current", "page");

  // えらぶ is current on both of its pages; on ガチャ it links to /gacha itself (a tap keeps the page).
  await page.goto("/gacha");
  await expect(page.getByRole("main").getByRole("heading", { level: 1, name: "次の30日ガチャ" })).toBeVisible();
  await expect(menu.getByRole("link", { name: "えらぶ", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(menu.getByRole("link", { name: "えらぶ", exact: true })).toHaveAttribute("href", "/gacha");
});

test.describe("at 360px", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("offline, with the longest sync text, the header fits: no sideways scroll and 「設定」 fully on screen (#20)", async ({ page, context, request }) => {
    const { token } = await createSession(request, uniqueNickname("H"));
    await useToken(page, token);
    await page.goto("/");
    await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
    await context.setOffline(true);
    await expect(page.getByRole("status").filter({ hasText: "オフラインです" })).toBeVisible();
    await expect(syncStatus(page)).toHaveText("オフライン・あとで同期");

    const settings = page.getByRole("link", { name: "設定", exact: true });
    await expect(settings).toBeVisible();
    const box = (await settings.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    expect(await horizontalOverflow(page), "horizontal overflow in px").toBeLessThanOrEqual(0);
    await context.setOffline(false);
  });
});

test.describe("a manual 「ダーク」 on a phone in light mode (#20)", () => {
  test.use({ colorScheme: "light" });

  test("is on <html> before the app's scripts run (/theme-boot.js): no paper-white first frame", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("thirty-days.theme", "dark");
      // "interactive" comes after the whole document is parsed, before any deferred or module script.
      document.addEventListener("readystatechange", () => {
        if (document.readyState !== "interactive") return;
        const metas = [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute("content"));
        (window as unknown as { __boot: unknown }).__boot = { theme: document.documentElement.dataset.theme ?? null, metas };
      });
    });
    await page.goto("/");
    await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __boot: unknown }).__boot)).toEqual({ theme: "dark", metas: ["#1c1b19", "#1c1b19"] });
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(28, 27, 25)");
  });
});

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

  // Tapping the current tab えらぶ stays on ガチャ and keeps the roll and the ideas (#20).
  const title = await result.getByRole("heading", { level: 2 }).textContent();
  await menuLink(page, "えらぶ").click();
  await expect(page).toHaveURL(/\/gacha$/);
  await expect(result.getByRole("heading", { level: 2 })).toHaveText(title!);
  await expect(ideas.getByTestId("suggestion")).toHaveCount(3);
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
