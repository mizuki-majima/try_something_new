/**
 * Dates of the Terms and the Privacy policy: both pages and the notice band (NoticeBanner) read them
 * from here, so a date is changed in one place.
 *
 * #17 (ADR 0007): the revision that lets an owner show a chosen day note in 「みんな」. The Terms
 * (「規約の変更」) promise to show the new text and the day it takes effect on screen before that day,
 * so this notice ships first (no behaviour change) and the feature is deployed on or after
 * EFFECTIVE_ON. The effective date is pending the CEO's choice (A 2026-10-10 / B 2026-10-14).
 */
import { addDays, type DateStr } from "@thirty/shared";

export const ENACTED_ON: DateStr = "2026-10-06";
export const REVISED_ON: DateStr = "2026-10-07";
export const EFFECTIVE_ON: DateStr = "2026-10-10";

/** The notice band goes away by itself this many days after EFFECTIVE_ON. */
export const NOTICE_DAYS = 14;
/** The first day (in the viewer's time zone) the notice band is no longer shown. */
export const NOTICE_HIDDEN_FROM: DateStr = addDays(EFFECTIVE_ON, NOTICE_DAYS);

/** "2026-10-06" → "2026年10月6日" (the legal pages write the year). */
export function jpFullDate(d: DateStr): string {
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  return `${y}年${m}月${day}日`;
}

export const ENACTED = jpFullDate(ENACTED_ON);
export const REVISED = jpFullDate(REVISED_ON);
export const EFFECTIVE = jpFullDate(EFFECTIVE_ON);
