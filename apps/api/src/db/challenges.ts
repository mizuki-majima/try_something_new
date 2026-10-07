/**
 * Challenge items (USER#<uid> / CH#<chId>) and their cohort projection on gsi1.
 * Shared core only; the challenge routes build on these helpers.
 */
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { findOfficialRecipe, monthKey, type Challenge, type Stamp } from "@thirty/shared";
import type { DbDeps, Deps } from "../ports";
import { authorPk, challengeKey, challengeRefKey, cohortGsi1, recipeKey, recipeStatsKey, userPk, type Key } from "./keys";
import { deleteShare, getShareItem } from "./shares";
import { isConditionFailed, queryAll, queryPrefix, type Item } from "./util";

export type ChallengeItem = Key &
  Challenge & {
    type: "challenge";
    userId: string;
    /** Denormalised so the cohort list needs no second read. */
    nickname: string;
    /** Set by moderation: keeps the challenge out of the cohort list regardless of shareProgress. */
    hiddenFromCohort?: boolean;
    /** Set by moderation when it hid or deleted this challenge's card: no new card (POST /api/shares 403). */
    moderated?: boolean;
    /**
     * Written by a backup import: private (no cohort projection) and left out of the PILOT metrics
     * until the owner stamps or edits it the normal way (updateChallenge clears it).
     */
    imported?: boolean;
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
  c: Pick<Challenge, "id" | "startDate" | "updatedAt"> & { hiddenFromCohort?: boolean; imported?: boolean },
  shareProgress: boolean,
): { gsi1pk: string; gsi1sk: string } | null {
  if (!shareProgress || c.hiddenFromCohort || c.imported) return null;
  return cohortGsi1(monthKey(c.startDate), c.updatedAt, c.id);
}

export type ChallengeFlags = { hiddenFromCohort?: boolean; moderated?: boolean; imported?: boolean };

/** Full item for a Put. Flags are written only when true. */
export function toChallengeItem(
  uid: string,
  owner: { nickname: string; shareProgress: boolean },
  c: Challenge,
  extra: ChallengeFlags = {},
): ChallengeItem {
  const projection = cohortProjection({ ...c, ...extra }, owner.shareProgress);
  return {
    ...challengeKey(uid, c.id),
    type: "challenge",
    userId: uid,
    nickname: owner.nickname,
    ...c,
    ...(extra.hiddenFromCohort ? { hiddenFromCohort: true } : {}),
    ...(extra.moderated ? { moderated: true } : {}),
    ...(extra.imported ? { imported: true } : {}),
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

/** The status of each of a user's challenges (only that attribute is read). */
export function listChallengeStatuses(deps: Pick<DbDeps, "db" | "tableName">, uid: string): Promise<Item[]> {
  return queryAll(deps, {
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
    ExpressionAttributeValues: { ":pk": userPk(uid), ":sk": "CH#" },
    ProjectionExpression: "#s",
    ExpressionAttributeNames: { "#s": "status" },
  });
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

/**
 * Claim a challenge id for `uid`. Returns false when the id is already taken (by anyone).
 * The ref sits outside USER#<uid>, so it carries gsi2 AUTHOR#<uid>: account deletion finds it even
 * when the challenge item itself was never written (a create that failed half-way).
 */
export async function claimChallengeId(deps: Pick<DbDeps, "db" | "tableName">, chId: string, uid: string): Promise<boolean> {
  try {
    await deps.db.send(
      new PutCommand({
        TableName: deps.tableName,
        Item: { ...challengeRefKey(chId), gsi2pk: authorPk(uid), gsi2sk: `CHREF#${chId}`, type: "challengeRef", userId: uid },
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
    const projection = cohortProjection(
      { ...c, hiddenFromCohort: item.hiddenFromCohort === true, imported: item.imported === true },
      owner.shareProgress,
    );
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

// ---------- create / update / delete (routes/challenges.ts) ----------

type Owner = { nickname: string; shareProgress: boolean };

/** Challenges that are not finished yet (waiting, active, or ended but not reflected). */
export async function countOpenChallenges(deps: Pick<DbDeps, "db" | "tableName">, uid: string): Promise<number> {
  const items = await listChallengeItems(deps, uid);
  return items.filter((i) => i.status !== "done").length;
}

/** Put a new challenge. Returns false when the item already exists (a concurrent replay of the same create). */
export async function putNewChallenge(deps: Pick<DbDeps, "db" | "tableName">, uid: string, owner: Owner, c: Challenge): Promise<boolean> {
  try {
    await deps.db.send(
      new PutCommand({
        TableName: deps.tableName,
        Item: toChallengeItem(uid, owner, c),
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return true;
  } catch (err) {
    if (isConditionFailed(err)) return false;
    throw err;
  }
}

/** An official recipe, or a community recipe that is currently published. */
export async function isKnownRecipe(deps: Pick<DbDeps, "db" | "tableName">, rid: string): Promise<boolean> {
  if (findOfficialRecipe(rid)) return true;
  const res = await deps.db.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: recipeKey(rid),
      ProjectionExpression: "#s",
      ExpressionAttributeNames: { "#s": "status" },
    }),
  );
  return res.Item?.status === "published";
}

/** RSTATS/<rid> startCount += 1 (official and community recipes alike; db/recipes.ts reads it). */
export async function bumpRecipeStarts(deps: Pick<DbDeps, "db" | "tableName">, rid: string): Promise<void> {
  await deps.db.send(
    new UpdateCommand({
      TableName: deps.tableName,
      Key: recipeStatsKey(rid),
      UpdateExpression: "ADD startCount :one",
      ExpressionAttributeValues: { ":one": 1 },
    }),
  );
}

export type ChallengeUpdate = {
  /** The signed-in owner: nickname is re-denormalised, shareProgress decides the cohort projection. */
  owner: Owner;
  now: number;
  /** Top-level attributes to SET (undefined is skipped, null is stored as null). */
  set?: Partial<Pick<Challenge, "title" | "seal" | "startDate" | "status" | "verdict" | "reflection" | "finishedAt" | "finishedDay">>;
  /** stamps.<day>: write this stamp, or remove it (null). */
  stamp?: { day: number; value: Stamp | null };
  /** The write only happens while the stored item still has this status (and start date, verdict). */
  expect: { status: Challenge["status"]; startDate?: string; verdict?: Challenge["verdict"] };
  /**
   * Keep a backup import's `imported` flag (and so its privacy). Every other write is the owner
   * using the challenge the normal way, which clears the flag.
   */
  keepImported?: boolean;
};

/**
 * Conditional partial update of a challenge the caller has just read (`current`). Always bumps
 * updatedAt and re-syncs the cohort projection (gsi1 ordered by latest activity; the month follows
 * startDate). Only the named attributes are written, so concurrent cheers (ADD cheers) are never lost.
 * Clears a backup import's `imported` flag unless `keepImported`.
 * Returns the updated challenge, or null when a condition failed (re-read and decide again).
 */
export async function updateChallenge(
  deps: Pick<DbDeps, "db" | "tableName">,
  uid: string,
  current: Item,
  u: ChallengeUpdate,
): Promise<Challenge | null> {
  const id = String(current.id);
  const names: Record<string, string> = { "#status": "status", "#updatedAt": "updatedAt", "#nickname": "nickname" };
  const values: Record<string, unknown> = { ":expectStatus": u.expect.status, ":now": u.now, ":nickname": u.owner.nickname };
  const sets = ["#updatedAt = :now", "#nickname = :nickname"];
  const removes: string[] = [];
  const conditions = ["attribute_exists(pk)", "#status = :expectStatus"];

  for (const [k, v] of Object.entries(u.set ?? {})) {
    if (v === undefined) continue;
    names[`#${k}`] = k;
    values[`:set_${k}`] = v;
    sets.push(`#${k} = :set_${k}`);
  }
  if (u.expect.startDate !== undefined) {
    names["#startDate"] = "startDate";
    values[":expectStart"] = u.expect.startDate;
    conditions.push("#startDate = :expectStart");
  }
  if (u.expect.verdict !== undefined) {
    names["#verdict"] = "verdict";
    values[":expectVerdict"] = u.expect.verdict;
    conditions.push("#verdict = :expectVerdict");
  }
  const imported = u.keepImported === true && current.imported === true;
  if (!imported) {
    names["#imported"] = "imported";
    removes.push("#imported");
  }
  if (u.stamp) {
    names["#stamps"] = "stamps";
    const hasMap = typeof current.stamps === "object" && current.stamps !== null;
    if (hasMap) {
      names["#day"] = String(u.stamp.day);
      if (u.stamp.value) {
        values[":stamp"] = u.stamp.value;
        sets.push("#stamps.#day = :stamp");
      } else {
        removes.push("#stamps.#day");
      }
    } else {
      // Legacy item without a stamps map: a nested path cannot be written, so write the whole map.
      values[":stamps"] = u.stamp.value ? { [String(u.stamp.day)]: u.stamp.value } : {};
      sets.push("#stamps = :stamps");
    }
  }

  const startDate = u.set?.startDate ?? String(current.startDate);
  const projection = cohortProjection(
    { id, startDate, updatedAt: u.now, hiddenFromCohort: current.hiddenFromCohort === true, imported },
    u.owner.shareProgress,
  );
  names["#g1pk"] = "gsi1pk";
  names["#g1sk"] = "gsi1sk";
  if (projection) {
    values[":g1pk"] = projection.gsi1pk;
    values[":g1sk"] = projection.gsi1sk;
    sets.push("#g1pk = :g1pk", "#g1sk = :g1sk");
    // Moderation may hide it between our read and this write: never put it back in the list.
    names["#hidden"] = "hiddenFromCohort";
    values[":true"] = true;
    conditions.push("(attribute_not_exists(#hidden) OR #hidden <> :true)");
  } else {
    removes.push("#g1pk", "#g1sk");
  }

  try {
    const res = await deps.db.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: challengeKey(uid, id),
        UpdateExpression: `SET ${sets.join(", ")}${removes.length ? ` REMOVE ${removes.join(", ")}` : ""}`,
        ConditionExpression: conditions.join(" AND "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      }),
    );
    return res.Attributes ? toChallenge(res.Attributes) : null;
  } catch (err) {
    if (isConditionFailed(err)) return null;
    throw err;
  }
}

/** Delete the owner's public card `sid` (item + image). Not found or someone else's: nothing to do. */
async function deleteOwnShare(deps: Pick<Deps, "db" | "tableName" | "media">, uid: string, sid: unknown): Promise<string | null> {
  if (typeof sid !== "string" || !sid) return null;
  const share = await getShareItem(deps, sid);
  if (share && share.userId === uid) await deleteShare(deps, share);
  return sid;
}

/**
 * Delete a challenge, its public share card (item + image) and its CHREF. Returns false when the
 * user has no such challenge.
 *
 * The card goes first: if removing it fails, the challenge is still there and the request can be
 * retried (deleting the challenge first would leave a public card nobody can reach to remove).
 * A card created between that and the challenge delete is caught from the deleted item's shareId.
 * The CHREF is removed whenever it belongs to `uid`, so a retry cleans up after a half-done delete.
 */
export async function deleteChallenge(deps: Pick<Deps, "db" | "tableName" | "media">, uid: string, chId: string): Promise<boolean> {
  const current = await getChallengeItem(deps, uid, chId);
  const removedShare = current ? await deleteOwnShare(deps, uid, current.shareId) : null;
  const res = await deps.db.send(
    new DeleteCommand({ TableName: deps.tableName, Key: challengeKey(uid, chId), ReturnValues: "ALL_OLD" }),
  );
  if (res.Attributes?.shareId !== removedShare) await deleteOwnShare(deps, uid, res.Attributes?.shareId);
  try {
    await deps.db.send(
      new DeleteCommand({
        TableName: deps.tableName,
        Key: challengeRefKey(chId),
        ConditionExpression: "userId = :uid",
        ExpressionAttributeValues: { ":uid": uid },
      }),
    );
  } catch (err) {
    if (!isConditionFailed(err)) throw err; // not ours (or already gone)
  }
  return res.Attributes !== undefined;
}

/** cheers += 1 on the owner's challenge. Returns the new count, or undefined when it no longer exists. */
export async function addCheer(deps: Pick<DbDeps, "db" | "tableName">, ownerUid: string, chId: string): Promise<number | undefined> {
  try {
    const res = await deps.db.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: challengeKey(ownerUid, chId),
        UpdateExpression: "ADD cheers :one",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeValues: { ":one": 1 },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return Number(res.Attributes?.cheers ?? 0);
  } catch (err) {
    if (isConditionFailed(err)) return undefined;
    throw err;
  }
}
