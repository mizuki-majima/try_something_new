/**
 * PILOT metrics for the admin page (docs/validation-plan.md), per person: computed from the challenge
 * items (USER#<uid> / CH#<chId>) that exist now, with a paginated Scan. A Scan reads the whole table, so
 * it is capped; at pilot scale (tens of users) it is a handful of pages.
 */
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_TIMEZONE, dayIndex, isValidDate, todayIn, type PilotStats } from "@thirty/shared";
import { log } from "../log";
import type { DbDeps } from "../ports";
import { PREFIX } from "./keys";
import type { Item } from "./util";

/** Challenge items read at most per request (a safety cap, far above pilot scale). */
export const PILOT_SCAN_CAP = 20_000;

/** "7日継続" (validation-plan.md): at least RETENTION_MIN_STAMPS stamps within days 1..RETENTION_DAYS. */
export const RETENTION_DAYS = 7;
export const RETENTION_MIN_STAMPS = 5;

/** The fields of a challenge item the metrics need. */
export type PilotChallenge = { userId: string; startDate: string; status: string; stampDays: number[]; shared: boolean };

/** undefined for anything that is not a challenge item, and for imported ones (FR-16: not real use). */
export function toPilotChallenge(item: Item): PilotChallenge | undefined {
  const pk = typeof item.pk === "string" ? item.pk : "";
  const sk = typeof item.sk === "string" ? item.sk : "";
  if (!pk.startsWith(PREFIX.user) || !sk.startsWith(PREFIX.challenge)) return undefined;
  if (item.imported === true) return undefined;
  const startDate = typeof item.startDate === "string" ? item.startDate : "";
  if (!isValidDate(startDate)) return undefined;
  const stamps = item.stamps && typeof item.stamps === "object" ? (item.stamps as Record<string, unknown>) : {};
  return {
    userId: pk.slice(PREFIX.user.length),
    startDate,
    status: item.status === "done" ? "done" : "active",
    stampDays: Object.keys(stamps)
      .map(Number)
      .filter((d) => Number.isInteger(d) && d >= 1),
    shared: typeof item.shareId === "string" && item.shareId.length > 0,
  };
}

type Person = { firstStart: string; retained: boolean; reflected: boolean; shared: boolean };

/**
 * Pure part, counted per PERSON as docs/validation-plan.md defines the metrics. `today` is the JST
 * date: the pilot runs in Japan and the challenge item does not carry the owner's time zone (at most
 * one day of difference at the edges). Only challenges whose start date has come count.
 *   starters   people with a started challenge
 *   eligible7  starters whose first started challenge is on day 8 or later (day 7 has passed)
 *   retained7  of eligible7, people with any challenge with RETENTION_MIN_STAMPS+ stamps on days 1..7
 *   reflected  people with a done challenge
 *   sharers    people with a done challenge that currently has a public card
 */
export function pilotStats(challenges: Iterable<PilotChallenge>, today: string): PilotStats {
  const people = new Map<string, Person>();
  for (const c of challenges) {
    if (dayIndex(c.startDate, today) < 1) continue;
    const p = people.get(c.userId) ?? { firstStart: c.startDate, retained: false, reflected: false, shared: false };
    if (c.startDate < p.firstStart) p.firstStart = c.startDate;
    if (c.stampDays.filter((d) => d <= RETENTION_DAYS).length >= RETENTION_MIN_STAMPS) p.retained = true;
    if (c.status === "done") {
      p.reflected = true;
      if (c.shared) p.shared = true;
    }
    people.set(c.userId, p);
  }
  const out: PilotStats = { starters: people.size, eligible7: 0, retained7: 0, reflected: 0, sharers: 0 };
  for (const p of people.values()) {
    if (dayIndex(p.firstStart, today) > RETENTION_DAYS) {
      out.eligible7++;
      if (p.retained) out.retained7++;
    }
    if (p.reflected) out.reflected++;
    if (p.shared) out.sharers++;
  }
  return out;
}

export type PilotScanOptions = {
  /** Stop after this many challenge items (default PILOT_SCAN_CAP). */
  cap?: number;
  /** Items evaluated per Scan page (default: DynamoDB's 1MB pages). Tests use it to force pagination. */
  pageSize?: number;
};

/** Scan every challenge item (paginated, capped) and compute PilotStats for `deps.now()`. */
export async function computePilotStats(deps: DbDeps, opts: PilotScanOptions = {}): Promise<PilotStats> {
  const cap = opts.cap ?? PILOT_SCAN_CAP;
  const challenges: PilotChallenge[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await deps.db.send(
      new ScanCommand({
        TableName: deps.tableName,
        FilterExpression: "begins_with(#pk, :user) AND begins_with(#sk, :ch)",
        // Only what the metrics need (stamps are counted, never returned).
        ProjectionExpression: "#pk, #sk, #start, #status, #stamps, #share, #imported",
        ExpressionAttributeNames: {
          "#pk": "pk",
          "#sk": "sk",
          "#start": "startDate",
          "#status": "status",
          "#stamps": "stamps",
          "#share": "shareId",
          "#imported": "imported",
        },
        ExpressionAttributeValues: { ":user": PREFIX.user, ":ch": PREFIX.challenge },
        ExclusiveStartKey: start,
        ...(opts.pageSize ? { Limit: opts.pageSize } : {}),
      }),
    );
    for (const item of (res.Items ?? []) as Item[]) {
      const c = toPilotChallenge(item);
      if (c) challenges.push(c);
    }
    start = res.LastEvaluatedKey;
  } while (start && challenges.length < cap);
  if (start || challenges.length > cap) log.warn("pilot stats: scan cap reached, numbers are partial", { cap });
  return pilotStats(challenges.slice(0, cap), todayIn(DEFAULT_TIMEZONE, deps.now()));
}
