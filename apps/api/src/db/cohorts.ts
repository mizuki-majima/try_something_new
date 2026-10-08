/**
 * "1日組" (FR-8) and cheers (FR-9). Members are read from the cohort projection on gsi1
 * (COHORT#<YYYY-MM> / <updatedAt13>#<chId>), which exists only while the owner shares progress and
 * the challenge is not hidden by moderation. gsi1 projects every attribute, notes included, so the
 * public shapes are built from an explicit allowlist: never user ids, never note text in the list.
 * The day notes an owner chose to show (#17, db/notes.ts) are counted in the list and read one member
 * at a time with GET /api/members/:id/notes.
 */
import { BatchGetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { findOfficialRecipe, monthKey, TOTAL_DAYS, type CohortMember, type MemberNote, type UpcomingResponse } from "@thirty/shared";
import type { DbDeps } from "../ports";
import { toChallenge } from "./challenges";
import { authorPk, cheerKey, cohortPk, ttlIn, type Key } from "./keys";
import { consentedNotes } from "./notes";
import { GSI1 } from "./table";
import { DEFAULT_NICKNAME } from "./users";
import { isConditionFailed, type Item } from "./util";

type DbOnly = Pick<DbDeps, "db" | "tableName">;

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** Members returned for one month. */
export const COHORT_LIMIT = 200;
/** Upper bound of items read to count next month's reservations (the partition is small at our scale). */
const UPCOMING_SCAN_LIMIT = 2000;
const UPCOMING_TOP = 10;
/** Cheer markers only decide "once per day"; DynamoDB TTL removes them after two days. */
const CHEER_TTL_SECONDS = 2 * 86_400;
const BATCH_GET_MAX = 100;

/** Visible in a cohort list: projected on gsi1 and not hidden by moderation. */
export function isInCohort(item: Item): boolean {
  return typeof item.gsi1pk === "string" && item.gsi1pk.startsWith("COHORT#") && item.hiddenFromCohort !== true;
}

/**
 * The day notes a public route may show (db/notes.ts rules 1-3): the ones the owner chose, while the
 * challenge is listed. GET /api/members/:id/notes also checks the owner's shareProgress (rule 4).
 */
export function visibleNotes(item: Item): MemberNote[] {
  return isInCohort(item) ? consentedNotes(item) : [];
}

/** Newest activity first. */
export async function queryCohort(deps: DbOnly, month: string, limit = COHORT_LIMIT): Promise<Item[]> {
  const res = await deps.db.send(
    new QueryCommand({
      TableName: deps.tableName,
      IndexName: GSI1,
      KeyConditionExpression: "gsi1pk = :pk",
      ExpressionAttributeValues: { ":pk": cohortPk(month) },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return ((res.Items ?? []) as Item[]).filter(isInCohort);
}

/** Visible challenges of `startDate`'s month that start exactly on `startDate`. */
export async function queryStartingOn(deps: DbOnly, startDate: string): Promise<Item[]> {
  const items: Item[] = [];
  let start: Record<string, unknown> | undefined;
  let read = 0;
  do {
    const res = await deps.db.send(
      new QueryCommand({
        TableName: deps.tableName,
        IndexName: GSI1,
        KeyConditionExpression: "gsi1pk = :pk",
        FilterExpression: "#startDate = :d",
        ExpressionAttributeNames: { "#startDate": "startDate" },
        ExpressionAttributeValues: { ":pk": cohortPk(monthKey(startDate)), ":d": startDate },
        ExclusiveStartKey: start,
      }),
    );
    items.push(...((res.Items ?? []) as Item[]));
    read += res.ScannedCount ?? 0;
    start = res.LastEvaluatedKey;
  } while (start && read < UPCOMING_SCAN_LIMIT);
  return items.filter(isInCohort);
}

/**
 * Public view of a challenge: no note text, no user id, no reflection text. Keep it an explicit
 * allowlist and never spread the item (gsi1 holds every attribute). Of the notes, only how many the
 * owner shows (shownNoteCount, sent when > 0); the text is never in the list.
 */
export function toCohortMember(item: Item, viewerUid: string | undefined, cheered: ReadonlySet<string>): CohortMember {
  const c = toChallenge(item);
  const shownNoteCount = visibleNotes(item).length;
  const stampDays = Object.keys(c.stamps)
    .map(Number)
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= TOTAL_DAYS)
    .sort((a, b) => a - b);
  return {
    challengeId: c.id,
    nickname: typeof item.nickname === "string" && item.nickname ? item.nickname : DEFAULT_NICKNAME,
    seal: c.seal,
    title: c.title,
    recipeId: c.recipeId,
    startDate: c.startDate,
    stampDays,
    done: c.status === "done",
    verdict: c.verdict,
    cheers: c.cheers,
    cheeredToday: cheered.has(c.id),
    isMine: viewerUid !== undefined && item.userId === viewerUid,
    updatedAt: c.updatedAt,
    ...(shownNoteCount > 0 ? { shownNoteCount } : {}),
  };
}

/**
 * Reservation count for `startDate`, how many distinct people made them (one person may reserve
 * several; the owner ids are only counted here, never returned) and the top recipes among them.
 */
export function summariseUpcoming(items: Item[], startDate: string): UpcomingResponse {
  const groups = new Map<string, UpcomingResponse["byRecipe"][number]>();
  const people = new Set<string>();
  let count = 0;
  for (const item of items) {
    if (item.startDate !== startDate || !isInCohort(item)) continue;
    count++;
    people.add(typeof item.userId === "string" ? item.userId : String(item.pk));
    const c = toChallenge(item);
    const official = c.recipeId ? findOfficialRecipe(c.recipeId) : undefined;
    // Free-form challenges (no recipe) are grouped by what they look like.
    const key = c.recipeId ? `r:${c.recipeId}` : `t:${c.seal}:${c.title}`;
    const group = groups.get(key) ?? {
      recipeId: c.recipeId,
      title: official?.title ?? c.title,
      seal: official?.seal ?? c.seal,
      count: 0,
    };
    group.count++;
    groups.set(key, group);
  }
  const byRecipe = [...groups.values()]
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title, "ja"))
    .slice(0, UPCOMING_TOP);
  return { startDate, count, peopleCount: people.size, byRecipe };
}

// ---------- cheers ----------

/** Cheer markers live outside USER#<uid>, so they carry gsi2 AUTHOR#<uid> for account deletion. */
const cheerAuthorGsi2 = (uid: string, chId: string, date: string) => ({ gsi2pk: authorPk(uid), gsi2sk: `CHEER#${chId}#${date}` });

/** Record that `uid` cheered `chId` on `date`. Returns false when they already did that day. */
export async function putCheerMarker(deps: DbDeps, uid: string, chId: string, date: string): Promise<boolean> {
  const now = deps.now().getTime();
  try {
    await deps.db.send(
      new PutCommand({
        TableName: deps.tableName,
        Item: { ...cheerKey(chId, date, uid), ...cheerAuthorGsi2(uid, chId, date), type: "cheer", ttl: ttlIn(now, CHEER_TTL_SECONDS) },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return true;
  } catch (err) {
    if (isConditionFailed(err)) return false;
    throw err;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Which of `chIds` `uid` has already cheered on `date` (BatchGet, 100 keys per call). */
export async function cheeredOn(deps: DbOnly, uid: string, date: string, chIds: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const unique = [...new Set(chIds)];
  const byPk = new Map(unique.map((id) => [cheerKey(id, date, uid).pk, id] as const));
  for (let i = 0; i < unique.length; i += BATCH_GET_MAX) {
    let keys: Key[] = unique.slice(i, i + BATCH_GET_MAX).map((id) => cheerKey(id, date, uid));
    for (let attempt = 0; keys.length > 0; attempt++) {
      if (attempt >= 8) throw new Error("cheeredOn: unprocessed keys remained after retries");
      if (attempt > 0) await sleep(Math.min(1000, 50 * 2 ** attempt));
      const res = await deps.db.send(
        new BatchGetCommand({ RequestItems: { [deps.tableName]: { Keys: keys, ProjectionExpression: "pk" } } }),
      );
      for (const item of res.Responses?.[deps.tableName] ?? []) {
        const id = byPk.get(String(item.pk));
        if (id) found.add(id);
      }
      keys = (res.UnprocessedKeys?.[deps.tableName]?.Keys ?? []) as Key[];
    }
  }
  return found;
}
