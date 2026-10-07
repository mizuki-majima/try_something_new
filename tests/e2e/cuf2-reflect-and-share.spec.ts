/**
 * CUF-2 (SPEC "Critical User Flow"): a challenge that started 30 days ago → 振り返る → 続ける →
 * share card (1200×630) → public link /s/<id> with OGP → 記録 shows the 「続ける」 badge.
 *
 * The 30-day-old challenge is created through the real API: POST /api/session, then
 * POST /api/me/import with a backup file (the supported way to bring in past challenges).
 */
import { readFile } from "node:fs/promises";
import type { APIRequestContext } from "@playwright/test";
import {
  addDays,
  createSession,
  expect,
  getChallenges,
  importChallenges,
  menuLink,
  pastChallenge,
  test,
  today,
  uniqueNickname,
  useToken,
} from "./fixtures";

const TITLE = "毎日1枚、写真を撮る";
const REFLECTION = "通勤路の見え方が変わった。もう少し続けてみる";
/** 23 of 30 days stamped (a realistic, imperfect card). */
const STAMPED = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 13, 14, 15, 16, 18, 19, 20, 22, 24, 25, 27, 28, 30];

/**
 * A fresh account whose challenge started 30 days ago, i.e. day 30 was yesterday: phase "ended"
 * (SPEC CUF-2 step 1 "30日前に始めたチャレンジ"; 29 days ago would still be day 30, "active").
 */
async function seedEndedChallenge(request: APIRequestContext) {
  const nickname = uniqueNickname("振");
  const { token } = await createSession(request, nickname);
  const challenge = pastChallenge({ title: TITLE, seal: "写", recipeId: "photo", startDate: addDays(today(), -30), stampedDays: STAMPED });
  expect(await importChallenges(request, token, nickname, [challenge])).toEqual({ imported: 1, skipped: 0 });
  return { nickname, token, challengeId: challenge.id };
}

/** PNG width × height from the IHDR chunk. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("CUF-2: reflect on a finished 30 days, publish the card and see the 「続ける」 badge in 記録", async ({ page, request }) => {
  const { nickname, token, challengeId } = await seedEndedChallenge(request);
  await useToken(page, token);

  // 1. 「30日が終わりました」 and 「振り返る」.
  await page.goto("/");
  const card = page.getByRole("article", { name: TITLE });
  await expect(card.getByText("30日が終わりました")).toBeVisible();
  await expect(card.getByText("23/30日 押した", { exact: true })).toBeVisible();

  // 2. 「振り返る」→「続ける」→ ひとこと →「決める」: the 1200×630 card is previewed.
  await card.getByRole("link", { name: "振り返る" }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${challengeId}/reflect$`));
  await expect(page.getByRole("heading", { name: "この30日、どうする？" })).toBeVisible();
  await page.getByRole("group", { name: "判定" }).getByText("続ける", { exact: true }).click();
  await expect(page.getByRole("radio", { name: /^続ける/ })).toBeChecked();
  await page.getByLabel("ひとこと（任意・シェア用カードに載ります）").fill(REFLECTION);
  await page.getByRole("button", { name: "決める" }).click();

  await expect(page.getByRole("heading", { name: "シェア用カード" })).toBeVisible();
  const preview = page.getByRole("img", { name: new RegExp(`^「${TITLE}」の30日カード。印「写」`) });
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAccessibleName(/23\/30日押した。判定「続ける」。/);
  await expect
    .poll(() => preview.evaluate((img: HTMLImageElement) => (img.complete ? `${img.naturalWidth}x${img.naturalHeight}` : "loading")))
    .toBe("1200x630");

  // 3. 「リンクを作って共有」: a /s/<id> URL. Its page shows the card and points og:image at the PNG.
  await page.getByRole("button", { name: "リンクを作って共有" }).click();
  const linkField = page.getByRole("textbox", { name: "公開リンク" });
  await expect(linkField).toHaveValue(/^http:\/\/127\.0\.0\.1:\d+\/s\/[0-9a-z]{12,32}$/);
  const shareUrl = await linkField.inputValue();
  const shareId = shareUrl.split("/s/")[1]!;
  await expect(page.getByRole("link", { name: /LINEで送る/ })).toBeVisible();

  const res = await page.goto(shareUrl);
  expect(res?.status()).toBe(200);
  expect(res?.headers()["content-type"]).toContain("text/html");
  await expect(page).toHaveTitle(`${nickname}の30日「${TITLE}」 | 30日だけ`);
  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
  await expect(page.getByText(`${nickname}の30日`, { exact: true })).toBeVisible();
  await expect(page.getByText("写", { exact: true })).toBeVisible();
  await expect(page.getByText("続ける", { exact: true })).toBeVisible();
  await expect(page.getByText("23/30日", { exact: true })).toBeVisible();
  await expect(page.getByText(REFLECTION)).toBeVisible();
  await expect(page.getByRole("img", { name: `${nickname}の30日「${TITLE}」の振り返りカード` })).toBeVisible();

  const origin = new URL(shareUrl).origin;
  const ogImage = await page.locator('meta[property="og:image"]').getAttribute("content");
  expect(ogImage).toBe(`${origin}/media/share/${shareId}.png`);
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", shareUrl);
  const image = await request.get(ogImage!);
  expect(image.status()).toBe(200);
  expect(image.headers()["content-type"]).toBe("image/png");
  expect(pngSize(await image.body())).toEqual({ width: 1200, height: 630 });

  const tryIt = page.getByRole("link", { name: "自分も30日やってみる" });
  await expect(tryIt).toHaveAttribute("href", "/recipes/photo");
  await tryIt.click();
  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();

  // 4. 「記録」 tab: the finished challenge carries the 「続ける」 badge.
  await menuLink(page, "記録").click();
  await expect(page.getByRole("heading", { level: 1, name: "記録" })).toBeVisible();
  const finished = page.getByRole("region", { name: "終わった30日" }).getByRole("link", { name: new RegExp(TITLE) });
  await expect(finished).toBeVisible();
  await expect(finished.getByText("続ける", { exact: true })).toBeVisible();
  await expect(finished).toContainText(`「${REFLECTION}」`);

  // The server has the decision and the public card.
  const [saved] = await getChallenges(request, token);
  expect(saved).toMatchObject({ id: challengeId, status: "done", verdict: "continue", reflection: REFLECTION, shareId });
});

test("CUF-2 E: when the card upload fails, an error shows and the on-device share options still work", async ({ page, request }) => {
  const { token } = await seedEndedChallenge(request);
  await useToken(page, token);
  await page.route("**/api/shares", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":{"code":"internal","message":"upload failed"}}' })
      : route.continue(),
  );

  await page.goto("/");
  await page.getByRole("article", { name: TITLE }).getByRole("link", { name: "振り返る" }).click();
  await page.getByRole("group", { name: "判定" }).getByText("やめる", { exact: true }).click();
  await page.getByRole("button", { name: "決める" }).click();
  await expect(page.getByRole("img", { name: new RegExp(`^「${TITLE}」の30日カード`) })).toBeVisible();

  await page.getByRole("button", { name: "リンクを作って共有" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "画像の保存やXでの共有は、このまま使えます。" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "公開リンク" })).toHaveCount(0);

  // 「画像を保存」 still saves the card. (The saved name comes from the download attribute; Chromium
  // replaces non-ASCII names with "download" when the OS locale is not UTF-8, so check the attribute.)
  const save = page.getByRole("link", { name: "画像を保存" });
  await expect(save).toHaveAttribute("download", "30days-写.png");
  const download = page.waitForEvent("download");
  await save.click();
  expect(pngSize(await readFile(await (await download).path()))).toEqual({ width: 1200, height: 630 });
  await expect(page.getByRole("link", { name: /Xで共有/ })).toHaveAttribute("href", /^https:\/\/x\.com\/intent\/post\?text=/);
});
