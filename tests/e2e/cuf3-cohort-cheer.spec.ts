/**
 * CUF-3 (SPEC "Critical User Flow"): A starts this month with progress public; B (another browser)
 * sees A in みんな → 今月の組, opens A's details and cheers once; A turns 「みんなに進捗を表示する」 off and disappears.
 * Then (#17) A shows one day's ひとこと: B reads only that note in 「詳しく見る」, and editing it or
 * turning it back to 「自分だけ」 hides it on B's very next look.
 */
import { API, monthKey, type CohortResponse } from "@thirty/shared";
import {
  addDays,
  cheer,
  createChallenge,
  createSession,
  expect,
  getChallenges,
  getCohort,
  getMemberNotes,
  syncStatus,
  test,
  thisMonth,
  today,
  uniqueNickname,
  useToken,
  waitForToken,
} from "./fixtures";

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
    await expect(detail.getByText("ひとことは、本人が「みんなに見せる」を選んだものだけ表示しています。写真は本人だけが見られます。")).toBeVisible();
    // A shows no ひとこと: no notes section (and no request for them).
    await expect(detail.getByTestId("member-notes")).toHaveCount(0);
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
    // A's details are not public any more either.
    expect(await getMemberNotes(request, challengeA!.id)).toBeNull();
  } finally {
    await contextB.close();
  }
});

const WALK = "朝の散歩";
// No other test writes these, so finding one in a response can only mean this member's note leaked.
const NOTE1 = "公園まで遠回りして歩いた";
const NOTE1_EDITED = "公園で猫に会えた";
const NOTE1_TAPPED = "公園で猫を見かけた";
const NOTE2 = "雨なので近所だけにした";

const memberOf = (cohort: CohortResponse, id: string) => cohort.members.find((m) => m.challengeId === id);

test("CUF-3: A shows one day's ひとこと; B sees only that note, and editing it or turning it back hides it at once", async ({
  page: pageA,
  browser,
  request,
}) => {
  const nicknameA = uniqueNickname("歩");
  // Two days to choose between: a challenge that started yesterday. The screens start only today or on
  // the 1st, so the API creates it (as the app would; not an import, so it is listed like any other).
  const startDate = addDays(today(), -1);
  const month = monthKey(startDate);
  const thisMonthTab = month === thisMonth();
  const { token } = await createSession(request, nicknameA);
  const { id } = await createChallenge(request, token, { title: WALK, seal: "歩", recipeId: null, startDate });

  // 1. A stamps day 2 on きょう with NOTE2, and day 1 on the challenge page with NOTE1. Both are private.
  await useToken(pageA, token);
  await pageA.goto("/");
  const card = pageA.getByRole("article", { name: WALK });
  await card.getByRole("button", { name: "きょう（2日目）の分を押す" }).click();
  const todayNote = card.getByLabel("きょうのひとこと（自分だけに見えます）");
  await todayNote.fill(NOTE2);
  await todayNote.press("Enter");
  await expect(card.getByText("保存しました")).toBeVisible();
  await expect(card.getByRole("switch", { name: "みんなに見せる" })).not.toBeChecked();

  await card.getByRole("link", { name: "詳細・メモ" }).click();
  await expect(pageA).toHaveURL(new RegExp(`/c/${id}$`));
  const grid = pageA.getByRole("group", { name: `「${WALK}」の30日カード（日付を選ぶとメモと写真）` });
  await grid.getByRole("button", { name: "1日目", exact: true }).click();
  const day1 = pageA.getByRole("region", { name: /^1日目/ });
  await day1.getByRole("button", { name: "この日の印を押す" }).click();
  await day1.getByLabel("この日のひとこと（自分だけに見えます）").fill(NOTE1);
  await day1.getByRole("button", { name: "保存", exact: true }).click();
  await expect(day1.getByText("保存しました")).toBeVisible();
  await expect(syncStatus(pageA)).toHaveText("同期済み");

  const switch1 = day1.getByRole("switch", { name: "みんなに見せる" });
  await expect(switch1).not.toBeChecked();
  await expect(day1.getByText("オンにすると、この日のひとことだけが「みんな」に表示されます。")).toBeVisible();
  const [saved] = await getChallenges(request, token);
  expect(saved!.stamps["1"]).toEqual({ at: expect.any(Number), note: NOTE1 });
  expect(saved!.stamps["2"]).toEqual({ at: expect.any(Number), note: NOTE2 });
  // Listed with both days, without either note: no count, no text, and nothing in 「詳しく見る」.
  await expect.poll(async () => memberOf(await getCohort(request, month), id)?.stampDays).toEqual([1, 2]);
  let cohort = await getCohort(request, month);
  expect(memberOf(cohort, id)).not.toHaveProperty("shownNoteCount");
  expect(JSON.stringify(cohort)).not.toContain(NOTE1);
  expect(JSON.stringify(cohort)).not.toContain(NOTE2);
  expect(await getMemberNotes(request, id)).toEqual({ challengeId: id, notes: [] });

  const contextB = await browser.newContext();
  try {
    // 2. B (another browser, no account) opens 「みんな」: A is listed, without notes.
    const pageB = await contextB.newPage();
    await pageB.goto(thisMonthTab ? "/together" : "/together?tab=prev");
    const panel = pageB.getByRole("tabpanel", { name: thisMonthTab ? /今月の組/ : /先月の組/ });
    const memberA = panel.getByTestId("member").filter({ hasText: nicknameA });
    await expect(memberA).toHaveCount(1);
    await expect(memberA.getByTestId("notes-pill")).toHaveCount(0);

    const detail = pageB.getByRole("dialog", { name: `${nicknameA}さんの30日` });
    const shownNotes = detail.getByRole("region", { name: "本人が見せているひとこと" });
    /** Open A's 「詳しく見る」. With `fetches`, wait for the notes request it makes on every open. */
    async function openDetail(fetches: boolean): Promise<number | null> {
      const response = fetches ? pageB.waitForResponse((r) => new URL(r.url()).pathname === API.memberNotes(id)) : null;
      await memberA.getByTestId("member-open").click();
      await expect(detail).toBeVisible();
      return response ? (await response).status() : null;
    }
    async function closeDetail() {
      await pageB.keyboard.press("Escape");
      await expect(detail).toHaveCount(0);
    }

    await openDetail(false);
    await expect(detail.getByRole("img", { name: `${nicknameA}さんの30日のカード：30日中2日押した（1・2日目）` })).toBeVisible();
    await expect(detail.getByTestId("member-notes")).toHaveCount(0);
    await expect(detail).not.toContainText(NOTE1);
    await expect(detail).not.toContainText(NOTE2);
    await closeDetail();

    // 3. A shows day 1 through the confirm sheet, which previews the note as 「詳しく見る」 will show it.
    await switch1.click();
    const ask = pageA.getByRole("dialog", { name: "このひとことを「みんな」に見せますか？" });
    await expect(ask.getByText("「みんな」の「詳しく見る」では、こう見えます")).toBeVisible();
    const preview = ask.getByRole("listitem").filter({ hasText: "1日目" });
    await expect(preview).toContainText(NOTE1);
    await expect(ask.getByText("アカウントがない人も含めて、誰でも見られます。")).toBeVisible();
    await expect(ask.getByText("見せると利用規約とプライバシーポリシーに同意したことになります。")).toBeVisible();
    await ask.getByRole("button", { name: "見せる", exact: true }).click();
    await expect(ask).toHaveCount(0);
    await expect(pageA.getByRole("status").filter({ hasText: "みんなに見せました" })).toBeVisible();
    await expect(switch1).toBeChecked();
    await expect(day1.getByLabel("この日のひとこと（みんなに見せています）")).toHaveValue(NOTE1);
    const memos = pageA.getByRole("region", { name: "メモ", exact: true });
    await expect(memos.getByRole("listitem").filter({ hasText: NOTE1 })).toContainText("みんな");
    await expect(memos.getByRole("listitem").filter({ hasText: NOTE2 })).not.toContainText("みんな");

    // Only day 1, from the public endpoint; the list counts it and still carries no text.
    expect(await getMemberNotes(request, id)).toEqual({ challengeId: id, notes: [{ day: 1, note: NOTE1 }] });
    await expect.poll(async () => memberOf(await getCohort(request, month), id)?.shownNoteCount).toBe(1);
    cohort = await getCohort(request, month);
    expect(JSON.stringify(cohort)).not.toContain(NOTE1);
    expect(JSON.stringify(cohort)).not.toContain(NOTE2);

    // B reloads: a 「ひとこと 1」 pill on A's card, and 「1日目」 NOTE1 (only) in 「詳しく見る」.
    await pageB.reload();
    await expect(memberA.getByTestId("notes-pill")).toContainText("ひとこと 1");
    await expect(memberA).not.toContainText(NOTE1);
    expect(await openDetail(true)).toBe(200);
    await expect(shownNotes.getByRole("listitem")).toHaveCount(1);
    await expect(shownNotes.getByRole("listitem")).toContainText("1日目");
    await expect(shownNotes.getByRole("listitem")).toContainText(NOTE1);
    await expect(detail).not.toContainText(NOTE2);
    await closeDetail();

    // 4. A edits the shown note: it is private again, and B's very next look (no reload) shows nothing.
    await day1.getByLabel("この日のひとこと（みんなに見せています）").fill(NOTE1_EDITED);
    await day1.getByRole("button", { name: "保存", exact: true }).click();
    await expect(pageA.getByRole("status").filter({ hasText: "書き換えたので「自分だけ」に戻しました。" })).toBeVisible();
    await expect(day1.getByLabel("この日のひとこと（自分だけに見えます）")).toHaveValue(NOTE1_EDITED);
    await expect(switch1).not.toBeChecked();
    await expect(syncStatus(pageA)).toHaveText("同期済み");
    expect(await getMemberNotes(request, id)).toEqual({ challengeId: id, notes: [] });

    expect(await openDetail(true)).toBe(200);
    await expect(detail.getByTestId("member-notes")).toHaveCount(0);
    for (const text of [NOTE1, NOTE1_EDITED, NOTE2]) await expect(detail).not.toContainText(text);
    await closeDetail();

    // 5. A shows the new text, then turns it back to 「自分だけ」 (no question): gone at once.
    await switch1.click();
    await expect(ask.getByRole("listitem").filter({ hasText: "1日目" })).toContainText(NOTE1_EDITED);
    await ask.getByRole("button", { name: "見せる", exact: true }).click();
    await expect(switch1).toBeChecked();
    expect(await getMemberNotes(request, id)).toEqual({ challengeId: id, notes: [{ day: 1, note: NOTE1_EDITED }] });
    expect(await openDetail(true)).toBe(200);
    await expect(shownNotes.getByRole("listitem")).toContainText(NOTE1_EDITED);
    await closeDetail();

    await switch1.click();
    await expect(pageA.getByRole("status").filter({ hasText: "自分だけに戻しました" })).toBeVisible();
    await expect(ask).toHaveCount(0);
    await expect(switch1).not.toBeChecked();
    // The server confirmed before the toast: the very next read has nothing (no waiting for the list).
    expect(await getMemberNotes(request, id)).toEqual({ challengeId: id, notes: [] });
    expect(await openDetail(true)).toBe(200);
    await expect(detail.getByTestId("member-notes")).toHaveCount(0);
    await expect(detail).not.toContainText(NOTE1_EDITED);
    await closeDetail();

    // 5b. Shown again, A types over it and taps the switch right away to hide it. The tap first takes
    //     focus from the field, which saves the text (private once the server has it; the switch
    //     stays on until then): the tap hides it at once and never asks to show the new text.
    await switch1.click();
    await ask.getByRole("button", { name: "見せる", exact: true }).click();
    await expect(switch1).toBeChecked();
    await day1.getByLabel("この日のひとこと（みんなに見せています）").fill(NOTE1_TAPPED);
    await switch1.click();
    // The edit's toast or the switch's, whichever answers last: both say it is private.
    await expect(pageA.getByRole("status").filter({ hasText: /「?自分だけ」?に戻しました/ })).toBeVisible();
    await expect(ask).toHaveCount(0);
    await expect(switch1).not.toBeChecked();
    await expect(day1.getByLabel("この日のひとこと（自分だけに見えます）")).toHaveValue(NOTE1_TAPPED);
    await expect(syncStatus(pageA)).toHaveText("同期済み");
    expect(await getMemberNotes(request, id)).toEqual({ challengeId: id, notes: [] });

    // 6. Shown again, then A turns progress off in 設定: the notes endpoint is 404 at once, A's page
    //    says nobody sees the note now, and A leaves B's list (CUF-3 step 4).
    await switch1.click();
    await ask.getByRole("button", { name: "見せる", exact: true }).click();
    await expect(switch1).toBeChecked();
    await pageA.getByRole("link", { name: "設定", exact: true }).click();
    const share = pageA.getByRole("checkbox", { name: "みんなに進捗を表示する" });
    await share.uncheck();
    await expect(share).not.toBeChecked();
    await expect(syncStatus(pageA)).toHaveText("同期済み");
    expect(await getMemberNotes(request, id)).toBeNull();
    expect(await openDetail(true)).toBe(404);
    await expect(detail.getByTestId("member-notes")).toHaveCount(0);
    await closeDetail();

    await pageA.goBack();
    await grid.getByRole("button", { name: "1日目（済）" }).click();
    await expect(switch1).toBeChecked();
    await expect(day1.getByText("進捗の表示がオフなので、いまは誰にも見えていません。")).toBeVisible();

    await expect.poll(async () => memberOf(await getCohort(request, month), id)).toBeUndefined();
    await pageB.reload();
    const empty = thisMonthTab ? "まだ誰もいません。最初の1人になりませんか？" : "この月に始めた人はいません";
    await expect(panel.getByTestId("member").first().or(panel.getByText(empty))).toBeVisible();
    await expect(memberA).toHaveCount(0);
    // NOTE2 (never shown) was not public at any point.
    expect(JSON.stringify(await getCohort(request, month))).not.toContain(NOTE2);
  } finally {
    await contextB.close();
  }
});
