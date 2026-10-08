/**
 * Challenge items (USER#<uid> / CH#<chId>) and their cohort projection on gsi1.
 * Shared core only; the challenge routes build on these helpers.
 */
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { LIMITS, findOfficialRecipe, monthKey, type Challenge, type Stamp } from "@thirty/shared";
import type { DbDeps, Deps } from "../ports";
import { authorPk, challengeKey, challengeRefKey, cohortGsi1, recipeKey, recipeStatsKey, userPk, type Key } from "./keys";
import { isShownStamp, type StoredStamp } from "./notes";
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
    /**
     * Set by the reflection that added this challenge's verdict to STATS (verdict_*). Only then does a
     * later change of mind move the counters (NF-3): an imported record was never counted.
     */
    counted?: boolean;
    gsi1pk?: string;
    gsi1sk?: string;
  };

const nullableString = (v: unknown): string | null => (typeof v === "string" ? v : null);
const nullableNumber = (v: unknown): number | null => (typeof v === "number" ? v : null);

/**
 * Item → API shape for the owner (notes included). `shown: true` marks a note shown in 「みんな」
 * (db/notes.ts); the stored consent (`shownNote`) itself is never returned.
 */
export function toChallenge(item: Item): Challenge {
  const stamps: Record<string, Stamp> = {};
  for (const [day, s] of Object.entries((item.stamps as Record<string, Partial<StoredStamp>> | undefined) ?? {})) {
    if (!s || typeof s.at !== "number") continue;
    stamps[day] =
      typeof s.note === "string" && s.note ? { at: s.at, note: s.note, ...(isShownStamp(s) ? { shown: true } : {}) } : { at: s.at };
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

/**
 * Full item for a Put. Flags are written only when true. Stamps are written as given: a `shown` that
 * came from toChallenge is inert (only `shownNote` is consent, db/notes.ts), so a Put never shows a note.
 */
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

/**
 * `consistent`: a strongly consistent read, for an answer that must see a write of a moment ago (the
 * member route seeing an un-share at once; the owner's visibility route deciding, and saying why not).
 */
export async function getChallengeItem(
  deps: Pick<DbDeps, "db" | "tableName">,
  uid: string,
  chId: string,
  opts: { consistent?: boolean } = {},
): Promise<Item | undefined> {
  const res = await deps.db.send(
    new GetCommand({ TableName: deps.tableName, Key: challengeKey(uid, chId), ...(opts.consistent ? { ConsistentRead: true } : {}) }),
  );
  return res.Item;
}

/**
 * A user's challenge items, at most LIMITS.challengesPerUser (R15): an account cannot hold more
 * (create and import stop there), and the cap bounds the read units of GET /api/challenges, the
 * export and the reminder however large the items are.
 */
export function listChallengeItems(deps: Pick<DbDeps, "db" | "tableName">, uid: string): Promise<Item[]> {
  return queryPrefix(deps, userPk(uid), "CH#", LIMITS.challengesPerUser);
}

/**
 * The status (and any other named top-level attributes) of each of a user's challenges, without
 * the stamps and notes. Uncapped by default: syncUserProjection must see every listed item.
 */
export function listChallengeStatuses(
  deps: Pick<DbDeps, "db" | "tableName">,
  uid: string,
  more: string[] = [],
  maxItems = Infinity,
): Promise<Item[]> {
  const names: Record<string, string> = { "#s": "status" };
  more.forEach((a, i) => (names[`#a${i}`] = a));
  return queryAll(
    deps,
    {
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
      ExpressionAttributeValues: { ":pk": userPk(uid), ":sk": "CH#" },
      ProjectionExpression: ["#s", ...more.map((_, i) => `#a${i}`)].join(", "),
      ExpressionAttributeNames: names,
    },
    maxItems,
  );
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
 * Whether syncUserProjection has to write this item: its cohort projection changes, or it is listed
 * and shows an old nickname. The nickname of an item that is not listed is not shown anywhere, so it
 * is left alone (every path that lists it again writes the nickname: updateChallenge, the sync
 * itself, a moderator's restore). Imported and hidden items are never listed, so never written.
 */
export function projectionChange(
  item: Item,
  owner: { nickname: string; shareProgress: boolean },
): { projection: { gsi1pk: string; gsi1sk: string } | null } | null {
  const c = toChallenge(item);
  const projection = cohortProjection(
    { ...c, hiddenFromCohort: item.hiddenFromCohort === true, imported: item.imported === true },
    owner.shareProgress,
  );
  const listed = typeof item.gsi1pk === "string";
  if (!projection) return listed ? { projection } : null;
  const same = listed && item.gsi1pk === projection.gsi1pk && item.gsi1sk === projection.gsi1sk && item.nickname === owner.nickname;
  return same ? null : { projection };
}

/**
 * Bring the cohort projection (and the denormalised nickname of listed items) in line with the
 * owner's nickname / shareProgress. Called when one of them changes (PATCH /api/me, quota'd). Only
 * items whose public projection or listed nickname actually changes are written (cost, NF-1): a
 * nickname change while not sharing writes nothing, and imported / hidden items are never touched.
 * Returns the number of items written.
 */
export async function syncUserProjection(
  deps: Pick<DbDeps, "db" | "tableName">,
  uid: string,
  owner: { nickname: string; shareProgress: boolean },
): Promise<number> {
  const attrs = ["id", "startDate", "updatedAt", "hiddenFromCohort", "imported", "nickname", "gsi1pk", "gsi1sk"];
  const items = await listChallengeStatuses(deps, uid, attrs);
  const changes = items.flatMap((item) => {
    const change = projectionChange(item, owner);
    return change ? [{ item, projection: change.projection }] : [];
  });
  const write = async (item: Item, projection: { gsi1pk: string; gsi1sk: string } | null): Promise<boolean> => {
    try {
      await deps.db.send(
        new UpdateCommand({
          TableName: deps.tableName,
          Key: challengeKey(uid, String(item.id)),
          UpdateExpression: projection
            ? "SET nickname = :n, gsi1pk = :g1pk, gsi1sk = :g1sk"
            : "SET nickname = :n REMOVE gsi1pk, gsi1sk",
          // Write only what was read: the sort key embeds updatedAt, and an item moderation hid (or an
          // import made private) meanwhile is never listed again.
          ConditionExpression: projection
            ? "attribute_exists(pk) AND updatedAt = :u AND (attribute_not_exists(hiddenFromCohort) OR hiddenFromCohort <> :t) AND (attribute_not_exists(imported) OR imported <> :t)"
            : "attribute_exists(pk) AND updatedAt = :u",
          ExpressionAttributeValues: projection
            ? { ":n": owner.nickname, ":g1pk": projection.gsi1pk, ":g1sk": projection.gsi1sk, ":u": item.updatedAt, ":t": true }
            : { ":n": owner.nickname, ":u": item.updatedAt },
        }),
      );
      return true;
    } catch (err) {
      if (isConditionFailed(err)) return false;
      throw err;
    }
  };
  const update = async ({ item, projection }: (typeof changes)[number]) => {
    let current: Item | undefined = item;
    let next = projection;
    // Changed meanwhile (e.g. a stamp written with the profile from before this change): read it
    // again and apply the new profile, so turning sharing off never leaves an item listed.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await write(current, next)) return;
      current = (
        await deps.db.send(
          new GetCommand({
            TableName: deps.tableName,
            Key: challengeKey(uid, String(item.id)),
            ProjectionExpression: attrs.map((_, i) => `#a${i}`).join(", "),
            ExpressionAttributeNames: Object.fromEntries(attrs.map((a, i) => [`#a${i}`, a])),
          }),
        )
      ).Item;
      if (!current) return; // deleted meanwhile
      const change = projectionChange(current, owner);
      if (!change) return;
      next = change.projection;
    }
  };
  for (let i = 0; i < changes.length; i += 10) await Promise.all(changes.slice(i, i + 10).map(update));
  return changes.length;
}

// ---------- create / update / delete (routes/challenges.ts) ----------

type Owner = { nickname: string; shareProgress: boolean };

/**
 * How many challenges the user holds (`total`, counted up to LIMITS.challengesPerUser) and how many
 * are not finished yet (`open`: waiting, active, or ended but not reflected). Statuses only.
 */
export async function countChallenges(deps: Pick<DbDeps, "db" | "tableName">, uid: string): Promise<{ open: number; total: number }> {
  const items = await listChallengeStatuses(deps, uid, [], LIMITS.challengesPerUser);
  return { open: items.filter((i) => i.status !== "done").length, total: items.length };
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
  stamp?: { day: number; value: StoredStamp | null };
  /**
   * With `stamp`: the write only happens while stamps.<day>.shownNote is still what was read (null:
   * absent). A whole-stamp write planned before an un-share must not put the old consent back (#17).
   * Ignored for an item without a stamps map: it holds no consent, and the map written holds none.
   */
  expectShownNote?: string | null;
  /**
   * The write only happens while the stored item still has this status (and start date, verdict,
   * and `counted` state when given).
   */
  expect: { status: Challenge["status"]; startDate?: string; verdict?: Challenge["verdict"]; counted?: boolean };
  /** Set `counted` (the reflection that adds the verdict to STATS, in the same write). */
  markCounted?: boolean;
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
  if (u.expect.counted !== undefined || u.markCounted) {
    names["#counted"] = "counted";
    values[":true"] = true;
    if (u.expect.counted === true) conditions.push("#counted = :true");
    else if (u.expect.counted === false) conditions.push("(attribute_not_exists(#counted) OR #counted <> :true)");
    if (u.markCounted) sets.push("#counted = :true");
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
      if (u.expectShownNote !== undefined) {
        names["#sn"] = "shownNote";
        if (u.expectShownNote === null) conditions.push("attribute_not_exists(#stamps.#day.#sn)");
        else {
          values[":expectShownNote"] = u.expectShownNote;
          conditions.push("#stamps.#day.#sn = :expectShownNote");
        }
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

/**
 * Show a day note in 「みんな」 (`note`: stamps.<day>.shownNote = the text the owner confirmed) or stop
 * showing it (null: shownNote removed). The only write of `shownNote` (db/notes.ts). Its own update,
 * not updateChallenge: it never touches updatedAt, the cohort projection, the nickname or `imported`,
 * so the member neither moves up the list nor shows new activity, and an import stays private.
 *
 * Showing is conditioned on the stored note still being `note` and the challenge not being hidden by
 * moderation or imported; stopping only on the stamp existing. Returns the updated challenge, or null
 * when a condition failed (the caller reads again to say why).
 */
export async function setStampShown(
  deps: Pick<DbDeps, "db" | "tableName">,
  uid: string,
  chId: string,
  day: number,
  note: string | null,
): Promise<Challenge | null> {
  const names: Record<string, string> = { "#stamps": "stamps", "#day": String(day), "#sn": "shownNote" };
  try {
    const res = await deps.db.send(
      new UpdateCommand(
        note === null
          ? {
              TableName: deps.tableName,
              Key: challengeKey(uid, chId),
              UpdateExpression: "REMOVE #stamps.#day.#sn",
              ConditionExpression: "attribute_exists(#stamps.#day)",
              ExpressionAttributeNames: names,
              ReturnValues: "ALL_NEW",
            }
          : {
              TableName: deps.tableName,
              Key: challengeKey(uid, chId),
              UpdateExpression: "SET #stamps.#day.#sn = :note",
              ConditionExpression:
                "attribute_exists(pk) AND #stamps.#day.#note = :note AND (attribute_not_exists(#hidden) OR #hidden <> :true) AND (attribute_not_exists(#imported) OR #imported <> :true)",
              ExpressionAttributeNames: { ...names, "#note": "note", "#hidden": "hiddenFromCohort", "#imported": "imported" },
              ExpressionAttributeValues: { ":note": note, ":true": true },
              ReturnValues: "ALL_NEW",
            },
      ),
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
