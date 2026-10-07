/**
 * CUF-3 (SPEC "Critical User Flow"): A starts this month with progress public; B (another browser)
 * sees A in みんな → 今月の組, opens A's details and cheers once; A turns 「みんなに進捗を表示する」 off and disappears.
 */
import { cheer, expect, getChallenges, getCohort, syncStatus, test, thisMonth, uniqueNickname, waitForToken } from "./fixtures";

const TITLE = "5分の瞑想";

test("CUF-3: B sees A in 今月の組, cheers once, and A disappears after turning progress off", async ({ page: pageA, browser, request }) => {
  const nicknameA = uniqueNickname("A");
  const month = thisMonth();

  // 1. A starts 「5分の瞑想」 today (progress is public by default) and stamps day 1.
  await pageA.goto("/recipes/meditate");
  await pageA.getByRole("button", { name: "これを30日やる" }).click();
  const sheet = pageA.getByRole("dialog", { name: "新しい30日" });
  await expect(sheet.getByText("進捗（タイトル・印・押した日）は「みんな」に表示されます。", { exact: false })).toBeVisible();
  await sheet.getByLabel("ニックネーム（任意）").fill(nicknameA);
  await sheet.getByRole("button", { name: "30日、始める" }).click();
  await pageA.getByRole("article", { name: TITLE }).getByRole("button", { name: "きょう（1日目）の分を押す" }).click();
  await expect(syncStatus(pageA)).toHaveText("同期済み");
  const tokenA = await waitForToken(pageA);
  const [challengeA] = await getChallenges(request, tokenA);
  await expect
    .poll(async () => (await getCohort(request, month)).members.find((m) => m.challengeId === challengeA!.id)?.stampDays)
    .toEqual([1]);

  // 2. B (a separate browser profile) opens 「みんな」: A's nickname, seal, title and mini grid in 今月の組.
  const contextB = await browser.newContext();
  try {
    const pageB = await contextB.newPage();
    await pageB.goto("/");
    await pageB.getByRole("navigation", { name: "メニュー" }).getByRole("link", { name: "みんな", exact: true }).click();
    await expect(pageB.getByRole("heading", { level: 1, name: "みんなの30日" })).toBeVisible();
    await expect(pageB.getByRole("tab", { name: /今月の組/ })).toHaveAttribute("aria-selected", "true");
    const panel = pageB.getByRole("tabpanel", { name: /今月の組/ });
    const memberA = panel.getByTestId("member").filter({ hasText: nicknameA });
    await expect(memberA).toHaveCount(1);
    await expect(memberA).toContainText(TITLE);
    await expect(memberA.getByText("静", { exact: true })).toBeVisible();
    await expect(memberA.getByRole("img", { name: "30日中1日押した" })).toBeVisible();

    // The card's buttons stay one line tall (「詳しく見る」 wraps under 応援 on narrow screens, the labels never break).
    for (const button of [memberA.getByTestId("cheer"), memberA.getByTestId("member-open")]) {
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box?.height ?? 0).toBeLessThanOrEqual(48);
    }

    // 2b. B opens A's details (the same public data, in a sheet): the 30 cells with day 1 stamped, no notes.
    await memberA.getByTestId("member-open").click();
    const detail = pageB.getByRole("dialog", { name: `${nicknameA}さんの30日` });
    await expect(detail).toBeVisible();
    await expect(detail).toContainText(TITLE);
    await expect(detail.getByRole("img", { name: `${nicknameA}さんの30日のカード：30日中1日押した（1日目）` })).toBeVisible();
    await expect(detail.getByText("ひとことメモと写真は、本人だけが見られます。")).toBeVisible();
    await pageB.keyboard.press("Escape");
    await expect(detail).toHaveCount(0);

    // 3. B cheers A: +1, and not again today.
    const cheerButton = memberA.getByRole("button", { name: new RegExp(`${nicknameA}さんを`) });
    await expect(cheerButton).toHaveText(/応援\s*0$/);
    await cheerButton.click();
    await expect(cheerButton).toHaveText(/応援済み\s*1$/);
    await expect(cheerButton).toBeDisabled();
    await expect(pageB.getByRole("status").filter({ hasText: `${nicknameA}さんを応援しました` })).toBeVisible();

    await pageB.reload();
    await expect(cheerButton).toHaveText(/応援済み\s*1$/);
    await expect(cheerButton).toBeDisabled();
    // A second cheer on the same day is refused by the server too.
    const tokenB = await waitForToken(pageB);
    expect((await cheer(request, tokenB, challengeA!.id)).status()).toBe(409);
    expect((await getChallenges(request, tokenA))[0]!.cheers).toBe(1);

    // 4. A turns 「みんなに進捗を表示する」 off in 設定 → after a reload B no longer sees A.
    await pageA.getByRole("link", { name: "設定", exact: true }).click();
    const share = pageA.getByRole("checkbox", { name: "みんなに進捗を表示する" });
    await expect(share).toBeChecked();
    await share.uncheck();
    await expect(share).not.toBeChecked();
    await expect(syncStatus(pageA)).toHaveText("同期済み");
    await expect
      .poll(async () => (await getCohort(request, month)).members.some((m) => m.challengeId === challengeA!.id))
      .toBe(false);

    await pageB.reload();
    await expect(panel.getByTestId("member").first().or(panel.getByText("まだ誰もいません。最初の1人になりませんか？"))).toBeVisible();
    await expect(memberA).toHaveCount(0);
  } finally {
    await contextB.close();
  }
});
