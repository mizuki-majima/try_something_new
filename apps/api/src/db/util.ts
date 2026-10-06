import { BatchWriteCommand, QueryCommand, type QueryCommandInput } from "@aws-sdk/lib-dynamodb";
import type { DbDeps } from "../ports";
import type { Key } from "./keys";

export type Item = Record<string, unknown>;

/** Query every page. Use only for partitions known to stay small (one user's items, a recipe's stories). */
export async function queryAll(deps: Pick<DbDeps, "db" | "tableName">, input: Omit<QueryCommandInput, "TableName">): Promise<Item[]> {
  const items: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await deps.db.send(new QueryCommand({ ...input, TableName: deps.tableName, ExclusiveStartKey: start }));
    items.push(...((res.Items ?? []) as Item[]));
    start = res.LastEvaluatedKey;
  } while (start);
  return items;
}

/** All items of a partition whose sort key starts with `skPrefix`. */
export function queryPrefix(deps: Pick<DbDeps, "db" | "tableName">, pk: string, skPrefix: string): Promise<Item[]> {
  return queryAll(deps, {
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
    ExpressionAttributeValues: { ":pk": pk, ":sk": skPrefix },
  });
}

export function keyOf(item: Item): Key {
  return { pk: String(item.pk), sk: String(item.sk) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** BatchWrite deletes in chunks of 25, retrying UnprocessedItems with backoff. Duplicate keys are dropped. */
export async function batchDelete(deps: Pick<DbDeps, "db" | "tableName">, keys: Key[]): Promise<void> {
  const unique = new Map(keys.map((k) => [JSON.stringify([k.pk, k.sk]), k] as const));
  const all = [...unique.values()];
  for (let i = 0; i < all.length; i += 25) {
    let requests = all.slice(i, i + 25).map((k) => ({ DeleteRequest: { Key: { pk: k.pk, sk: k.sk } } }));
    for (let attempt = 0; requests.length > 0; attempt++) {
      if (attempt >= 8) throw new Error("batchDelete: unprocessed items remained after retries");
      if (attempt > 0) await sleep(Math.min(1000, 50 * 2 ** attempt));
      const res = await deps.db.send(new BatchWriteCommand({ RequestItems: { [deps.tableName]: requests } }));
      requests = (res.UnprocessedItems?.[deps.tableName] ?? []) as typeof requests;
    }
  }
}

export function isConditionFailed(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "ConditionalCheckFailedException";
}
