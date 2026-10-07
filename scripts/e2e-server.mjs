#!/usr/bin/env node
// E2E server (Playwright `webServer`, see playwright.config.ts): the local API with a fresh
// in-memory dynalite and a throwaway media directory, plus `vite preview` of the BUILT web app
// (apps/web/dist) proxying /api, /s and /media to that API — the same shape as CloudFront.
//
//   npm run build -w apps/web && node scripts/e2e-server.mjs
//
// Env: E2E_API_PORT (default 8787), E2E_WEB_PORT (default 4173), E2E_LOG_LEVEL (default "warn").
// Stops cleanly on SIGTERM / SIGINT (closes both servers, dynalite, removes the media directory).
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { preview } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(root, "apps/web");
const HOST = "127.0.0.1";
const apiPort = Number(process.env.E2E_API_PORT ?? 8787);
const webPort = Number(process.env.E2E_WEB_PORT ?? 4173);

if (!existsSync(path.join(webRoot, "dist/index.html"))) {
  console.error("[e2e] apps/web/dist is missing: run `npm run build -w apps/web` first (npm run test:e2e does).");
  process.exit(1);
}

// Never point the E2E API at a real table, bucket or CloudFront secret from the caller's shell.
for (const name of ["DYNAMO_ENDPOINT", "MEDIA_BUCKET", "MEDIA_DIR", "ORIGIN_VERIFY", "TABLE_NAME", "ADMIN_TOKEN"]) {
  delete process.env[name];
}

const mediaDir = await mkdtemp(path.join(tmpdir(), "thirty-days-e2e-media-"));
/** @type {typeof import("../apps/api/src/local.ts")} */
const { startLocal } = await tsImport("../apps/api/src/local.ts", import.meta.url);

let api;
let web;
let stopping = false;

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  const force = setTimeout(() => process.exit(code), 5_000);
  force.unref();
  try {
    await web?.close();
  } catch (err) {
    console.error("[e2e] closing preview:", err);
  }
  try {
    await api?.close();
  } catch (err) {
    console.error("[e2e] closing api:", err);
  }
  await rm(mediaDir, { recursive: true, force: true }).catch(() => undefined);
  process.exit(code);
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));

try {
  api = await startLocal({
    port: apiPort,
    hostname: HOST,
    mediaDir,
    env: { LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? "warn" },
  });

  const target = api.url;
  web = await preview({
    root: webRoot,
    configFile: path.join(webRoot, "vite.config.ts"),
    logLevel: "warn",
    preview: {
      host: HOST,
      port: webPort,
      strictPort: true,
      open: false,
      // Same routes as vite.config.ts, pointed at the API we just started (its port may differ).
      proxy: {
        "^/api/": { target },
        "^/s/": { target },
        "^/media/": { target },
      },
    },
  });
} catch (err) {
  console.error("[e2e] failed to start:", err);
  await shutdown(1);
}

console.log(`[e2e] web http://${HOST}:${webPort}  api ${api.url}  media ${mediaDir}`);
