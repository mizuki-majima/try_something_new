/**
 * Push subscription items (USER#<uid> / PUSH#<sha256(endpoint)>). The reminder scheduler finds
 * them through gsi3 SLOT#<HH:MM UTC>, which is present only while the user's reminder is on.
 * They live in the user's own partition, so account deletion removes them with the user.
 */
import { createHash } from "node:crypto";
import { DeleteCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { utcSlotFor, type User } from "@thirty/shared";
import { log } from "../log";
import type { DbDeps, Deps, PushTarget } from "../ports";
import { pushKey, pushSlotGsi3, slotPk, userPk } from "./keys";
import { bumpStats } from "./stats";
import { GSI3 } from "./table";
import { isConditionFailed, queryPrefix, type Item } from "./util";

/** Subscriptions kept per user (devices / browsers). The least recently registered one is dropped. */
export const MAX_PUSH_SUBSCRIPTIONS = 5;

type TableDeps = Pick<DbDeps, "db" | "tableName">;

/** The UTC slot ("HH:MM") the user's reminder fires on, or null when reminders are off. */
export function reminderSlot(user: Pick<User, "tz" | "reminder">, now: Date): string | null {
  return user.reminder.enabled ? utcSlotFor(user.reminder.time, user.tz, now) : null;
}

/** Item key suffix for an endpoint. The endpoint itself is stored only inside the item. */
export function pushHash(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

export const pushHashOf = (item: Item): string => String(item.sk).slice("PUSH#".length);

/** Stored item → what the sender needs (undefined for a malformed item). */
export function toPushTarget(item: Item): PushTarget | undefined {
  const keys = item.keys as { p256dh?: unknown; auth?: unknown } | undefined;
  if (typeof item.endpoint !== "string" || typeof keys?.p256dh !== "string" || typeof keys?.auth !== "string") return undefined;
  return { endpoint: item.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

export function listPushItems(deps: TableDeps, uid: string): Promise<Item[]> {
  return queryPrefix(deps, userPk(uid), "PUSH#");
}

/** Put all of a user's subscriptions on `slot` ("HH:MM" UTC), or take them off the schedule (null). */
export async function updateUserSlots(deps: TableDeps, uid: string, slot: string | null): Promise<void> {
  const items = await listPushItems(deps, uid);
  await Promise.all(
    items.map(async (item) => {
      const hash = pushHashOf(item);
      const gsi = slot ? pushSlotGsi3(slot, uid, hash) : null;
      try {
        await deps.db.send(
          new UpdateCommand({
            TableName: deps.tableName,
            Key: pushKey(uid, hash),
            UpdateExpression: gsi ? "SET gsi3pk = :pk, gsi3sk = :sk" : "REMOVE gsi3pk, gsi3sk",
            ConditionExpression: "attribute_exists(pk)",
            ExpressionAttributeValues: gsi ? { ":pk": gsi.gsi3pk, ":sk": gsi.gsi3sk } : undefined,
          }),
        );
      } catch (err) {
        if (!isConditionFailed(err)) throw err; // unsubscribed meanwhile
      }
    }),
  );
}

/**
 * Create or refresh a subscription (same endpoint = same item; keys may have rotated).
 * `slot` is the user's current reminder slot, or null while reminders are off.
 * Returns whether the item is new (STATS pushSubscriptions is bumped here for new ones).
 */
export async function savePushSubscription(
  deps: DbDeps,
  uid: string,
  sub: PushTarget,
  slot: string | null,
): Promise<{ hash: string; created: boolean }> {
  const hash = pushHash(sub.endpoint);
  const now = deps.now().getTime();
  const names: Record<string, string> = {
    "#type": "type",
    "#endpoint": "endpoint",
    "#keys": "keys",
    "#createdAt": "createdAt",
    "#updatedAt": "updatedAt",
  };
  const values: Record<string, unknown> = {
    ":type": "push",
    ":endpoint": sub.endpoint,
    ":keys": { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    ":now": now,
  };
  const sets = ["#type = :type", "#endpoint = :endpoint", "#keys = :keys", "#createdAt = if_not_exists(#createdAt, :now)", "#updatedAt = :now"];
  let expr: string;
  if (slot) {
    const gsi = pushSlotGsi3(slot, uid, hash);
    values[":g3pk"] = gsi.gsi3pk;
    values[":g3sk"] = gsi.gsi3sk;
    sets.push("gsi3pk = :g3pk", "gsi3sk = :g3sk");
    expr = `SET ${sets.join(", ")}`;
  } else {
    expr = `SET ${sets.join(", ")} REMOVE gsi3pk, gsi3sk`;
  }
  const res = await deps.db.send(
    new UpdateCommand({
      TableName: deps.tableName,
      Key: pushKey(uid, hash),
      UpdateExpression: expr,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_OLD",
    }),
  );
  const created = !res.Attributes;
  if (created) await bumpStats(deps, { pushSubscriptions: 1 });
  return { hash, created };
}

/** Delete one subscription. Returns whether it existed (STATS pushSubscriptions -1 when it did). */
export async function deletePushSubscription(deps: TableDeps, uid: string, hash: string): Promise<boolean> {
  const res = await deps.db.send(
    new DeleteCommand({ TableName: deps.tableName, Key: pushKey(uid, hash), ReturnValues: "ALL_OLD" }),
  );
  if (!res.Attributes) return false;
  await bumpStats(deps, { pushSubscriptions: -1 });
  return true;
}

/** Keep at most MAX_PUSH_SUBSCRIPTIONS, dropping the least recently registered (never `keepHash`). */
export async function prunePushSubscriptions(deps: TableDeps, uid: string, keepHash: string): Promise<number> {
  const items = await listPushItems(deps, uid);
  if (items.length <= MAX_PUSH_SUBSCRIPTIONS) return 0;
  const age = (i: Item) => Number(i.updatedAt ?? i.createdAt ?? 0);
  const candidates = items
    .filter((i) => pushHashOf(i) !== keepHash)
    .sort((a, b) => age(a) - age(b) || String(a.sk).localeCompare(String(b.sk)));
  let removed = 0;
  for (const item of candidates.slice(0, items.length - MAX_PUSH_SUBSCRIPTIONS)) {
    if (await deletePushSubscription(deps, uid, pushHashOf(item))) removed++;
  }
  return removed;
}

/** Subscriptions on a reminder slot, at most `cap` (gsi3 is ordered by "<uid>#<hash>"). */
export async function listSlotSubscriptions(deps: TableDeps, slot: string, cap: number): Promise<{ items: Item[]; capped: boolean }> {
  const items: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await deps.db.send(
      new QueryCommand({
        TableName: deps.tableName,
        IndexName: GSI3,
        KeyConditionExpression: "gsi3pk = :pk",
        ExpressionAttributeValues: { ":pk": slotPk(slot) },
        Limit: Math.min(500, cap - items.length + 1),
        ExclusiveStartKey: start,
      }),
    );
    items.push(...((res.Items ?? []) as Item[]));
    start = res.LastEvaluatedKey;
  } while (start && items.length <= cap);
  const capped = items.length > cap;
  return { items: capped ? items.slice(0, cap) : items, capped };
}

export type DeliveryResult = { sent: number; failed: number; gone: number };

/**
 * Send `payload` to each of a user's subscription items. Subscriptions the push service reports as
 * gone (404/410) are deleted. Never throws for a single subscription.
 */
export async function deliverToSubscriptions(
  deps: Pick<Deps, "db" | "tableName" | "push">,
  uid: string,
  items: Item[],
  payload: object,
): Promise<DeliveryResult> {
  const result: DeliveryResult = { sent: 0, failed: 0, gone: 0 };
  await Promise.all(
    items.map(async (item) => {
      const target = toPushTarget(item);
      if (!target) {
        result.failed++;
        return;
      }
      let res: { ok: boolean; gone: boolean };
      try {
        res = await deps.push.send(target, payload);
      } catch (err) {
        log.warn("push: sender threw", { uid, errName: (err as Error | undefined)?.name });
        res = { ok: false, gone: false };
      }
      if (res.gone) {
        result.gone++;
        try {
          await deletePushSubscription(deps, uid, pushHashOf(item));
        } catch (err) {
          log.warn("push: could not delete a gone subscription", { uid, errName: (err as Error | undefined)?.name });
        }
      } else if (res.ok) {
        result.sent++;
      } else {
        result.failed++;
      }
    }),
  );
  return result;
}
