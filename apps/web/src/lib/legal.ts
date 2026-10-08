/**
 * Dates of the Terms and the Privacy policy: both pages and the notice band (NoticeBanner) read them
 * from here, so a date is changed in one place.
 *
 * #17 (ADR 0007): the revision that lets an owner show a chosen day note in 「みんな」. The Terms
 * (「規約の変更」) promise to show the new text and the day it takes effect on screen before that day,
 * so this notice ships first (no behaviour change) and the feature is deployed on or after
 * EFFECTIVE_ON. The CEO chose 3 days' notice (2026-10-08), counted from the day the notice reaches
 * production (REVISED_ON).
 */
import { addDays, type DateStr } from "@thirty/shared";

export const ENACTED_ON: DateStr = "2026-10-06";
export const REVISED_ON: DateStr = "2026-10-08";
export const EFFECTIVE_ON: DateStr = "2026-10-11";

/** The notice band and the pages' 改定のお知らせ go away by themselves this many days after EFFECTIVE_ON. */
export const NOTICE_DAYS = 14;
/** The first day (in the viewer's time zone) neither notice is shown. */
export const NOTICE_HIDDEN_FROM: DateStr = addDays(EFFECTIVE_ON, NOTICE_DAYS);

/**
 * Whether the notices of this revision still show on `today` (useToday): the band (unless closed) and
 * the 改定のお知らせ at the top of the Terms and the Privacy policy. Their 改定日・適用日 lines stay.
 */
export function noticeShowsOn(today: string): boolean {
  return today < NOTICE_HIDDEN_FROM;
}

/** "2026-10-06" → "2026年10月6日" (the legal pages write the year). */
export function jpFullDate(d: DateStr): string {
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  return `${y}年${m}月${day}日`;
}

export const ENACTED = jpFullDate(ENACTED_ON);
export const REVISED = jpFullDate(REVISED_ON);
export const EFFECTIVE = jpFullDate(EFFECTIVE_ON);
