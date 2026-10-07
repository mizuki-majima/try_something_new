/**
 * PILOT metrics for the admin page (docs/validation-plan.md), per person: computed from the challenge
 * items (USER#<uid> / CH#<chId>) that exist now, with a paginated Scan. A Scan reads the whole table, so
 * it is bounded (R15): it returns only the attributes the metrics use (no notes; the stamps of days
 * 1–7 only), in pages of at most PILOT_PAGE_LIMIT items, and stops after PILOT_TIME_BUDGET_MS (or
 * PILOT_SCAN_CAP challenges) with `partial: true`. At pilot scale (tens of users) it is one page.
 */
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_TIMEZONE, dayIndex, isValidDate, todayIn, type PilotStats } from "@thirty/shared";
import { log } from "../log";
import type { DbDeps } from "../ports";
import { PREFIX } from "./keys";
import type { Item } from "./util";

/** Challenge items read at most per request (a safety cap, far above pilot scale). */
export const PILOT_SCAN_CAP = 20_000;

/** Items evaluated per Scan page: each call stays short, so the time budget is checked often. */
export const PILOT_PAGE_LIMIT = 500;

/**
 * The scan answers with what it has after this long (`partial: true`): the API Lambda times out at
 * 30 s, and a long scan holds the table's read capacity (R15, N3-2).
 */
export const PILOT_TIME_BUDGET_MS = 20_000;

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
  /** Items evaluated per Scan page (default PILOT_PAGE_LIMIT). Tests use a small one to force pagination. */
  pageSize?: number;
  /** Stop starting new pages after this many milliseconds (default PILOT_TIME_BUDGET_MS). */
  timeBudgetMs?: number;
  /** A monotonic clock in milliseconds (default performance.now). Tests pass a fake one. */
  elapsed?: () => number;
};

/**
 * The stamps of days 1..RETENTION_DAYS, their `at` only: the retention metric counts these days and
 * nothing else, and the notes never leave the table.
 */
const RETENTION_DAY_NAMES = Object.fromEntries(Array.from({ length: RETENTION_DAYS }, (_, i) => [`#d${i + 1}`, String(i + 1)]));
const RETENTION_STAMPS = Object.keys(RETENTION_DAY_NAMES).map((d) => `#stamps.${d}.#at`);

/**
 * Scan the challenge items (paginated, bounded) and compute PilotStats for `deps.now()`. `partial` is
 * set when the scan stopped before the end of the table (time budget or cap).
 */
export async function computePilotStats(deps: DbDeps, opts: PilotScanOptions = {}): Promise<PilotStats> {
  const cap = opts.cap ?? PILOT_SCAN_CAP;
  const elapsed = opts.elapsed ?? (() => performance.now());
  const deadline = elapsed() + (opts.timeBudgetMs ?? PILOT_TIME_BUDGET_MS);
  const challenges: PilotChallenge[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await deps.db.send(
      new ScanCommand({
        TableName: deps.tableName,
        FilterExpression: "begins_with(#pk, :user) AND begins_with(#sk, :ch)",
        // Only what the metrics need. Read units are charged on whole items all the same; this keeps
        // notes out of the response and the Lambda's memory.
        ProjectionExpression: ["#pk", "#sk", "#start", "#status", "#share", "#imported", ...RETENTION_STAMPS].join(", "),
        ExpressionAttributeNames: {
          "#pk": "pk",
          "#sk": "sk",
          "#start": "startDate",
          "#status": "status",
          "#stamps": "stamps",
          "#at": "at",
          "#share": "shareId",
          "#imported": "imported",
          ...RETENTION_DAY_NAMES,
        },
        ExpressionAttributeValues: { ":user": PREFIX.user, ":ch": PREFIX.challenge },
        ExclusiveStartKey: start,
        Limit: opts.pageSize ?? PILOT_PAGE_LIMIT,
      }),
    );
    for (const item of (res.Items ?? []) as Item[]) {
      const c = toPilotChallenge(item);
      if (c) challenges.push(c);
    }
    start = res.LastEvaluatedKey;
  } while (start && challenges.length < cap && elapsed() < deadline);
  const partial = start !== undefined || challenges.length > cap;
  if (partial) log.warn("pilot stats: scan stopped early, numbers are partial", { cap, read: challenges.length });
  const stats = pilotStats(challenges.slice(0, cap), todayIn(DEFAULT_TIMEZONE, deps.now()));
  return partial ? { ...stats, partial: true } : stats;
}
