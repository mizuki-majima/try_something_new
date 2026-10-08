/**
 * SPEC "Non-functional Requirements" (accessibility) and docs/design.md: tap targets are at least
 * 44px. Measured at 360px, the narrowest phone we support: the 30 cells (the stamp toggles on きょう
 * and the challenge page), every chip (genre, sort, gacha conditions, theme) and the notice band's
 * close button (#17), which must also leave the page below it and fit the width.
 */
import type { Locator, Page } from "@playwright/test";
import { EFFECTIVE, REVISED_ON } from "../../apps/web/src/lib/legal";
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

test("the notice band (#17) fits a 360px phone: in the page flow, no sideways scroll, a 44px close button", async ({ page }) => {
  // The band shows only until 14 days after the effective date: pin the browser's date to the revision.
  await page.clock.setFixedTime(new Date(`${REVISED_ON}T12:00:00+09:00`));
  await page.goto("/");
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
  const band = page.getByRole("region", { name: "お知らせ" });
  await expect(band).toContainText(`${EFFECTIVE}以降、ひとことメモを日ごとに選んで「みんな」に見せられるようになります。`);
  await expectTappable(page, "[data-testid=notice-band] button", "/");

  // Not over the page: in the flow under the header, and the page starts below it.
  expect(await band.evaluate((el) => getComputedStyle(el).position)).toBe("static");
  const bandBox = (await band.boundingBox())!;
  const mainBox = (await page.getByRole("main").boundingBox())!;
  expect(mainBox.y).toBeGreaterThanOrEqual(bandBox.y + bandBox.height - 0.5);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

  await band.getByRole("button", { name: "お知らせを閉じる" }).click();
  await expect(band).toHaveCount(0);
  await expect(page.getByRole("main")).toBeFocused();
  await page.reload();
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
  await expect(band).toHaveCount(0);
});
