/**
 * Fixed-window quota counters. One item per (scope, key, window), incremented atomically and
 * refused once it reaches the limit; items expire through TTL after 2 days.
 * The key (user id, IP hash, ...) is stored hashed, so a deleted account leaves no id behind.
 */
import { createHash } from "node:crypto";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { todayIn } from "@thirty/shared";
import { HttpError } from "../errors";
import type { DbDeps } from "../ports";
import { rateKey, ttlIn } from "./keys";
import { isConditionFailed } from "./util";

export type WindowKind = "day" | "hour";

const JST = "Asia/Tokyo";
const JST_OFFSET_MS = 9 * 3_600_000;
const RATE_TTL_SECONDS = 2 * 86_400;

/** Window id and when it ends. Day windows follow the JST calendar day (QUOTAS are "per JST day"). */
export function windowFor(kind: WindowKind, now: Date): { id: string; resetAt: number } {
  if (kind === "day") {
    const id = todayIn(JST, now);
    const [y, m, d] = id.split("-").map(Number) as [number, number, number];
    return { id, resetAt: Date.UTC(y, m - 1, d + 1) - JST_OFFSET_MS };
  }
  const id = now.toISOString().slice(0, 13); // "YYYY-MM-DDTHH" (UTC)
  const start = Date.parse(`${id}:00:00.000Z`);
  return { id, resetAt: start + 3_600_000 };
}

function counterKey(scope: string, key: string, window: string) {
  return rateKey(scope, createHash("sha256").update(key).digest("hex").slice(0, 32), window);
}

export type QuotaResult = { count: number; limit: number; remaining: number; resetAt: number };

function limitedError(kind: WindowKind, resetAt: number, nowMs: number): HttpError {
  const message =
    kind === "day"
      ? "今日はここまでです。日本時間の0時を過ぎると、また使えます"
      : "短い時間に操作が集中しています。しばらくしてからもう一度お試しください";
  const retryAfter = Math.max(1, Math.ceil((resetAt - nowMs) / 1000));
  return new HttpError(429, "rate_limited", message, undefined, { "Retry-After": String(retryAfter) });
}

/**
 * Count one use of `scope` for `key` and throw 429 rate_limited once `limit` uses have been
 * counted in the current window. Refused attempts are not counted.
 */
export async function enforceQuota(
  deps: DbDeps,
  scope: string,
  key: string,
  limit: number,
  kind: WindowKind,
): Promise<QuotaResult> {
  const now = deps.now();
  const { id, resetAt } = windowFor(kind, now);
  if (limit <= 0) throw limitedError(kind, resetAt, now.getTime());
  try {
    const res = await deps.db.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: counterKey(scope, key, id),
        UpdateExpression: "SET #ttl = :ttl ADD #count :one",
        ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
        ExpressionAttributeNames: { "#count": "count", "#ttl": "ttl" },
        ExpressionAttributeValues: { ":one": 1, ":limit": limit, ":ttl": ttlIn(now.getTime(), RATE_TTL_SECONDS) },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    const count = Number(res.Attributes?.count ?? 1);
    return { count, limit, remaining: Math.max(0, limit - count), resetAt };
  } catch (err) {
    if (isConditionFailed(err)) throw limitedError(kind, resetAt, now.getTime());
    throw err;
  }
}

/** Uses counted so far in the current window (does not count a use). */
export async function getQuotaUsage(
  deps: DbDeps,
  scope: string,
  key: string,
  limit: number,
  kind: WindowKind,
): Promise<QuotaResult> {
  const { id, resetAt } = windowFor(kind, deps.now());
  const res = await deps.db.send(new GetCommand({ TableName: deps.tableName, Key: counterKey(scope, key, id) }));
  const count = Number(res.Item?.count ?? 0);
  return { count, limit, remaining: Math.max(0, limit - count), resetAt };
}
