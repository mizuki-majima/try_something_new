/**
 * SPEC "Non-functional Requirements" (accessibility) and docs/design.md: tap targets are at least
 * 44px. Measured at 360px, the narrowest phone we support: the 30 cells (the stamp toggles on きょう
 * and the challenge page) and every chip (genre, sort, gacha conditions, theme).
 */
import type { Locator, Page } from "@playwright/test";
import { expect, test, uniqueNickname } from "./fixtures";

test.use({ viewport: { width: 360, height: 740 } });

const MIN = 44;

/** Width × height of every visible match, rounded to 0.1px. */
async function sizes(locator: Locator): Promise<{ label: string; w: number; h: number }[]> {
  return locator.evaluateAll((els) =>
    els
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { label: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 20), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
      }),
  );
}

async function expectTappable(page: Page, selector: string, where: string): Promise<void> {
  const found = await sizes(page.locator(selector));
  expect(found.length, `${selector} on ${where}`).toBeGreaterThan(0);
  const small = found.filter((s) => s.w < MIN || s.h < MIN);
  expect(small, `${selector} smaller than ${MIN}px on ${where}`).toEqual([]);
}

test("chips are at least 44px on /recipes, /gacha and /settings", async ({ page }) => {
  for (const path of ["/recipes", "/gacha", "/settings"]) {
    await page.goto(path);
    await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
    await expectTappable(page, "main .chip", path);
  }
});

test("the 30 cells are at least 44px on きょう and on the challenge page", async ({ page }) => {
  await page.goto("/recipes/photo");
  await page.getByRole("button", { name: "これを30日やる" }).click();
  const sheet = page.getByRole("dialog", { name: "新しい30日" });
  await sheet.getByLabel("ニックネーム（任意）").fill(uniqueNickname("T"));
  await sheet.getByRole("button", { name: "30日、始める" }).click();
  const card = page.getByRole("article", { name: "毎日1枚、写真を撮る" });
  await expect(card.getByText("0/30日 押した", { exact: true })).toBeVisible();

  await expectTappable(page, "main button.cell", "/");
  expect(await page.locator("main button.cell").count()).toBe(30);

  await card.getByRole("link", { name: "詳細・メモ" }).click();
  await expect(page).toHaveURL(/\/c\/[0-9a-z]+$/);
  // The challenge page's own title (h1), so the cells measured are not the outgoing page's.
  await expect(page.getByRole("heading", { level: 1, name: "毎日1枚、写真を撮る" })).toBeVisible();
  await expect(page.locator("main button.cell")).toHaveCount(30);
  await expectTappable(page, "main button.cell", "/c/:id");
});
