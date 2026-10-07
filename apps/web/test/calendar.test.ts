import { describe, expect, it } from "vitest";
import {
  buildIcs,
  eventTitle,
  foldLine,
  googleCalendarUrl,
  icsEscape,
  localStamp,
  reminderSchedule,
  utcStamp,
  type ReminderEvent,
} from "../src/lib/calendar";

const ev: ReminderEvent = {
  title: "毎日1枚、写真を撮る",
  startDate: "2026-10-06",
  count: 25,
  time: "21:00",
  url: "https://example.test/c/abc123def456",
  uid: "abc123def456",
};

const octets = (s: string) => new TextEncoder().encode(s).length;

/** RFC 5545 unfolding: a CRLF followed by one space or tab continues the previous line. */
const unfold = (ics: string) => ics.replace(/\r\n[ \t]/g, "");

describe("reminderSchedule", () => {
  it("covers all 30 days of a reservation, from its start", () => {
    expect(reminderSchedule({ startDate: "2026-11-01", status: "active" }, "2026-10-06")).toEqual({ startDate: "2026-11-01", count: 30 });
  });

  it("covers the remaining days (today included) of a running challenge", () => {
    // Day 6 today → days 6..30 = 25 events starting today.
    expect(reminderSchedule({ startDate: "2026-10-01", status: "active" }, "2026-10-06")).toEqual({ startDate: "2026-10-06", count: 25 });
    expect(reminderSchedule({ startDate: "2026-09-07", status: "active" }, "2026-10-06")).toEqual({ startDate: "2026-10-06", count: 1 });
  });

  it("returns null when nothing is left", () => {
    expect(reminderSchedule({ startDate: "2026-09-01", status: "active" }, "2026-10-06")).toBeNull();
    expect(reminderSchedule({ startDate: "2026-10-01", status: "done" }, "2026-10-06")).toBeNull();
  });
});

describe("date/time stamps", () => {
  it("formats floating local times and rolls over midnight", () => {
    expect(localStamp("2026-10-06", "21:00")).toBe("20261006T210000");
    expect(localStamp("2026-10-06", "07:15", 10)).toBe("20261006T072500");
    expect(localStamp("2026-10-31", "23:55", 10)).toBe("20261101T000500");
    expect(localStamp("2026-12-31", "23:50", 15)).toBe("20270101T000500");
  });

  it("formats DTSTAMP in UTC", () => {
    expect(utcStamp(new Date("2026-10-06T12:34:56.789Z"))).toBe("20261006T123456Z");
  });
});

describe("icsEscape / foldLine", () => {
  it("escapes backslash, semicolon, comma and newlines", () => {
    expect(icsEscape("a\\b;c,d\ne\r\nf")).toBe("a\\\\b\\;c\\,d\\ne\\nf");
  });

  it("folds at 75 octets without splitting UTF-8 characters", () => {
    const line = `SUMMARY:${"写真を撮る".repeat(12)}`;
    const folded = foldLine(line);
    const parts = folded.split("\r\n");
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(octets(p)).toBeLessThanOrEqual(75);
    for (const p of parts.slice(1)) expect(p.startsWith(" ")).toBe(true);
    expect(unfold(folded)).toBe(line);
    expect(folded).not.toContain("�");
  });

  it("leaves short lines alone", () => {
    expect(foldLine("VERSION:2.0")).toBe("VERSION:2.0");
  });
});

describe("buildIcs", () => {
  const ics = buildIcs(ev, new Date("2026-10-06T00:00:00Z"));
  const lines = unfold(ics).split("\r\n");

  it("is a VCALENDAR with CRLF line endings only", () => {
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    for (const raw of ics.split("\r\n")) expect(octets(raw)).toBeLessThanOrEqual(75);
    expect(lines).toContain("VERSION:2.0");
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    expect(lines.filter((l) => l === "END:VEVENT")).toHaveLength(1);
  });

  it("repeats daily for the remaining days at a floating local time", () => {
    expect(lines).toContain("DTSTART:20261006T210000");
    expect(lines).toContain("DURATION:PT10M");
    expect(lines).toContain("RRULE:FREQ=DAILY;COUNT=25");
    expect(lines).toContain("DTSTAMP:20261006T000000Z");
    expect(lines.some((l) => l.startsWith("DTSTART") && (l.endsWith("Z") || l.includes("TZID")))).toBe(false);
    expect(lines.some((l) => /^UID:abc123def456@/.test(l))).toBe(true);
  });

  it("escapes the title and links back to the site", () => {
    expect(lines).toContain(`SUMMARY:${icsEscape(eventTitle(ev.title))}`);
    // "、" is not an ASCII comma, so it stays as is.
    expect(lines).toContain("SUMMARY:30日だけ：毎日1枚、写真を撮る");
    const desc = lines.find((l) => l.startsWith("DESCRIPTION:「30日だけ」"));
    expect(desc).toBe("DESCRIPTION:「30日だけ」を開いて、きょうの分の印を押す。\\nhttps://example.test/c/abc123def456");
    expect(lines).toContain("URL:https://example.test/c/abc123def456");
  });

  it("escapes commas and semicolons in user text", () => {
    const tricky = unfold(buildIcs({ ...ev, title: "走る, 歩く; 休む" }));
    expect(tricky).toContain("SUMMARY:30日だけ：走る\\, 歩く\\; 休む");
  });

  it("has a display alarm at the event time", () => {
    const i = lines.indexOf("BEGIN:VALARM");
    expect(i).toBeGreaterThan(0);
    expect(lines.slice(i, i + 5)).toContain("TRIGGER:PT0M");
    expect(lines.slice(i, i + 5)).toContain("ACTION:DISPLAY");
  });
});

describe("googleCalendarUrl", () => {
  it("creates a daily event template with the right dates and recurrence", () => {
    const url = new URL(googleCalendarUrl(ev, "Asia/Tokyo"));
    expect(url.origin + url.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("text")).toBe("30日だけ：毎日1枚、写真を撮る");
    expect(url.searchParams.get("dates")).toBe("20261006T210000/20261006T211000");
    expect(url.searchParams.get("recur")).toBe("RRULE:FREQ=DAILY;COUNT=25");
    expect(url.searchParams.get("details")).toContain("https://example.test/c/abc123def456");
    expect(url.searchParams.get("ctz")).toBe("Asia/Tokyo");
  });

  it("omits ctz without a time zone", () => {
    expect(new URL(googleCalendarUrl(ev)).searchParams.has("ctz")).toBe(false);
  });
});
