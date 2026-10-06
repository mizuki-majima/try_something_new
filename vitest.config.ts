import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const webSetup = here("./apps/web/test/setup.ts");

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "shared",
          include: ["packages/shared/test/**/*.test.{ts,tsx}"],
          environment: "node",
        },
      },
      {
        test: {
          name: "api",
          include: ["apps/api/test/**/*.test.{ts,tsx}"],
          environment: "node",
          // Each file starts its own dynalite; first requests pay for SDK and table setup.
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: "web",
          include: ["apps/web/test/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          setupFiles: existsSync(webSetup) ? [webSetup] : [],
        },
      },
      {
        test: {
          name: "infra",
          include: ["infra/test/**/*.test.{ts,tsx}"],
          environment: "node",
          testTimeout: 60_000,
        },
      },
    ],
  },
});
