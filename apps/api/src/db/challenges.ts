/**
 * Challenge items (USER#<uid> / CH#<chId>) and their cohort projection on gsi1.
 * Shared core only; the challenge routes build on these helpers.
 */
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { monthKey, type Challenge, type Stamp } from "@thirty/shared";
import type { DbDeps } from "../ports";
import { challengeKey, challengeRefKey, cohortGsi1, userPk, type Key } from "./keys";
import { isConditionFailed, queryPrefix, type Item } from "./util";

export type ChallengeItem = Key &
  Challenge & {
    type: "challenge";
    userId: string;
    /** Denormalised so the cohort list needs no second read. */
    nickname: string;
    /** Set by moderation: keeps the challenge out of the cohort list regardless of shareProgress. */
    hiddenFromCohort?: boolean;
    gsi1pk?: string;
    gsi1sk?: string;
  };

const nullableString = (v: unknown): string | null => (typeof v === "string" ? v : null);
const nullableNumber = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** Item → API shape for the owner (notes included). */
export function toChallenge(item: Item): Challenge {
  const stamps: Record<string, Stamp> = {};
  for (const [day, s] of Object.entries((item.stamps as Record<string, Partial<Stamp>> | undefined) ?? {})) {
    if (!s || typeof s.at !== "number") continue;
    stamps[day] = typeof s.note === "string" && s.note ? { at: s.at, note: s.note } : { at: s.at };
  }
  return {
    id: String(item.id),
    recipeId: nullableString(item.recipeId),
    title: String(item.title ?? ""),
    seal: String(item.seal ?? ""),
    startDate: String(item.startDate),
    status: item.status === "done" ? "done" : "active",
    stamps,
    verdict: (nullableString(item.verdict) as Challenge["verdict"]) ?? null,
    reflection: nullableString(item.reflection),
    finishedAt: nullableNumber(item.finishedAt),
    finishedDay: nullableNumber(item.finishedDay),
    cheers: Number(item.cheers ?? 0),
    shareId: nullableString(item.shareId),
    createdAt: Number(item.createdAt ?? 0),
    updatedAt: Number(item.updatedAt ?? 0),
  };
}

/** gsi1 keys that put a challenge in its month's cohort list, or null when it must stay out. */
export function cohortProjection(
  c: Pick<Challenge, "id" | "startDate" | "updatedAt"> & { hiddenFromCohort?: boolean },
  shareProgress: boolean,
): { gsi1pk: string; gsi1sk: string } | null {
  if (!shareProgress || c.hiddenFromCohort) return null;
  return cohortGsi1(monthKey(c.startDate), c.updatedAt, c.id);
}

/** Full item for a Put. */
export function toChallengeItem(
  uid: string,
  owner: { nickname: string; shareProgress: boolean },
  c: Challenge,
  extra: { hiddenFromCohort?: boolean } = {},
): ChallengeItem {
  const projection = cohortProjection({ ...c, ...extra }, owner.shareProgress);
  return {
    ...challengeKey(uid, c.id),
    type: "challenge",
    userId: uid,
    nickname: owner.nickname,
    ...c,
    ...(extra.hiddenFromCohort ? { hiddenFromCohort: true } : {}),
    ...(projection ?? {}),
  };
}

export async function getChallengeItem(deps: Pick<DbDeps, "db" | "tableName">, uid: string, chId: string): Promise<Item | undefined> {
  const res = await deps.db.send(new GetCommand({ TableName: deps.tableName, Key: challengeKey(uid, chId) }));
  return res.Item;
}

export function listChallengeItems(deps: Pick<DbDeps, "db" | "tableName">, uid: string): Promise<Item[]> {
  return queryPrefix(deps, userPk(uid), "CH#");
}

/** All of a user's challenges, newest first. */
export async function listUserChallenges(deps: Pick<DbDeps, "db" | "tableName">, uid: string): Promise<Challenge[]> {
  const items = await listChallengeItems(deps, uid);
  return items.map(toChallenge).sort((a, b) => b.createdAt - a.createdAt);
}

// ---------- CHREF (challenge id → owner) ----------

export async function getChallengeOwner(deps: Pick<DbDeps, "db" | "tableName">, chId: string): Promise<string | undefined> {
  const res = await deps.db.send(new GetCommand({ TableName: deps.tableName, Key: challengeRefKey(chId) }));
  const uid = res.Item?.userId;
  return typeof uid === "string" ? uid : undefined;
}

/** Claim a challenge id for `uid`. Returns false when the id is already taken (by anyone). */
export async function claimChallengeId(deps: Pick<DbDeps, "db" | "tableName">, chId: string, uid: string): Promise<boolean> {
  try {
    await deps.db.send(
      new PutCommand({
        TableName: deps.tableName,
        Item: { ...challengeRefKey(chId), type: "challengeRef", userId: uid },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return true;
  } catch (err) {
    if (isConditionFailed(err)) return false;
    throw err;
  }
}

// ---------- projection sync ----------

/**
 * Rewrite the denormalised nickname and the cohort projection on all of a user's challenges.
 * Called when the nickname or shareProgress changes.
 */
export async function syncUserProjection(
  deps: Pick<DbDeps, "db" | "tableName">,
  uid: string,
  owner: { nickname: string; shareProgress: boolean },
): Promise<void> {
  const items = await listChallengeItems(deps, uid);
  const update = async (item: Item) => {
    const c = toChallenge(item);
    const projection = cohortProjection({ ...c, hiddenFromCohort: item.hiddenFromCohort === true }, owner.shareProgress);
    try {
      await deps.db.send(
        new UpdateCommand({
          TableName: deps.tableName,
          Key: challengeKey(uid, c.id),
          UpdateExpression: projection
            ? "SET nickname = :n, gsi1pk = :g1pk, gsi1sk = :g1sk"
            : "SET nickname = :n REMOVE gsi1pk, gsi1sk",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeValues: projection
            ? { ":n": owner.nickname, ":g1pk": projection.gsi1pk, ":g1sk": projection.gsi1sk }
            : { ":n": owner.nickname },
        }),
      );
    } catch (err) {
      if (!isConditionFailed(err)) throw err; // deleted meanwhile
    }
  };
  for (let i = 0; i < items.length; i += 10) await Promise.all(items.slice(i, i + 10).map(update));
}
