import { describe, expect, it } from "vitest";
import {
  addDays,
  challengePhase,
  dayIndex,
  isValidDate,
  isValidTimeZone,
  lastDay,
  monthKey,
  nextFirst,
  todayIn,
  utcSlotFor,
  utcSlotOf,
} from "../src/dates";

describe("calendar dates", () => {
  it("validates real dates only", () => {
    expect(isValidDate("2026-10-06")).toBe(true);
    expect(isValidDate("2026-02-29")).toBe(false);
    expect(isValidDate("2028-02-29")).toBe(true);
    expect(isValidDate("2026-13-01")).toBe(false);
    expect(isValidDate("2026-1-1")).toBe(false);
  });

  it("dayIndex counts the start day as day 1, across months and leap days", () => {
    expect(dayIndex("2026-10-01", "2026-10-01")).toBe(1);
    expect(dayIndex("2026-10-01", "2026-10-30")).toBe(30);
    expect(dayIndex("2026-10-01", "2026-09-30")).toBe(0);
    expect(dayIndex("2028-02-28", "2028-03-01")).toBe(3);
    expect(dayIndex("2026-12-31", "2027-01-01")).toBe(2);
  });

  it("lastDay is day 30", () => {
    expect(lastDay("2026-10-01")).toBe("2026-10-30");
    expect(dayIndex("2026-10-01", lastDay("2026-10-01"))).toBe(30);
    expect(addDays("2026-03-28", 5)).toBe("2026-04-02");
  });

  it("nextFirst is the 1st of the following month", () => {
    expect(nextFirst("2026-10-06")).toBe("2026-11-01");
    expect(nextFirst("2026-10-01")).toBe("2026-11-01");
    expect(nextFirst("2026-12-31")).toBe("2027-01-01");
    expect(monthKey("2026-11-01")).toBe("2026-11");
  });

  it("todayIn uses the given time zone", () => {
    const now = new Date("2026-10-06T16:30:00Z");
    expect(todayIn("Asia/Tokyo", now)).toBe("2026-10-07");
    expect(todayIn("UTC", now)).toBe("2026-10-06");
    expect(todayIn("America/Los_Angeles", now)).toBe("2026-10-06");
    expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("challengePhase", () => {
  const start = "2026-10-01";
  it("moves from waiting to active to ended, and done wins", () => {
    expect(challengePhase({ startDate: start, status: "active" }, "2026-09-30")).toBe("waiting");
    expect(challengePhase({ startDate: start, status: "active" }, "2026-10-01")).toBe("active");
    expect(challengePhase({ startDate: start, status: "active" }, "2026-10-30")).toBe("active");
    expect(challengePhase({ startDate: start, status: "active" }, "2026-10-31")).toBe("ended");
    expect(challengePhase({ startDate: start, status: "done" }, "2026-10-05")).toBe("done");
  });
});

describe("reminder slots", () => {
  const october = new Date("2026-10-06T03:00:00Z");
  const january = new Date("2027-01-15T03:00:00Z");

  it("converts JST (UTC+9) to UTC, wrapping to the previous day", () => {
    expect(utcSlotFor("21:00", "Asia/Tokyo", october)).toBe("12:00");
    expect(utcSlotFor("08:15", "Asia/Tokyo", october)).toBe("23:15");
    expect(utcSlotFor("00:00", "Asia/Tokyo", october)).toBe("15:00");
  });

  it("keeps UTC as is", () => {
    expect(utcSlotFor("21:00", "UTC", october)).toBe("21:00");
  });

  it("handles negative offsets and daylight saving time", () => {
    expect(utcSlotFor("21:00", "America/New_York", october)).toBe("01:00"); // EDT, UTC-4
    expect(utcSlotFor("21:00", "America/New_York", january)).toBe("02:00"); // EST, UTC-5
    expect(utcSlotFor("22:30", "Pacific/Honolulu", october)).toBe("08:30"); // UTC-10
  });

  it("handles half-hour offsets", () => {
    expect(utcSlotFor("21:00", "Asia/Kolkata", october)).toBe("15:30");
  });

  it("utcSlotOf floors to the scheduler grid", () => {
    expect(utcSlotOf(new Date("2026-10-06T12:14:59Z"), 15)).toBe("12:00");
    expect(utcSlotOf(new Date("2026-10-06T12:15:00Z"), 15)).toBe("12:15");
  });
});
