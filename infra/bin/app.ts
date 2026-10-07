/**
 * CDK app entry (cdk.json: "npx tsx bin/app.ts").
 *
 * Context (-c key=value):
 *   alertEmail       budget ($10/month) plus API / reminder error and DynamoDB throttle alarm mails;
 *                    strongly recommended. (The table's throughput cap applies with or without it.)
 *                    Also read from the ALERT_EMAIL env var, so `ALERT_EMAIL=... npm run deploy` works
 *                    (npm would swallow a -c flag passed through the root script).
 *   webDistPath      override the built SPA directory      (default ../apps/web/dist)
 *   apiDistPath      override the api Lambda bundle dir    (default ../apps/api/dist/api)
 *   reminderDistPath override the reminder bundle dir      (default ../apps/api/dist/reminder)
 *
 * Environment: PUBLIC_ORIGIN (https://<CloudFront domain>) is read by the web build for absolute
 * og:image URLs; here it is only checked against the built index.html (a warning, so CI and the
 * very first deploy, before the domain exists, still synthesize).
 *
 * No context lookups: CI synthesizes with a dummy account and no credentials.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { App } from "aws-cdk-lib";
import { REGION, STACK_DESCRIPTION, STACK_NAME } from "../lib/config";
import { DEFAULT_ASSET_PATHS, ThirtyDaysStack } from "../lib/thirty-days-stack";
import { previewImageProblems } from "../lib/web-check";

const infraDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = new App();

function contextString(key: string): string | undefined {
  const value: unknown = app.node.tryGetContext(key);
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`context ${key} must be a string`);
  return value.trim() || undefined;
}

function assetPath(key: keyof typeof DEFAULT_ASSET_PATHS): string {
  const given = contextString(key);
  const resolved = given ? path.resolve(infraDir, given) : DEFAULT_ASSET_PATHS[key];
  if (!existsSync(resolved)) {
    throw new Error(`${key}: ${resolved} がありません。先にリポジトリのルートで npm run build を実行してください。`);
  }
  return resolved;
}

const alertEmail = contextString("alertEmail") ?? (process.env.ALERT_EMAIL?.trim() || undefined);
if (alertEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(alertEmail)) {
  throw new Error(`alertEmail はメールアドレスで指定してください（"${alertEmail}"）`);
}

const webDistPath = assetPath("webDistPath");
const indexHtml = path.join(webDistPath, "index.html");
if (existsSync(indexHtml)) {
  const problems = previewImageProblems(readFileSync(indexHtml, "utf8"), process.env.PUBLIC_ORIGIN);
  if (problems.length > 0) {
    console.warn(
      [
        "警告: Web のビルドの OGP 画像が公開用になっていません（リンクのプレビューに画像が出ません）。",
        ...problems.map((p) => `  - ${p}`),
        "  PUBLIC_ORIGIN=https://<CloudFront のドメイン> を付けて npm run deploy してください（docs/deploy.md）。",
      ].join("\n"),
    );
  }
}

new ThirtyDaysStack(app, STACK_NAME, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION },
  description: STACK_DESCRIPTION,
  webDistPath,
  apiDistPath: assetPath("apiDistPath"),
  reminderDistPath: assetPath("reminderDistPath"),
  alertEmail,
});
