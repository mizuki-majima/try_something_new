/**
 * E2E for the Critical User Flow (SPEC "Critical User Flow", docs/test-plan.md).
 * `npm run test:e2e` builds the web app first, then this starts scripts/e2e-server.mjs:
 * the local API (fresh in-memory dynalite) + `vite preview` of apps/web/dist on :4173.
 * No paid or external services are called.
 */
import { defineConfig, devices } from "@playwright/test";

const CI = !!process.env.CI;
const PORT = Number(process.env.E2E_WEB_PORT ?? 4173);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  outputDir: "test-results",
  use: {
    baseURL: BASE_URL,
    locale: "ja-JP",
    // The audience is in Japan; "today" (day N, the month's cohort) is computed in this zone.
    timezoneId: "Asia/Tokyo",
    // The PWA service worker would cache the app shell and API GETs between steps; tests that
    // need it opt in with test.use({ serviceWorkers: "allow" }).
    serviceWorkers: "block",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "mobile",
      use: {
        ...devices["Pixel 7"],
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: BASE_URL,
    reuseExistingServer: !CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
