import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DbDeps } from "../ports";
import { statsKey } from "./keys";

export const STAT_KEYS = [
  "users",
  "challengesStarted",
  "challengesDone",
  "verdict_continue",
  "verdict_stop",
  "verdict_modify",
  "communityRecipes",
  "stories",
  "shares",
  "pushSubscriptions",
] as const;
export type StatKey = (typeof STAT_KEYS)[number];
export type Stats = Record<StatKey, number>;

/** Atomically add (or subtract) counters on STATS/GLOBAL. Zero deltas are ignored. */
export async function bumpStats(deps: Pick<DbDeps, "db" | "tableName">, delta: Partial<Stats>): Promise<void> {
  const entries = Object.entries(delta).filter(([, v]) => typeof v === "number" && v !== 0) as [StatKey, number][];
  if (entries.length === 0) return;
  const names: Record<string, string> = {};
  const values: Record<string, number> = {};
  const parts = entries.map(([k, v], i) => {
    names[`#k${i}`] = k;
    values[`:v${i}`] = v;
    return `#k${i} :v${i}`;
  });
  await deps.db.send(
    new UpdateCommand({
      TableName: deps.tableName,
      Key: statsKey(),
      UpdateExpression: `ADD ${parts.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

export async function getStats(deps: Pick<DbDeps, "db" | "tableName">): Promise<Stats> {
  const res = await deps.db.send(new GetCommand({ TableName: deps.tableName, Key: statsKey() }));
  const item = res.Item ?? {};
  return Object.fromEntries(STAT_KEYS.map((k) => [k, Number(item[k] ?? 0)])) as Stats;
}
