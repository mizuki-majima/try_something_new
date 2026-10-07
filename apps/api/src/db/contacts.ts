/**
 * Contact form messages (CONTACT#<id> / META, gsi1 CONTACTS / <createdAt13>), FR-19.
 * Kept 180 days (TTL). The sender's account is not linked: no user id is stored.
 */
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { newId, type AdminContactItem } from "@thirty/shared";
import type { DbDeps } from "../ports";
import { contactKey, contactListGsi1, ttlIn } from "./keys";
import { GSI1 } from "./table";
import type { Item } from "./util";

export const CONTACT_RETENTION_DAYS = 180;
export const MAX_LISTED_CONTACTS = 100;

export async function createContact(deps: DbDeps, input: { message: string; replyTo?: string }): Promise<string> {
  const now = deps.now().getTime();
  const id = newId(16);
  await deps.db.send(
    new PutCommand({
      TableName: deps.tableName,
      Item: {
        ...contactKey(id),
        ...contactListGsi1(now),
        type: "contact",
        id,
        message: input.message,
        replyTo: input.replyTo ? input.replyTo : null,
        createdAt: now,
        ttl: ttlIn(now, CONTACT_RETENTION_DAYS * 86_400),
      },
      ConditionExpression: "attribute_not_exists(pk)",
    }),
  );
  return id;
}

function toContact(item: Item): AdminContactItem {
  return {
    id: String(item.id),
    message: String(item.message ?? ""),
    replyTo: typeof item.replyTo === "string" && item.replyTo ? item.replyTo : null,
    createdAt: Number(item.createdAt ?? 0),
  };
}

/** Newest first. TTL deletion is lazy (and absent locally), so expired items are skipped here. */
export async function listContacts(deps: DbDeps, max = MAX_LISTED_CONTACTS): Promise<AdminContactItem[]> {
  const nowSec = Math.floor(deps.now().getTime() / 1000);
  const out: AdminContactItem[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await deps.db.send(
      new QueryCommand({
        TableName: deps.tableName,
        IndexName: GSI1,
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": "CONTACTS" },
        ScanIndexForward: false,
        Limit: 100,
        ExclusiveStartKey: start,
      }),
    );
    for (const item of (res.Items ?? []) as Item[]) {
      if (typeof item.ttl === "number" && item.ttl <= nowSec) continue;
      out.push(toContact(item));
      if (out.length >= max) return out;
    }
    start = res.LastEvaluatedKey;
  } while (start);
  return out;
}
