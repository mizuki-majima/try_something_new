/**
 * CUF-1 steps 1–5 (SPEC "Critical User Flow"): first visit → recipe → start → stamp day 1 →
 * reload, and the stamp is on the server. The day's ひとこと stays private (#17: shown only by choice).
 */
import { expect, getChallenges, getCohort, getMe, getMemberNotes, syncStatus, test, thisMonth, uniqueNickname, waitForToken } from "./fixtures";

const TITLE = "毎日1枚、写真を撮る";
const NOTE = "朝の光がきれいだった";

test("CUF-1: start 「毎日1枚、写真を撮る」 from the recipe and stamp day 1", async ({ page, request }) => {
  const nickname = uniqueNickname("写");

  // 1. First visit: the hero and 「レシピから選ぶ」.
  await page.goto("/");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1, name: /どうせ過ぎる\s*30日\s*なら/ })).toBeVisible();
  const fromRecipes = main.getByRole("link", { name: "レシピから選ぶ" });
  await expect(fromRecipes).toBeVisible();

  // 2. Recipe list → 「毎日1枚、写真を撮る」: how-to, 30日後 and 「これを30日やる」.
  await fromRecipes.click();
  await expect(page.getByRole("heading", { level: 1, name: "チャレンジレシピ" })).toBeVisible();
  await main.getByRole("link", { name: new RegExp(TITLE) }).click();
  await expect(page).toHaveURL(/\/recipes\/photo$/);
  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
  await expect(page.getByRole("heading", { name: "やり方のコツ" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^30日後/ })).toBeVisible();
  const startButton = page.getByRole("button", { name: "これを30日やる" });
  await expect(startButton).toBeVisible();

  // 3. 「これを30日やる」→「今日から」→ nickname →「30日、始める」.
  await startButton.click();
  const sheet = page.getByRole("dialog", { name: "新しい30日" });
  await expect(sheet.getByLabel("チャレンジ名")).toHaveValue(TITLE);
  const fromToday = sheet.getByRole("radio", { name: /^今日から/ });
  await fromToday.check();
  await expect(fromToday).toBeChecked();
  await sheet.getByLabel("ニックネーム（任意）").fill(nickname);
  await sheet.getByRole("button", { name: "30日、始める" }).click();

  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
  const card = page.getByRole("article", { name: TITLE });
  await expect(card.getByRole("img", { name: "印「写」" })).toBeVisible();
  await expect(card.getByText("1日目", { exact: true })).toBeVisible();
  await expect(card.getByText("0/30日 押した", { exact: true })).toBeVisible();
  const grid = card.getByRole("group", { name: `「${TITLE}」の30日カード` });
  await expect(grid.getByRole("button", { name: "1日目", exact: true })).toHaveAttribute("aria-pressed", "false");

  // 4. 「きょう（1日目）の分を押す」: the first cell gets the seal, 1/30, and the ひとこと field.
  await card.getByRole("button", { name: "きょう（1日目）の分を押す" }).click();
  await expect(grid.getByRole("button", { name: "1日目（済）" })).toHaveAttribute("aria-pressed", "true");
  await expect(card.getByText("1/30日 押した", { exact: true })).toBeVisible();
  await expect(card.getByText("1日目、押しました")).toBeVisible();
  const note = card.getByLabel("きょうのひとこと（自分だけに見えます）");
  await expect(note).toBeVisible();
  await note.fill(NOTE);
  await note.press("Enter");
  await expect(card.getByText("保存しました")).toBeVisible();
  await expect(syncStatus(page)).toHaveText("同期済み");

  // 5. Reload: the stamp (and the note) are still there…
  await page.reload();
  await expect(grid.getByRole("button", { name: "1日目（済）" })).toHaveAttribute("aria-pressed", "true");
  await expect(card.getByText("1/30日 押した", { exact: true })).toBeVisible();
  await expect(card.getByLabel("きょうのひとこと（自分だけに見えます）")).toHaveValue(NOTE);

  // …because the server has them (not only this device's cache).
  const token = await waitForToken(page);
  const [challenge, ...others] = await getChallenges(request, token);
  expect(others).toHaveLength(0);
  expect(challenge).toMatchObject({ title: TITLE, seal: "写", recipeId: "photo", status: "active" });
  expect(Object.keys(challenge!.stamps)).toEqual(["1"]);
  expect(challenge!.stamps["1"]!.note).toBe(NOTE);
  // The note is private by default (#17): not shown, the switch under it is off, and 「みんな」 lists the
  // challenge without the note (the list never carries note text; 「詳しく見る」 gets none).
  expect(challenge!.stamps["1"]).not.toHaveProperty("shown");
  await expect(card.getByRole("switch", { name: "みんなに見せる" })).not.toBeChecked();
  await expect
    .poll(async () => (await getCohort(request, thisMonth())).members.find((m) => m.challengeId === challenge!.id)?.stampDays)
    .toEqual([1]);
  const cohort = await getCohort(request, thisMonth());
  expect(cohort.members.find((m) => m.challengeId === challenge!.id)).not.toHaveProperty("shownNoteCount");
  expect(JSON.stringify(cohort)).not.toContain(NOTE);
  expect(await getMemberNotes(request, challenge!.id)).toEqual({ challengeId: challenge!.id, notes: [] });
  expect((await getMe(request, token)).user.nickname).toBe(nickname);
});
