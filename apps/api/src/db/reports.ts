/**
 * Reports and moderation (FR-18).
 *   REPORT#<type>#<id> / META   count, reasons (last 10), lastAt, deletedAt (moderator deleted it);
 *                                gsi1 REPORTS / <lastAt13>
 *   REPORT#<type>#<id> / BY#<uid>  one per reporter (a repeat report is not counted);
 *                                  gsi2 AUTHOR#<uid> so it goes with the reporter's account
 * Targets: recipe = community recipe id, story = "<recipeId>:<storyId>", share = share id,
 * member = challenge id (owner found through CHREF).
 */
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { IdSchema, RecipeIdSchema, type AdminReportItem, type ReportTargetType } from "@thirty/shared";
import type { DbDeps, Deps } from "../ports";
import { excerpt } from "../share-page";
import { challengeKey, reportKey, reporterKey, reportListGsi1, authorPk } from "./keys";
import { cohortProjection, getChallengeItem, getChallengeOwner, toChallenge } from "./challenges";
import {
  deleteRecipeAndStories,
  deleteStoryItem,
  findStoryItem,
  getRecipeItem,
  setRecipeStatus,
  setStoryStatus,
  type PublicStatus,
} from "./recipes";
import { deleteShare, getShareItem, setShareStatus } from "./shares";
import { GSI1 } from "./table";
import { getUser } from "./users";
import { isConditionFailed, type Item } from "./util";

type D = DbDeps;

/** Reasons kept on the META item. */
export const MAX_REPORT_REASONS = 10;
/** Items returned by GET /api/admin/reports. */
export const MAX_LISTED_REPORTS = 100;
const PREVIEW_LENGTH = 60;

export type Target = {
  type: ReportTargetType;
  /** Canonical id used in REPORT# keys. */
  id: string;
  /** recipe META / story / share META / challenge item. */
  item: Item;
  /** Never returned to clients; used for "own content" and member lookups. */
  ownerId: string | undefined;
  status: PublicStatus;
};

const statusOf = (item: Item): PublicStatus => (item.status === "hidden" ? "hidden" : "published");
const ownerOf = (item: Item) => (typeof item.userId === "string" ? item.userId : undefined);

/** Find a reportable target. undefined when the id is malformed or nothing is there (official recipes included). */
export async function resolveTarget(deps: D, type: ReportTargetType, rawId: string): Promise<Target | undefined> {
  switch (type) {
    case "recipe": {
      if (!RecipeIdSchema.safeParse(rawId).success) return undefined;
      const item = await getRecipeItem(deps, rawId);
      return item ? { type, id: rawId, item, ownerId: ownerOf(item), status: statusOf(item) } : undefined;
    }
    case "story": {
      const parts = rawId.split(":");
      if (parts.length !== 2) return undefined;
      const [rid, sid] = parts as [string, string];
      if (!RecipeIdSchema.safeParse(rid).success || !IdSchema.safeParse(sid).success) return undefined;
      const item = await findStoryItem(deps, rid, sid);
      return item ? { type, id: `${rid}:${sid}`, item, ownerId: ownerOf(item), status: statusOf(item) } : undefined;
    }
    case "share": {
      if (!IdSchema.safeParse(rawId).success) return undefined;
      const item = await getShareItem(deps, rawId);
      return item ? { type, id: rawId, item, ownerId: ownerOf(item), status: statusOf(item) } : undefined;
    }
    case "member": {
      if (!IdSchema.safeParse(rawId).success) return undefined;
      const owner = await getChallengeOwner(deps, rawId);
      const item = owner ? await getChallengeItem(deps, owner, rawId) : undefined;
      if (!owner || !item) return undefined;
      return { type, id: rawId, item, ownerId: owner, status: item.hiddenFromCohort === true ? "hidden" : "published" };
    }
  }
}

/** Short text for the admin list. */
export function targetPreview(t: Target): string {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const i = t.item;
  switch (t.type) {
    case "recipe":
      return excerpt(`${s(i.title)}：${s(i.summary)}`, PREVIEW_LENGTH);
    case "story":
      return excerpt(s(i.body), PREVIEW_LENGTH);
    case "share":
      return excerpt(`${s(i.nickname)}「${s(i.title)}」 ${s(i.reflection)}`, PREVIEW_LENGTH);
    case "member":
      return excerpt(`${s(i.nickname)}「${s(i.title)}」`, PREVIEW_LENGTH);
  }
}

// ---------- reporting ----------

/**
 * Record one report. Only the first report of each user counts. Returns the current count
 * (undefined when this reporter had already reported the target).
 */
export async function addReport(deps: Deps, reporterUid: string, target: Target, reason: string | undefined): Promise<number | undefined> {
  const now = deps.now().getTime();
  try {
    await deps.db.send(
      new PutCommand({
        TableName: deps.tableName,
        Item: {
          ...reporterKey(target.type, target.id, reporterUid),
          gsi2pk: authorPk(reporterUid),
          gsi2sk: `REPORT#${target.type}#${target.id}`,
          type: "reporter",
          createdAt: now,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  } catch (err) {
    if (isConditionFailed(err)) return undefined;
    throw err;
  }

  const list = reportListGsi1(now);
  const values: Record<string, unknown> = {
    ":type": target.type,
    ":id": target.id,
    ":now": now,
    ":g1pk": list.gsi1pk,
    ":g1sk": list.gsi1sk,
    ":one": 1,
    ":empty": [],
  };
  let reasons = "reasons = if_not_exists(reasons, :empty)";
  if (reason) {
    values[":r"] = [reason];
    reasons = "reasons = list_append(if_not_exists(reasons, :empty), :r)";
  }
  const res = await deps.db.send(
    new UpdateCommand({
      TableName: deps.tableName,
      Key: reportKey(target.type, target.id),
      UpdateExpression: `SET targetType = :type, targetId = :id, lastAt = :now, createdAt = if_not_exists(createdAt, :now), gsi1pk = :g1pk, gsi1sk = :g1sk, ${reasons} ADD #count :one`,
      ExpressionAttributeNames: { "#count": "count" },
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    }),
  );
  const count = Number(res.Attributes?.count ?? 1);
  const kept = Array.isArray(res.Attributes?.reasons) ? res.Attributes.reasons.length : 0;
  if (kept > MAX_REPORT_REASONS) await trimReasons(deps, target, kept);
  return count;
}

/** Drop the oldest reasons. Conditional on the length we saw, so a concurrent append is never lost. */
async function trimReasons(deps: D, target: Target, length: number): Promise<void> {
  const drop = length - MAX_REPORT_REASONS;
  const paths = Array.from({ length: drop }, (_, i) => `reasons[${i}]`).join(", ");
  try {
    await deps.db.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: reportKey(target.type, target.id),
        UpdateExpression: `REMOVE ${paths}`,
        ConditionExpression: "size(reasons) = :len",
        ExpressionAttributeValues: { ":len": length },
      }),
    );
  } catch (err) {
    if (!isConditionFailed(err)) throw err; // someone else appended; the next report trims
  }
}

/** After a restore the target starts over: it takes AUTO_HIDE_REPORTS new reporters to hide it again. */
export async function resetReportCount(deps: D, type: ReportTargetType, id: string): Promise<void> {
  try {
    await deps.db.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: reportKey(type, id),
        UpdateExpression: "SET #count = :zero",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#count": "count" },
        ExpressionAttributeValues: { ":zero": 0 },
      }),
    );
  } catch (err) {
    if (!isConditionFailed(err)) throw err;
  }
}

// ---------- moderation ----------

/** Keep a member's challenge out of the cohort list (gsi1 removed) regardless of shareProgress. */
async function hideMember(deps: D, ownerId: string, chId: string): Promise<boolean> {
  try {
    await deps.db.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: challengeKey(ownerId, chId),
        UpdateExpression: "SET hiddenFromCohort = :t REMOVE gsi1pk, gsi1sk",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeValues: { ":t": true },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionFailed(err)) return false;
    throw err;
  }
}

/** Lift the moderation flag; the cohort projection comes back only if the owner still shares progress. */
async function restoreMember(deps: D, ownerId: string, chId: string): Promise<boolean> {
  const owner = await getUser(deps, ownerId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const item = await getChallengeItem(deps, ownerId, chId);
    if (!item) return false;
    const c = toChallenge(item);
    const projection = cohortProjection({ ...c, hiddenFromCohort: false }, owner?.shareProgress ?? false);
    try {
      await deps.db.send(
        new UpdateCommand({
          TableName: deps.tableName,
          Key: challengeKey(ownerId, chId),
          UpdateExpression: projection ? "SET gsi1pk = :g1pk, gsi1sk = :g1sk REMOVE hiddenFromCohort" : "REMOVE hiddenFromCohort, gsi1pk, gsi1sk",
          // The sort key embeds updatedAt; retry if the challenge changed since we read it.
          ConditionExpression: "attribute_exists(pk) AND updatedAt = :u",
          ExpressionAttributeValues: {
            ":u": item.updatedAt,
            ...(projection ? { ":g1pk": projection.gsi1pk, ":g1sk": projection.gsi1sk } : {}),
          },
        }),
      );
      return true;
    } catch (err) {
      if (!isConditionFailed(err)) throw err;
    }
  }
  return false;
}

/**
 * Moderator's "delete" of a member (FR-18, AI PM decision): the challenge is the owner's private
 * record (stamps, notes), so it is never destroyed. Instead it leaves the cohort list for good
 * (hiddenFromCohort, gsi1 removed) and its public share card, if any, is hidden. The admin route
 * marks the report deleted, which also refuses a later "restore".
 */
async function removeMember(deps: D, ownerId: string, chId: string): Promise<void> {
  let shareId: unknown;
  try {
    const res = await deps.db.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: challengeKey(ownerId, chId),
        UpdateExpression: "SET hiddenFromCohort = :t REMOVE gsi1pk, gsi1sk",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeValues: { ":t": true },
        ReturnValues: "ALL_NEW",
      }),
    );
    shareId = res.Attributes?.shareId;
  } catch (err) {
    if (isConditionFailed(err)) return; // the owner deleted it meanwhile
    throw err;
  }
  if (typeof shareId === "string" && shareId) {
    const share = await getShareItem(deps, shareId);
    if (share && share.userId === ownerId) await setShareStatus(deps, shareId, "hidden");
  }
}

/** Hide a target (auto-hide or admin). Returns false when it no longer exists. */
export async function hideTarget(deps: D, t: Target): Promise<boolean> {
  switch (t.type) {
    case "recipe":
      return setRecipeStatus(deps, t.item, "hidden");
    case "story":
      return setStoryStatus(deps, t.item, "hidden");
    case "share":
      return setShareStatus(deps, t.id, "hidden");
    case "member":
      return hideMember(deps, t.ownerId!, t.id);
  }
}

export async function restoreTarget(deps: D, t: Target): Promise<boolean> {
  switch (t.type) {
    case "recipe":
      return setRecipeStatus(deps, t.item, "published");
    case "story":
      return setStoryStatus(deps, t.item, "published");
    case "share":
      return setShareStatus(deps, t.id, "published");
    case "member":
      return restoreMember(deps, t.ownerId!, t.id);
  }
}

/** Moderator's "delete": real deletion for recipes, stories and share cards; see removeMember for members. */
export async function deleteTarget(deps: Deps, t: Target): Promise<void> {
  switch (t.type) {
    case "recipe":
      return deleteRecipeAndStories(deps, t.id);
    case "story":
      return deleteStoryItem(deps, t.item);
    case "share":
      return deleteShare(deps, t.item);
    case "member":
      return removeMember(deps, t.ownerId!, t.id);
  }
}

/**
 * Record the moderator's "delete" on the report META (deletedAt). The admin list then shows the
 * target as deleted and a "restore" is refused, which is what keeps a removed member out of the
 * cohort for good. A target that was never reported gets a META without gsi1: it stays out of the
 * admin list until someone reports it, and is shown as deleted from then on.
 */
export async function markReportDeleted(deps: D, type: ReportTargetType, id: string): Promise<void> {
  await deps.db.send(
    new UpdateCommand({
      TableName: deps.tableName,
      Key: reportKey(type, id),
      UpdateExpression: "SET targetType = :type, targetId = :id, deletedAt = :now",
      ExpressionAttributeValues: { ":type": type, ":id": id, ":now": deps.now().getTime() },
    }),
  );
}

/** True when a moderator deleted this target (see markReportDeleted). */
export async function isReportDeleted(deps: D, type: ReportTargetType, id: string): Promise<boolean> {
  const res = await deps.db.send(
    new GetCommand({ TableName: deps.tableName, Key: reportKey(type, id), ProjectionExpression: "deletedAt" }),
  );
  return typeof res.Item?.deletedAt === "number";
}

// ---------- admin list ----------

const REPORT_TYPES: readonly ReportTargetType[] = ["recipe", "story", "share", "member"];

export async function listReports(deps: D, max = MAX_LISTED_REPORTS): Promise<AdminReportItem[]> {
  const res = await deps.db.send(
    new QueryCommand({
      TableName: deps.tableName,
      IndexName: GSI1,
      KeyConditionExpression: "gsi1pk = :pk",
      ExpressionAttributeValues: { ":pk": "REPORTS" },
      ScanIndexForward: false,
      Limit: max,
    }),
  );
  const metas = ((res.Items ?? []) as Item[]).filter(
    (i) => REPORT_TYPES.includes(i.targetType as ReportTargetType) && typeof i.targetId === "string",
  );
  const out: AdminReportItem[] = [];
  for (let i = 0; i < metas.length; i += 10) {
    const chunk = await Promise.all(
      metas.slice(i, i + 10).map(async (m): Promise<AdminReportItem> => {
        const type = m.targetType as ReportTargetType;
        const targetId = String(m.targetId);
        const target = await resolveTarget(deps, type, targetId);
        // A removed member still exists (the owner's record): deleted for moderation, preview kept.
        const deleted = !target || typeof m.deletedAt === "number";
        return {
          targetType: type,
          targetId,
          count: Number(m.count ?? 0),
          reasons: Array.isArray(m.reasons) ? m.reasons.map(String) : [],
          lastAt: Number(m.lastAt ?? 0),
          status: deleted ? "deleted" : target.status,
          preview: target ? targetPreview(target) : "",
        };
      }),
    );
    out.push(...chunk);
  }
  return out;
}
