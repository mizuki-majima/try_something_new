/**
 * Per-user locks (LOCK#<name>#<uid> / LOCK). A conditional put takes the lock; it is released in a
 * `finally`, and expires on its own after `ttlSeconds` if the process dies first (the expiry is
 * checked in the condition: DynamoDB's TTL deletion can lag by hours). gsi2 AUTHOR#<uid> so account
 * deletion finds a lock left behind.
 */
import { randomBytes } from "node:crypto";
import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { log } from "../log";
import type { DbDeps } from "../ports";
import { authorPk, lockKey, ttlIn } from "./keys";
import { isConditionFailed } from "./util";

/** Take the lock. Returns a release token, or null when someone else holds it (and it has not expired). */
export async function acquireLock(deps: DbDeps, name: string, uid: string, ttlSeconds: number): Promise<string | null> {
  const now = deps.now().getTime();
  const token = randomBytes(12).toString("base64url");
  try {
    await deps.db.send(
      new PutCommand({
        TableName: deps.tableName,
        Item: {
          ...lockKey(name, uid),
          gsi2pk: authorPk(uid),
          gsi2sk: `LOCK#${name}`,
          type: "lock",
          token,
          expiresAt: now + ttlSeconds * 1000,
          ttl: ttlIn(now, ttlSeconds),
        },
        ConditionExpression: "attribute_not_exists(pk) OR expiresAt < :now",
        ExpressionAttributeValues: { ":now": now },
      }),
    );
    return token;
  } catch (err) {
    if (isConditionFailed(err)) return null;
    throw err;
  }
}

/** Release a lock taken with acquireLock (only if it is still ours). Never throws: it expires anyway. */
export async function releaseLock(deps: DbDeps, name: string, uid: string, token: string): Promise<void> {
  try {
    await deps.db.send(
      new DeleteCommand({
        TableName: deps.tableName,
        Key: lockKey(name, uid),
        ConditionExpression: "#token = :token",
        ExpressionAttributeNames: { "#token": "token" },
        ExpressionAttributeValues: { ":token": token },
      }),
    );
  } catch (err) {
    if (!isConditionFailed(err)) log.warn("lock release failed (it expires on its own)", { lock: name, uid, err });
  }
}
