/**
 * Shared E2E helpers. Tests talk to the app through the browser; the API is used only to set up
 * state the UI cannot create quickly (a challenge that started 30 days ago) and to confirm that
 * what the screen shows was really saved on the server.
 */
import { randomUUID } from "node:crypto";
import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  API,
  addDays,
  monthKey,
  newId,
  todayIn,
  type BackupFile,
  type Challenge,
  type ChallengeListResponse,
  type CohortResponse,
  type ImportResponse,
  type MeResponse,
  type SessionResponse,
} from "@thirty/shared";

/** localStorage key of the anonymous bearer token (apps/web/src/lib/storage.ts KEYS.token). */
export const TOKEN_KEY = "thirty-days.token";
/** The browser and every seeded account use this zone (playwright.config.ts timezoneId). */
export const TZ = "Asia/Tokyo";

export const test = base.extend({
  // Behind CloudFront every viewer has its own x-viewer-ip; the API rate-limits new sessions per
  // IP (20/hour). Give each test its own "IP" so parallel tests and retries never share a budget.
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use) => {
    await use({ ...extraHTTPHeaders, "x-viewer-ip": `e2e-${randomUUID()}` });
  },
});

export { expect };

export function today(): string {
  return todayIn(TZ);
}

export function thisMonth(): string {
  return monthKey(today());
}

export { addDays };

/** A nickname nobody else in this run uses (max 16 graphemes). */
export function uniqueNickname(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, "").slice(0, 6)}`;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function json<T>(res: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

export async function createSession(request: APIRequestContext, nickname: string): Promise<SessionResponse> {
  return json<SessionResponse>(await request.post(API.session, { data: { tz: TZ, nickname } }));
}

export async function importChallenges(request: APIRequestContext, token: string, nickname: string, challenges: Challenge[]): Promise<ImportResponse> {
  const file: BackupFile = {
    format: "thirty-days-backup",
    version: 1,
    exportedAt: Date.now(),
    user: { nickname, shareProgress: true, reminder: { enabled: false, time: "21:00" } },
    challenges,
  };
  return json<ImportResponse>(await request.post(API.meImport, { data: file, headers: auth(token) }));
}

/** A challenge as a backup file holds it (POST /api/me/import is the supported way to create past ones). */
export function pastChallenge(opts: { title: string; seal: string; recipeId: string | null; startDate: string; stampedDays: number[] }): Challenge {
  const startMs = Date.parse(`${opts.startDate}T09:00:00+09:00`);
  const stamps: Challenge["stamps"] = {};
  for (const d of opts.stampedDays) stamps[String(d)] = { at: startMs + (d - 1) * 86_400_000 };
  return {
    id: newId(),
    recipeId: opts.recipeId,
    title: opts.title,
    seal: opts.seal,
    startDate: opts.startDate,
    status: "active",
    stamps,
    verdict: null,
    reflection: null,
    finishedAt: null,
    finishedDay: null,
    cheers: 0,
    shareId: null,
    createdAt: startMs,
    updatedAt: startMs + 29 * 86_400_000,
  };
}

export async function getChallenges(request: APIRequestContext, token: string): Promise<Challenge[]> {
  return (await json<ChallengeListResponse>(await request.get(API.challenges, { headers: auth(token) }))).challenges;
}

export async function getMe(request: APIRequestContext, token: string): Promise<MeResponse> {
  return json<MeResponse>(await request.get(API.me, { headers: auth(token) }));
}

/** The public cohort list, as an anonymous visitor sees it. */
export async function getCohort(request: APIRequestContext, month: string): Promise<CohortResponse> {
  return json<CohortResponse>(await request.get(API.cohort(month)));
}

export async function cheer(request: APIRequestContext, token: string, challengeId: string) {
  return request.post(API.cheer(challengeId), { data: {}, headers: auth(token) });
}

/** The token the app stored on this device (null before the first write). */
export async function tokenOf(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY);
}

/** Wait until the app has created its anonymous account and return the token. */
export async function waitForToken(page: Page): Promise<string> {
  await expect.poll(() => tokenOf(page), { message: "the app creates an anonymous session" }).not.toBeNull();
  return (await tokenOf(page))!;
}

/** Load the app as an existing account: the token is on the device before the first script runs. */
export async function useToken(page: Page, token: string): Promise<void> {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [TOKEN_KEY, token] as const);
}

/** The header sync pill (Layout.tsx). */
export const syncStatus = (page: Page) => page.getByTestId("sync-status");

/** A tab of the app menu (top nav on desktop, tab bar on phones — only one is displayed). */
export const menuLink = (page: Page, label: string) => page.getByRole("navigation", { name: "メニュー" }).getByRole("link", { name: label, exact: true });
