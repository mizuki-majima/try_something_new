/**
 * CDK app entry (cdk.json: "npx tsx bin/app.ts").
 *
 * Context (-c key=value):
 *   alertEmail       budget ($10/month) and API error alarm mails; strongly recommended.
 *                    Also read from the ALERT_EMAIL env var, so `ALERT_EMAIL=... npm run deploy` works
 *                    (npm would swallow a -c flag passed through the root script).
 *   webDistPath      override the built SPA directory      (default ../apps/web/dist)
 *   apiDistPath      override the api Lambda bundle dir    (default ../apps/api/dist/api)
 *   reminderDistPath override the reminder bundle dir      (default ../apps/api/dist/reminder)
 *
 * No context lookups: CI synthesizes with a dummy account and no credentials.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { App } from "aws-cdk-lib";
import { REGION, STACK_NAME } from "../lib/config";
import { DEFAULT_ASSET_PATHS, ThirtyDaysStack } from "../lib/thirty-days-stack";

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

new ThirtyDaysStack(app, STACK_NAME, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION },
  description: "thirty-days: try something new for 30 days",
  webDistPath: assetPath("webDistPath"),
  apiDistPath: assetPath("apiDistPath"),
  reminderDistPath: assetPath("reminderDistPath"),
  alertEmail,
});
