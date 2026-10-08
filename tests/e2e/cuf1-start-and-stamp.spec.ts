/**
 * CUF-1 steps 1–5 (SPEC "Critical User Flow"): first visit → recipe → start → stamp day 1 →
 * reload, and the stamp is on the server. The day's ひとこと stays private (#17: shown only by choice).
 * A reservation for the next 1st starts today only after asking (#21: it leaves that 1日組), and a
 * double tap on 「今日から始める」 does not answer the question it opens.
 */
import { jpDate, nextFirst } from "@thirty/shared";
import { expect, getChallenges, getCohort, getMe, getMemberNotes, syncStatus, test, thisMonth, today, uniqueNickname, waitForToken } from "./fixtures";

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

test("#21: a reservation for the next 1st starts today only after asking; やめておく keeps it", async ({ page, request, hasTouch }) => {
  const RESERVED = "朝に白湯を飲む";
  const nf = nextFirst(today());
  const patches: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "PATCH" && /^\/api\/challenges\/[^/]+$/.test(new URL(r.url()).pathname)) patches.push(r.url());
  });
  const queued = () => page.evaluate(() => (JSON.parse(localStorage.getItem("thirty-days.outbox.v1") ?? "[]") as unknown[]).length);

  // Reserve from 「次の1日組」 on きょう.
  await page.goto("/");
  await page.getByRole("button", { name: "1日組で予約する" }).click();
  const sheet = page.getByRole("dialog", { name: "新しい30日" });
  await expect(sheet.getByRole("radio", { name: new RegExp(`^${jpDate(nf)}から（1日組）`) })).toBeChecked();
  await sheet.getByLabel("チャレンジ名").fill(RESERVED);
  await sheet.getByLabel("ニックネーム（任意）").fill(uniqueNickname("湯"));
  await sheet.getByRole("button", { name: "30日、始める" }).click();

  const card = page.getByRole("article", { name: RESERVED });
  await expect(card.getByText("予約中", { exact: true })).toBeVisible();
  await expect(card.getByText(`${jpDate(nf)}にスタート`)).toBeVisible();
  await expect(syncStatus(page)).toHaveText("同期済み");
  const token = await waitForToken(page);
  expect((await getChallenges(request, token)).map((c) => [c.title, c.startDate])).toEqual([[RESERVED, nf]]);

  // 「今日から始める」 asks first and names the 1日組 it leaves; やめておく sends and queues nothing.
  const startToday = card.getByRole("button", { name: "今日から始める" });
  const confirm = page.getByRole("alertdialog", { name: "今日から始めますか？" });
  const confirmButton = confirm.getByRole("button", { name: "今日から始める" });
  await startToday.click();
  await expect(confirm).toContainText(`${jpDate(nf)}の1日組から外れ`);
  await expect(confirm.getByRole("button", { name: "やめておく" })).toBeFocused();
  // Where the dialog's 「今日から始める」 sits once it has appeared (and takes presses), for the double tap below.
  await expect(confirmButton).toBeEnabled();
  const confirmAt = center((await confirmButton.boundingBox())!);
  await confirm.getByRole("button", { name: "やめておく" }).click();
  await expect(confirm).toBeHidden();
  await expect(card.getByText("予約中", { exact: true })).toBeVisible();
  await expect(startToday).toBeFocused();
  expect(await queued()).toBe(0);

  // Still reserved after a reload, on the server too.
  await page.reload();
  await expect(card.getByText(`${jpDate(nf)}にスタート`)).toBeVisible();
  await expect(syncStatus(page)).toHaveText("同期済み");
  expect(patches).toEqual([]);
  expect((await getChallenges(request, token))[0]!.startDate).toBe(nf);

  // A double tap on the card's 「今日から始める」 whose second tap lands on the dialog's 「今日から始める」
  // while the dialog is still appearing: that press is ignored, so the question stays and nothing is sent.
  await page.evaluate(() => {
    const w = window as unknown as { taps: { inDialog: boolean; label: string; ariaDisabled: string | null }[] };
    w.taps = [];
    document.addEventListener(
      "click",
      (e) => {
        const b = (e.target as Element).closest("button");
        if (b) w.taps.push({ inDialog: !!b.closest("[role=alertdialog]"), label: b.textContent ?? "", ariaDisabled: b.getAttribute("aria-disabled") });
      },
      true,
    );
  });
  await startToday.click({ trial: true }); // scrolled into view, and nothing covers its centre
  const openerAt = center((await startToday.boundingBox())!);
  const tap = ({ x, y }: { x: number; y: number }) => (hasTouch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y));
  await tap(openerAt);
  await tap(confirmAt);
  expect(await page.evaluate(() => (window as unknown as { taps: unknown[] }).taps)).toEqual([
    { inDialog: false, label: "今日から始める", ariaDisabled: null },
    { inDialog: true, label: "今日から始める", ariaDisabled: "true" },
  ]);
  await expect(confirmButton).toBeEnabled();
  await expect(confirm).toBeVisible();
  await expect(card.getByText("予約中", { exact: true })).toBeVisible();
  expect(patches).toEqual([]);
  expect(await queued()).toBe(0);

  // 「今日から始める」 in the dialog, now that it has been seen: one PATCH, and today's stamp button is next.
  await confirmButton.click();
  await expect(confirm).toBeHidden();
  await expect(card.getByText("1日目", { exact: true })).toBeVisible();
  await expect(card.getByText("予約中", { exact: true })).toBeHidden();
  await expect(card.getByRole("button", { name: "きょう（1日目）の分を押す" })).toBeFocused();
  await expect(syncStatus(page)).toHaveText("同期済み");
  expect(patches).toHaveLength(1);
  expect((await getChallenges(request, token))[0]!.startDate).toBe(today());
});

function center(box: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
