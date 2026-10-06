import { randomBytes } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_TIMEZONE, TRANSFER_CODE_TTL_MINUTES, newId, type Reminder, type User } from "@thirty/shared";
import type { DbDeps } from "../ports";
import { tokenKey, tokenRefKey, transferKey, transferRefKey, ttlIn, userKey, userPk } from "./keys";
import { batchDelete, isConditionFailed, keyOf, queryPrefix, type Item } from "./util";

export const DEFAULT_NICKNAME = "名無し";
export const DEFAULT_REMINDER: Reminder = { enabled: false, time: "21:00" };

export function toUser(item: Item): User {
  const reminder = item.reminder as Partial<Reminder> | undefined;
  return {
    id: String(item.id),
    nickname: typeof item.nickname === "string" ? item.nickname : DEFAULT_NICKNAME,
    tz: typeof item.tz === "string" ? item.tz : DEFAULT_TIMEZONE,
    shareProgress: item.shareProgress !== false,
    reminder: {
      enabled: reminder?.enabled === true,
      time: typeof reminder?.time === "string" ? reminder.time : DEFAULT_REMINDER.time,
    },
    createdAt: Number(item.createdAt ?? 0),
  };
}

export async function getUser(deps: DbDeps, uid: string): Promise<User | undefined> {
  const res = await deps.db.send(new GetCommand({ TableName: deps.tableName, Key: userKey(uid) }));
  return res.Item ? toUser(res.Item) : undefined;
}

export async function createUser(deps: DbDeps, input: { nickname?: string; tz: string }): Promise<User> {
  const now = deps.now().getTime();
  const user: User = {
    id: newId(16),
    nickname: input.nickname || DEFAULT_NICKNAME,
    tz: input.tz,
    shareProgress: true,
    reminder: { ...DEFAULT_REMINDER },
    createdAt: now,
  };
  await deps.db.send(
    new PutCommand({
      TableName: deps.tableName,
      Item: { ...userKey(user.id), type: "user", ...user, updatedAt: now },
      ConditionExpression: "attribute_not_exists(pk)",
    }),
  );
  return user;
}

export type UserPatch = Partial<Pick<User, "nickname" | "tz" | "shareProgress" | "reminder">>;

/** Returns the updated user, or undefined when the user does not exist. */
export async function updateUser(deps: DbDeps, uid: string, patch: UserPatch): Promise<User | undefined> {
  const names: Record<string, string> = { "#updatedAt": "updatedAt" };
  const values: Record<string, unknown> = { ":updatedAt": deps.now().getTime() };
  const sets = ["#updatedAt = :updatedAt"];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    sets.push(`#${k} = :${k}`);
  }
  try {
    const res = await deps.db.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: userKey(uid),
        UpdateExpression: `SET ${sets.join(", ")}`,
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      }),
    );
    return res.Attributes ? toUser(res.Attributes) : undefined;
  } catch (err) {
    if (isConditionFailed(err)) return undefined;
    throw err;
  }
}

// ---------- tokens ----------

/** Store a token (by its SHA-256) for `uid`, plus the reverse reference used by account deletion. */
export async function putToken(deps: DbDeps, uid: string, tokenHash: string): Promise<void> {
  const now = deps.now().getTime();
  await deps.db.send(
    new PutCommand({
      TableName: deps.tableName,
      Item: { ...tokenKey(tokenHash), type: "token", userId: uid, createdAt: now },
      ConditionExpression: "attribute_not_exists(pk)",
    }),
  );
  await deps.db.send(
    new PutCommand({ TableName: deps.tableName, Item: { ...tokenRefKey(uid, tokenHash), type: "tokenRef", createdAt: now } }),
  );
}

export async function getTokenOwner(deps: Pick<DbDeps, "db" | "tableName">, tokenHash: string): Promise<string | undefined> {
  const res = await deps.db.send(new GetCommand({ TableName: deps.tableName, Key: tokenKey(tokenHash) }));
  const uid = res.Item?.userId;
  return typeof uid === "string" ? uid : undefined;
}

// ---------- transfer codes ----------

/** No 0/O/1/I: the code is read off one screen and typed on another. 32 symbols = 5 bits each. */
export const TRANSFER_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const TRANSFER_CODE_LENGTH = 8;

export function newTransferCode(): string {
  const bytes = randomBytes(TRANSFER_CODE_LENGTH);
  let out = "";
  for (const b of bytes) out += TRANSFER_ALPHABET[b & 31];
  return out;
}

/** Issue a one-time code for `uid`. Earlier codes of the same user are revoked. */
export async function createTransferCode(deps: DbDeps, uid: string): Promise<{ code: string; expiresAt: number }> {
  const old = await queryPrefix(deps, userPk(uid), "TRANSFER#");
  if (old.length > 0) {
    await batchDelete(deps, [...old.map(keyOf), ...old.map((i) => transferKey(String(i.sk).slice("TRANSFER#".length)))]);
  }
  const now = deps.now().getTime();
  const expiresAt = now + TRANSFER_CODE_TTL_MINUTES * 60_000;
  const ttl = ttlIn(now, TRANSFER_CODE_TTL_MINUTES * 60);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newTransferCode();
    try {
      await deps.db.send(
        new PutCommand({
          TableName: deps.tableName,
          Item: { ...transferKey(code), type: "transfer", userId: uid, expiresAt, ttl },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    } catch (err) {
      if (isConditionFailed(err)) continue;
      throw err;
    }
    await deps.db.send(
      new PutCommand({ TableName: deps.tableName, Item: { ...transferRefKey(uid, code), type: "transferRef", expiresAt, ttl } }),
    );
    return { code, expiresAt };
  }
  throw new Error("could not allocate a transfer code");
}

/**
 * Consume a code. The delete is the claim, so two devices racing for the same code cannot
 * both win. Returns the owner, or undefined for unknown / expired codes.
 */
export async function redeemTransferCode(deps: DbDeps, code: string): Promise<string | undefined> {
  const res = await deps.db.send(new DeleteCommand({ TableName: deps.tableName, Key: transferKey(code), ReturnValues: "ALL_OLD" }));
  const item = res.Attributes;
  if (!item || typeof item.userId !== "string") return undefined;
  await deps.db.send(new DeleteCommand({ TableName: deps.tableName, Key: transferRefKey(item.userId, code) }));
  // DynamoDB TTL deletes lazily (up to days later), so expiry is checked here.
  if (Number(item.expiresAt) <= deps.now().getTime()) return undefined;
  return item.userId;
}
