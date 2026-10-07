/**
 * Reports and moderation (FR-18).
 *   REPORT#<type>#<id> / META   count (distinct reporters), trustedCount (those that count towards
 *                                auto-hide, see isTrustedReporter), reasons (last 10), lastAt,
 *                                deletedAt (moderator deleted it); gsi1 REPORTS / <lastAt13>
 *                                resetAt (a moderator's restore: the count starts over)
 *   REPORT#<type>#<id> / BY#<uid>  one per reporter (a repeat report is not counted): createdAt,
 *                                  trusted, net (keyed hash of the reporter's IPv4 /24 or IPv6 /48,
 *                                  trusted reporters only); gsi2 AUTHOR#<uid> so it goes with the
 *                                  reporter's account
 * Targets: recipe = community recipe id, story = "<recipeId>:<storyId>", share = share id,
 * member = challenge id (owner found through CHREF).
 */
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  IdSchema,
  REPORTER_MIN_ACCOUNT_AGE_HOURS,
  RecipeIdSchema,
  type AdminReportItem,
  type ReportTargetType,
  type User,
} from "@thirty/shared";
import type { DbDeps, Deps } from "../ports";
import { excerpt } from "../share-page";
import { challengeKey, reportKey, reporterKey, reportListGsi1, authorPk, userPk } from "./keys";
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
import { clearModeration, markModeration, type ModerationFlag } from "./moderation";
import { deleteShare, getShareItem, setChallengeModerated, setShareStatus } from "./shares";
import { GSI1 } from "./table";
import { getUser } from "./users";
import { isConditionFailed, queryAll, type Item } from "./util";

type D = DbDeps;
/** Moderation also moves or deletes card images. */
type MD = DbDeps & Pick<Deps, "media">;

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
 * Whether a report from `user` counts towards auto-hide (security: one person with a handful of
 * throwaway accounts must not be able to hide anything). The account must be at least
 * REPORTER_MIN_ACCOUNT_AGE_HOURS old and hold at least one challenge. Other reports are still
 * recorded (marker, reason, count) for the moderator.
 */
export async function isTrustedReporter(deps: D, user: Pick<User, "id" | "createdAt">): Promise<boolean> {
  if (deps.now().getTime() - user.createdAt < REPORTER_MIN_ACCOUNT_AGE_HOURS * 3_600_000) return false;
  const res = await deps.db.send(
    new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :ch)",
      ExpressionAttributeValues: { ":pk": userPk(user.id), ":ch": "CH#" },
      ProjectionExpression: "pk",
      Limit: 1,
    }),
  );
  return (res.Items ?? []).length > 0;
}

/** Who reported: whether it counts towards auto-hide, and (trusted only) the keyed hash of their network. */
export type Reporter = { uid: string; trusted: boolean; net?: string };

/** The auto-hide count after a report, and when it last started over (a restore). */
export type ReportTally = { trustedCount: number; since: number };

/**
 * Record one report. Only the first report of each user counts. Returns the number of trusted
 * reporters since the last restore (the auto-hide count), or undefined when this reporter had already
 * reported the target. An untrusted report is recorded but leaves that number as it is.
 */
export async function addReport(deps: Deps, reporter: Reporter, target: Target, reason: string | undefined): Promise<ReportTally | undefined> {
  const now = deps.now().getTime();
  const reporterUid = reporter.uid;
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
          trusted: reporter.trusted,
          ...(reporter.trusted && reporter.net ? { net: reporter.net } : {}),
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
    ":trusted": reporter.trusted ? 1 : 0,
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
      UpdateExpression: `SET targetType = :type, targetId = :id, lastAt = :now, createdAt = if_not_exists(createdAt, :now), gsi1pk = :g1pk, gsi1sk = :g1sk, ${reasons} ADD #count :one, #trusted :trusted`,
      ExpressionAttributeNames: { "#count": "count", "#trusted": "trustedCount" },
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    }),
  );
  const trustedCount = Number(res.Attributes?.trustedCount ?? 0);
  const since = Number(res.Attributes?.resetAt ?? 0);
  const kept = Array.isArray(res.Attributes?.reasons) ? res.Attributes.reasons.length : 0;
  if (kept > MAX_REPORT_REASONS) await trimReasons(deps, target, kept);
  return { trustedCount, since };
}

/**
 * Distinct networks among the trusted reporters of a target since `since` (security-4): auto-hide
 * needs AUTO_HIDE_MIN_NETWORKS of them, so one person's aged accounts on one connection cannot hide
 * anything. Read only once the trusted count reaches the threshold.
 */
export async function countReporterNetworks(deps: D, type: ReportTargetType, id: string, since: number): Promise<number> {
  const markers = await queryAll(deps, {
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :by)",
    FilterExpression: "#trusted = :t AND #createdAt >= :since AND attribute_exists(#net)",
    ProjectionExpression: "#net",
    ExpressionAttributeNames: { "#trusted": "trusted", "#createdAt": "createdAt", "#net": "net" },
    ExpressionAttributeValues: { ":pk": reportKey(type, id).pk, ":by": "BY#", ":t": true, ":since": since },
  });
  return new Set(markers.map((m) => String(m.net))).size;
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

/**
 * After a restore the target starts over: it takes AUTO_HIDE_REPORTS new reporters (from
 * AUTO_HIDE_MIN_NETWORKS networks, counted from resetAt) to hide it again.
 */
export async function resetReportCount(deps: D, type: ReportTargetType, id: string): Promise<void> {
  try {
    await deps.db.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: reportKey(type, id),
        UpdateExpression: "SET #count = :zero, #trusted = :zero, resetAt = :now",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#count": "count", "#trusted": "trustedCount" },
        ExpressionAttributeValues: { ":zero": 0, ":now": deps.now().getTime() },
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
    const projection = cohortProjection({ ...c, hiddenFromCohort: false, imported: item.imported === true }, owner?.shareProgress ?? false);
    // Back in the list: the nickname too, since syncUserProjection skips items that are not listed.
    const nickname = owner?.nickname ?? (typeof item.nickname === "string" ? item.nickname : "");
    try {
      await deps.db.send(
        new UpdateCommand({
          TableName: deps.tableName,
          Key: challengeKey(ownerId, chId),
          UpdateExpression: projection
            ? "SET gsi1pk = :g1pk, gsi1sk = :g1sk, nickname = :n REMOVE hiddenFromCohort"
            : "REMOVE hiddenFromCohort, gsi1pk, gsi1sk",
          // The sort key embeds updatedAt; retry if the challenge changed since we read it.
          ConditionExpression: "attribute_exists(pk) AND updatedAt = :u",
          ExpressionAttributeValues: {
            ":u": item.updatedAt,
            ...(projection ? { ":g1pk": projection.gsi1pk, ":g1sk": projection.gsi1sk, ":n": nickname } : {}),
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
async function removeMember(deps: MD, ownerId: string, chId: string): Promise<void> {
  let shareId: unknown;
  try {
    const res = await deps.db.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: challengeKey(ownerId, chId),
        // moderated: the owner cannot publish a new card for it either (POST /api/shares → 403).
        UpdateExpression: "SET hiddenFromCohort = :t, moderated = :t REMOVE gsi1pk, gsi1sk",
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

/** The challenge a card was made from, and its owner (undefined on cards that predate challengeId). */
function cardChallenge(share: Item): { chId: string; ownerUid: string } | undefined {
  return typeof share.challengeId === "string" && typeof share.userId === "string"
    ? { chId: share.challengeId, ownerUid: share.userId }
    : undefined;
}

/** MOD#<chId> for a card's challenge (see db/moderation.ts). */
async function markCard(deps: D, share: Item, flags: ModerationFlag[]): Promise<void> {
  const ch = cardChallenge(share);
  if (ch) await markModeration(deps, ch.chId, ch.ownerUid, flags);
}

/**
 * Hide a target (auto-hide or admin). Returns false when it no longer exists. A hidden card's image
 * leaves the public prefix, and its challenge is marked so the owner cannot publish it again. Card and
 * member moderation is also written to MOD#<chId> first, which outlives the challenge item (NF-2).
 */
export async function hideTarget(deps: MD, t: Target): Promise<boolean> {
  switch (t.type) {
    case "recipe":
      return setRecipeStatus(deps, t.item, "hidden");
    case "story":
      return setStoryStatus(deps, t.item, "hidden");
    case "share":
      await markCard(deps, t.item, ["shareModerated"]);
      await setChallengeModerated(deps, t.item, true);
      return setShareStatus(deps, t.id, "hidden");
    case "member":
      await markModeration(deps, t.id, t.ownerId!, ["memberHidden"]);
      return hideMember(deps, t.ownerId!, t.id);
  }
}

/** A moderator's restore. The MOD#<chId> flag is cleared only once the target is back. */
export async function restoreTarget(deps: MD, t: Target): Promise<boolean> {
  switch (t.type) {
    case "recipe":
      return setRecipeStatus(deps, t.item, "published");
    case "story":
      return setStoryStatus(deps, t.item, "published");
    case "share": {
      if (!(await setShareStatus(deps, t.id, "published"))) return false;
      await setChallengeModerated(deps, t.item, false);
      const ch = cardChallenge(t.item);
      if (ch) await clearModeration(deps, ch.chId, "shareModerated");
      return true;
    }
    case "member": {
      if (!(await restoreMember(deps, t.ownerId!, t.id))) return false;
      await clearModeration(deps, t.id, "memberHidden");
      return true;
    }
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
      await markCard(deps, t.item, ["shareModerated"]);
      await setChallengeModerated(deps, t.item, true);
      return deleteShare(deps, t.item);
    case "member":
      // removeMember also hides the card and blocks a new one (moderated).
      await markModeration(deps, t.id, t.ownerId!, ["memberHidden", "shareModerated"]);
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
