/**
 * Keyboard focus stays visible (#20, SPEC "Non-functional Requirements" accessibility, docs/design.md
 * "フォーカス"): the ring must not be replaced by a selected state's own outline, and it must not be
 * colour alone. Checked on the elements where that went wrong: the selected day cell on /c/:id, text
 * fields, and the selected chip and today's cell under forced colours (Windows high contrast).
 */
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { addDays, createChallenge, createSession, expect, test, today, uniqueNickname, useToken } from "./fixtures";

type Ring = { style: string; width: string; offset: string; shadow: string };

const ring = (el: Locator): Promise<Ring> =>
  el.evaluate((e) => {
    const s = getComputedStyle(e);
    return { style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset, shadow: s.boxShadow };
  });

const isFocused = (el: Locator) => el.evaluate((e) => e === document.activeElement && e.matches(":focus-visible"));

/** A challenge on its 6th day, opened on /c/:id: today's cell is the selected one. */
async function openDaySix(page: Page, request: APIRequestContext): Promise<Locator> {
  const { token } = await createSession(request, uniqueNickname("F"));
  const c = await createChallenge(request, token, { recipeId: "photo", title: "毎日1枚、写真を撮る", seal: "写", startDate: addDays(today(), -5) });
  await useToken(page, token);
  await page.goto(`/c/${c.id}`);
  await expect(page.getByRole("heading", { level: 1, name: "毎日1枚、写真を撮る" })).toBeVisible();
  const cell = page.getByRole("main").getByRole("button", { name: "6日目", exact: true });
  await expect(cell).toHaveAttribute("aria-current", "date");
  await expect(cell).toHaveClass(/\bselected\b/);
  return cell;
}

/** Tab onto today's cell from day 5, measure, Tab away, measure the same cell again. */
async function focusedAndNot(page: Page, cell: Locator): Promise<{ focused: Ring; unfocused: Ring }> {
  await page.getByRole("main").getByRole("button", { name: "5日目", exact: true }).focus();
  await page.keyboard.press("Tab");
  expect(await isFocused(cell), "Tab from 5日目 lands on 6日目 (today, selected)").toBe(true);
  const focused = await ring(cell);
  await page.keyboard.press("Tab");
  expect(await isFocused(cell)).toBe(false);
  return { focused, unfocused: await ring(cell) };
}

test("the selected day cell shows the focus ring outside it, and its selection ring inside (#20)", async ({ page, request }) => {
  const cell = await openDaySix(page, request);
  const { focused, unfocused } = await focusedAndNot(page, cell);
  expect(unfocused.style).toBe("none");
  expect(unfocused.shadow).toContain("inset");
  expect(focused).toMatchObject({ style: "solid", width: "2px", offset: "2px" });
  // The selection (an inset ring) stays while focused.
  expect(focused.shadow).toBe(unfocused.shadow);
});

for (const [colorScheme, contrast] of [
  ["light", "no-preference"],
  ["dark", "no-preference"],
  ["light", "more"],
  ["dark", "more"],
] as const) {
  test(`a focused text field shows the 2px focus ring, not only a colour change (${colorScheme}, contrast ${contrast}) (#20)`, async ({ page }) => {
    await page.emulateMedia({ colorScheme, contrast });
    await page.goto("/recipes/new");
    const field = page.getByLabel("タイトル");
    const before = await ring(field);
    await field.focus();
    const after = await ring(field);
    expect(before.style).toBe("none");
    expect(after).toMatchObject({ style: "solid", width: "2px", offset: "2px" });
  });
}

test.describe("forced colours (Windows high contrast)", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
  });

  test("the selected chip shows a different, thicker ring when it has keyboard focus (#20)", async ({ page }) => {
    await page.goto("/gacha");
    const group = page.getByRole("main").getByRole("radiogroup").first();
    const chip = group.getByRole("radio", { checked: true });
    const name = (await chip.textContent())!;
    const unfocused = await ring(chip);
    expect(unfocused).toMatchObject({ style: "solid", width: "2px", offset: "1px" });
    // Arrow keys move focus and the choice together (roving tab stop); come back to the same chip.
    await chip.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    const back = group.getByRole("radio", { name, exact: true });
    await expect(back).toHaveAttribute("aria-checked", "true");
    expect(await isFocused(back)).toBe(true);
    expect(await ring(back)).toMatchObject({ style: "solid", width: "3px", offset: "3px" });
  });

  test("today's cell (selected) shows a different, thicker ring when it has keyboard focus (#20)", async ({ page, request }) => {
    const cell = await openDaySix(page, request);
    const { focused, unfocused } = await focusedAndNot(page, cell);
    expect(unfocused).toMatchObject({ style: "solid", width: "2px", offset: "1px" });
    expect(focused).toMatchObject({ style: "solid", width: "3px", offset: "3px" });
  });
});
