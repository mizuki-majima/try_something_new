/**
 * Calendar-date helpers. Dates are plain "YYYY-MM-DD" strings (no time, no timezone) so that
 * "day N of a challenge" means the same thing on the client and the server.
 * Arithmetic is done in UTC on purpose: it only shifts calendar days and never sees DST.
 */
import { TOTAL_DAYS } from "./constants";

export type DateStr = string;
export const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = toUtc(s);
  return fromUtc(d) === s;
}

function toUtc(s: DateStr): Date {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtc(d: Date): DateStr {
  return d.toISOString().slice(0, 10);
}

export function addDays(s: DateStr, n: number): DateStr {
  const d = toUtc(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUtc(d);
}

/** b - a in whole days. */
export function diffDays(a: DateStr, b: DateStr): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Today's calendar date in the given IANA time zone. */
export function todayIn(tz: string, now: Date = new Date()): DateStr {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Day number of `today` within a challenge that starts on `start` (day 1 = start). <1 before the start. */
export function dayIndex(start: DateStr, today: DateStr): number {
  return diffDays(start, today) + 1;
}

export function lastDay(start: DateStr): DateStr {
  return addDays(start, TOTAL_DAYS - 1);
}

/** The 1st of the month after `today` ("次の1日組"). */
export function nextFirst(today: DateStr): DateStr {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m, 1));
  return fromUtc(d);
}

export function isFirstOfMonth(s: DateStr): boolean {
  return s.endsWith("-01");
}

/** "YYYY-MM" — the cohort a challenge belongs to. */
export function monthKey(s: DateStr): string {
  return s.slice(0, 7);
}

/** "10月6日" */
export function jpDate(s: DateStr): string {
  const [, m, d] = s.split("-").map(Number) as [number, number, number];
  return `${m}月${d}日`;
}

export function jpPeriod(start: DateStr): string {
  return `${jpDate(start)}〜${jpDate(lastDay(start))}`;
}

export type ChallengePhase = "waiting" | "active" | "ended" | "done";

export function challengePhase(c: { startDate: DateStr; status: "active" | "done" }, today: DateStr): ChallengePhase {
  if (c.status === "done") return "done";
  const i = dayIndex(c.startDate, today);
  if (i < 1) return "waiting";
  if (i > TOTAL_DAYS) return "ended";
  return "active";
}

/** Convert a local "HH:MM" reminder in `tz` to the UTC "HH:MM" slot it falls on today. */
export function utcSlotFor(localTime: string, tz: string, now: Date = new Date()): string {
  const [hh, mm] = localTime.split(":").map(Number) as [number, number];
  // Offset of tz at `now` in minutes: format now in tz and compare with UTC.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  const offsetMin = Math.round((asUtc - Math.floor(now.getTime() / 60_000) * 60_000) / 60_000);
  let total = (hh * 60 + mm - offsetMin) % 1440;
  if (total < 0) total += 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** Floor a Date to the UTC "HH:MM" slot on a `stepMinutes` grid. */
export function utcSlotOf(now: Date, stepMinutes: number): string {
  const total = now.getUTCHours() * 60 + now.getUTCMinutes();
  const floored = total - (total % stepMinutes);
  return `${String(Math.floor(floored / 60)).padStart(2, "0")}:${String(floored % 60).padStart(2, "0")}`;
}
