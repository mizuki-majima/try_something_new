/**
 * Calendar reminders as an alternative to Web Push (FR-14): a Google Calendar "add event" link and
 * an .ics file, both with one daily repeating event for the days left in a challenge.
 *
 * Times are floating local times (no time zone): "21:00" means 21:00 wherever the user's calendar is,
 * which is what a daily habit reminder wants. Everything here is pure and unit-tested.
 */
import { TOTAL_DAYS, addDays, dayIndex, type Challenge } from "@thirty/shared";

export type ReminderEvent = {
  /** Challenge title (the event is titled 「30日だけ：<title>」). */
  title: string;
  /** First occurrence, YYYY-MM-DD. */
  startDate: string;
  /** Number of daily occurrences (>= 1). */
  count: number;
  /** Local "HH:MM". */
  time: string;
  /** Link back to the app, put in the description (and the ics URL property). */
  url: string;
  /** Stable unique id for the ics UID (e.g. the challenge id). */
  uid: string;
  /** Event length; default 10 minutes. */
  durationMinutes?: number;
};

export const REMINDER_EVENT_MINUTES = 10;

/** When the reminder series starts and how many days it covers, or null when nothing is left. */
export function reminderSchedule(
  c: Pick<Challenge, "startDate" | "status">,
  today: string,
): { startDate: string; count: number } | null {
  if (c.status === "done") return null;
  const day = dayIndex(c.startDate, today);
  if (day < 1) return { startDate: c.startDate, count: TOTAL_DAYS };
  if (day > TOTAL_DAYS) return null;
  return { startDate: today, count: TOTAL_DAYS - day + 1 };
}

export function eventTitle(title: string): string {
  return `30日だけ：${title}`;
}

export function eventDetails(url: string): string {
  return `「30日だけ」を開いて、きょうの分の印を押す。\n${url}`;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseTime(time: string): [number, number] {
  const m = TIME_RE.exec(time);
  if (!m) return [21, 0];
  return [Number(m[1]), Number(m[2])];
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-10-06" + "21:00" (+ minutes) → "20261006T210000" (floating local time). */
export function localStamp(date: string, time: string, plusMinutes = 0): string {
  const [hh, mm] = parseTime(time);
  const total = hh * 60 + mm + plusMinutes;
  const dayShift = Math.floor(total / 1440);
  const minutes = ((total % 1440) + 1440) % 1440;
  const d = dayShift === 0 ? date : addDays(date, dayShift);
  return `${d.replace(/-/g, "")}T${pad(Math.floor(minutes / 60))}${pad(minutes % 60)}00`;
}

/** UTC timestamp for DTSTAMP: "20261006T120000Z". */
export function utcStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Escape a TEXT value (RFC 5545 3.3.11): backslash, semicolon, comma and newlines. */
export function icsEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

const encoder = new TextEncoder();

/** Fold a content line at 75 octets (RFC 5545 3.1) without splitting a UTF-8 character. */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let cur = "";
  let bytes = 0;
  // Continuation lines start with a space, which counts toward their 75 octets.
  let limit = 75;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    if (bytes + n > limit) {
      parts.push(cur);
      cur = "";
      bytes = 0;
      limit = 74;
    }
    cur += ch;
    bytes += n;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

/** A VCALENDAR with one daily repeating VEVENT (CRLF line endings, folded, escaped). */
export function buildIcs(ev: ReminderEvent, now: Date = new Date()): string {
  const minutes = ev.durationMinutes ?? REMINDER_EVENT_MINUTES;
  const count = Math.max(1, Math.floor(ev.count));
  const summary = eventTitle(ev.title);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//30days//thirty-days reminder//JA",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${ev.uid.replace(/[^0-9A-Za-z@._-]/g, "")}@thirty-days`,
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART:${localStamp(ev.startDate, ev.time)}`,
    `DURATION:PT${minutes}M`,
    `RRULE:FREQ=DAILY;COUNT=${count}`,
    `SUMMARY:${icsEscape(summary)}`,
    `DESCRIPTION:${icsEscape(eventDetails(ev.url))}`,
    `URL:${ev.url}`,
    "TRANSP:TRANSPARENT",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsEscape(summary)}`,
    "TRIGGER:PT0M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** Google Calendar "create event" link with the same daily series. */
export function googleCalendarUrl(ev: ReminderEvent, tz?: string): string {
  const minutes = ev.durationMinutes ?? REMINDER_EVENT_MINUTES;
  const count = Math.max(1, Math.floor(ev.count));
  const params: [string, string][] = [
    ["action", "TEMPLATE"],
    ["text", eventTitle(ev.title)],
    ["dates", `${localStamp(ev.startDate, ev.time)}/${localStamp(ev.startDate, ev.time, minutes)}`],
    ["recur", `RRULE:FREQ=DAILY;COUNT=${count}`],
    ["details", eventDetails(ev.url)],
  ];
  if (tz) params.push(["ctz", tz]);
  return `https://calendar.google.com/calendar/render?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
}

export const ICS_FILE_NAME = "30days-reminder.ics";

/** Start a download of the .ics file in the browser. */
export function downloadIcs(ev: ReminderEvent, fileName = ICS_FILE_NAME): void {
  const blob = new Blob([buildIcs(ev)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
