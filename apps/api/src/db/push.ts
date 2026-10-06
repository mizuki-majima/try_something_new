/**
 * Push subscription items (USER#<uid> / PUSH#<sha256(endpoint)>). The reminder scheduler finds
 * them through gsi3 SLOT#<HH:MM UTC>, which is present only while the user's reminder is on.
 */
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DbDeps } from "../ports";
import { pushKey, pushSlotGsi3, userPk } from "./keys";
import { isConditionFailed, queryPrefix, type Item } from "./util";

export function listPushItems(deps: Pick<DbDeps, "db" | "tableName">, uid: string): Promise<Item[]> {
  return queryPrefix(deps, userPk(uid), "PUSH#");
}

/** Put all of a user's subscriptions on `slot` ("HH:MM" UTC), or take them off the schedule (null). */
export async function updateUserSlots(deps: Pick<DbDeps, "db" | "tableName">, uid: string, slot: string | null): Promise<void> {
  const items = await listPushItems(deps, uid);
  await Promise.all(
    items.map(async (item) => {
      const hash = String(item.sk).slice("PUSH#".length);
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
