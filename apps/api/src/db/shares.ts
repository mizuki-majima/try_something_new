/**
 * Public share cards (SHARE#<sid> / META + media "share/<sid>.png"), FR-7.
 * The item holds only the denormalised public fields of the challenge (no notes, no stamps);
 * the owner's id is kept for authorisation and account deletion (gsi2 AUTHOR#<uid>) but is never returned.
 */
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { VERDICT_KEYS, newId, type Challenge, type User, type Verdict } from "@thirty/shared";
import { log } from "../log";
import type { Deps } from "../ports";
import { challengeKey, shareAuthorGsi2, shareKey, shareMediaKey, statsKey } from "./keys";
import type { PublicStatus } from "./recipes";
import { isConditionFailed, type Item } from "./util";

type D = Pick<Deps, "db" | "tableName">;

/** What the public page (/s/:id) may show. */
export type ShareView = {
  id: string;
  nickname: string;
  title: string;
  seal: string;
  verdict: Verdict | null;
  days: number;
  reflection: string | null;
  startDate: string;
  recipeId: string | null;
  createdAt: number;
  status: PublicStatus;
};

export function toShareView(item: Item): ShareView {
  return {
    id: String(item.id),
    nickname: String(item.nickname ?? ""),
    title: String(item.title ?? ""),
    seal: String(item.seal ?? ""),
    verdict: (VERDICT_KEYS as readonly unknown[]).includes(item.verdict) ? (item.verdict as Verdict) : null,
    days: Number(item.days ?? 0),
    reflection: typeof item.reflection === "string" && item.reflection ? item.reflection : null,
    startDate: String(item.startDate ?? ""),
    recipeId: typeof item.recipeId === "string" ? item.recipeId : null,
    createdAt: Number(item.createdAt ?? 0),
    status: item.status === "hidden" ? "hidden" : "published",
  };
}

export async function getShareItem(deps: D, sid: string): Promise<Item | undefined> {
  const res = await deps.db.send(new GetCommand({ TableName: deps.tableName, Key: shareKey(sid) }));
  return res.Item;
}

/**
 * Store the image and the item, point the challenge at the new card and drop the previous card.
 * Returns undefined when the challenge disappeared meanwhile (nothing is left behind).
 */
export async function createShare(deps: Deps, user: User, challenge: Challenge, png: Uint8Array): Promise<string | undefined> {
  const now = deps.now().getTime();
  const id = newId(16);
  await deps.media.put(shareMediaKey(id), png, "image/png");
  const item: Item = {
    ...shareKey(id),
    ...shareAuthorGsi2(user.id, id),
    type: "share",
    id,
    userId: user.id,
    challengeId: challenge.id,
    nickname: user.nickname,
    title: challenge.title,
    seal: challenge.seal,
    verdict: challenge.verdict,
    days: Object.keys(challenge.stamps).length,
    reflection: challenge.reflection,
    startDate: challenge.startDate,
    recipeId: challenge.recipeId,
    status: "published",
    createdAt: now,
  };
  await deps.db.send(new PutCommand({ TableName: deps.tableName, Item: item, ConditionExpression: "attribute_not_exists(pk)" }));

  let previous: string | null;
  try {
    const res = await deps.db.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: challengeKey(user.id, challenge.id),
        UpdateExpression: "SET shareId = :id",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeValues: { ":id": id },
        ReturnValues: "UPDATED_OLD",
      }),
    );
    previous = typeof res.Attributes?.shareId === "string" ? res.Attributes.shareId : null;
  } catch (err) {
    if (!isConditionFailed(err)) throw err;
    await removeShare(deps, id);
    return undefined;
  }
  if (previous && previous !== id) {
    const old = await getShareItem(deps, previous);
    if (old && old.userId === user.id) await removeShare(deps, previous);
  }
  return id;
}

/** Image first (an orphaned public image is worse than an orphaned row), then the item. */
export async function removeShare(deps: Pick<Deps, "db" | "tableName" | "media">, sid: string): Promise<void> {
  try {
    await deps.media.delete(shareMediaKey(sid));
  } catch (err) {
    log.warn("share image delete failed", { share: sid, err });
    throw err;
  }
  await deps.db.send(new DeleteCommand({ TableName: deps.tableName, Key: shareKey(sid) }));
}

/**
 * Delete a card and clear challenge.shareId when it still points at it.
 * Usable by other features (e.g. when a challenge is deleted).
 */
export async function deleteShare(deps: Pick<Deps, "db" | "tableName" | "media">, item: Item): Promise<void> {
  const sid = String(item.id);
  await removeShare(deps, sid);
  if (typeof item.userId !== "string" || typeof item.challengeId !== "string") return;
  try {
    await deps.db.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: challengeKey(item.userId, item.challengeId),
        UpdateExpression: "REMOVE shareId",
        ConditionExpression: "attribute_exists(pk) AND shareId = :id",
        ExpressionAttributeValues: { ":id": sid },
      }),
    );
  } catch (err) {
    if (!isConditionFailed(err)) throw err; // challenge gone or already pointing elsewhere
  }
}

/** Hide or show a card (moderation). Returns false when it does not exist. */
export async function setShareStatus(deps: D, sid: string, status: PublicStatus): Promise<boolean> {
  try {
    await deps.db.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: shareKey(sid),
        UpdateExpression: "SET #s = :s",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": status },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionFailed(err)) return false;
    throw err;
  }
}

/** STATS/GLOBAL share_<channel> += 1 (anonymous: no user, no content). */
export async function countShareAction(deps: D, channel: string): Promise<void> {
  await deps.db.send(
    new UpdateCommand({
      TableName: deps.tableName,
      Key: statsKey(),
      UpdateExpression: "ADD #k :one",
      ExpressionAttributeNames: { "#k": `share_${channel}` },
      ExpressionAttributeValues: { ":one": 1 },
    }),
  );
}
