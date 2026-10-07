/**
 * The production build under the production CSP (SPEC "Architecture", infra/lib/edge.ts SITE_CSP):
 * no page may trigger a securitypolicyviolation. vite preview sends no CSP, so the test adds the
 * real header to every document response. zod probes `new Function` unless its jitless flag is set
 * before it is evaluated (apps/web/public/zod-jitless.js); that probe used to fire on every load.
 */
import type { Page } from "@playwright/test";
import { SITE_CSP } from "../../infra/lib/edge";
import { expect, syncStatus, test, uniqueNickname } from "./fixtures";

type Violation = { directive: string; blocked: string; source: string };

/** Serve every HTML document with the production CSP and collect violations across page loads. */
async function withProductionCsp(page: Page): Promise<{ violations: Violation[]; consoleErrors: string[] }> {
  const violations: Violation[] = [];
  const consoleErrors: string[] = [];
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.fallback();
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": SITE_CSP } });
  });
  // A binding survives navigations; the init script runs before the page's own scripts.
  await page.exposeFunction("__reportCspViolation", (v: Violation) => violations.push(v));
  await page.addInitScript(() => {
    const report = (window as unknown as { __reportCspViolation: (v: { directive: string; blocked: string; source: string }) => void }).__reportCspViolation;
    document.addEventListener("securitypolicyviolation", (e) => {
      report({ directive: e.effectiveDirective, blocked: e.blockedURI, source: `${e.sourceFile}:${e.lineNumber}` });
    });
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  return { violations, consoleErrors };
}

test("no CSP violation on the main screens, while starting and stamping a challenge (CUF-1)", async ({ page }) => {
  const { violations, consoleErrors } = await withProductionCsp(page);

  // The production CSP is on the document.
  const res = await page.goto("/");
  expect(res?.headers()["content-security-policy"]).toBe(SITE_CSP);
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(violations, "violations on /").toEqual([]);

  await page.goto("/recipes/photo");
  await page.getByRole("button", { name: "これを30日やる" }).click();
  const sheet = page.getByRole("dialog", { name: "新しい30日" });
  await sheet.getByLabel("ニックネーム（任意）").fill(uniqueNickname("C"));
  await sheet.getByRole("button", { name: "30日、始める" }).click();
  const card = page.getByRole("article", { name: "毎日1枚、写真を撮る" });
  await card.getByRole("button", { name: "きょう（1日目）の分を押す" }).click();
  await expect(card.getByText("1/30日 押した", { exact: true })).toBeVisible();
  await expect(syncStatus(page)).toHaveText("同期済み");

  for (const path of ["/recipes", "/gacha", "/together", "/settings", "/contact"]) {
    await page.goto(path);
    await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
    await page.waitForLoadState("networkidle");
  }

  expect(violations).toEqual([]);
  expect(consoleErrors.filter((t) => /Content Security Policy|unsafe-eval/i.test(t))).toEqual([]);
});
