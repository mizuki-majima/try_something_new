/**
 * Day notes shown in 「みんな」 (#17, ADR 0007). A note is public only when ALL of these hold:
 *   1. the stored stamp's `shownNote` is exactly its current `note` (consent is a copy of the text
 *      the owner chose, so any change of the note makes it private again);
 *   2. the note passes today's public-text rules and is already normalised (isPublicNote);
 *   3. the challenge is listed (isInCohort: projected on gsi1, not hidden by moderation);
 *   4. the owner shares progress, on a fresh read (GET /api/members/:id/notes).
 * Only PUT .../stamps/:day/visibility writes `shownNote`; every other write drops it or leaves it
 * alone. A missing `shownNote` is private, so data written before #17 stays private with no migration.
 * The rules are checked on every read, never trusted from what was stored.
 */
import { TOTAL_DAYS, isPublicNote, type MemberNote } from "@thirty/shared";
import type { Item } from "./util";

/** A stamp as stored (stamps.<day>). `shownNote` never leaves the API. */
export type StoredStamp = { at: number; note?: string; shownNote?: string };

/** Rules 1 and 2 for one stored stamp. */
export function isShownStamp(s: unknown): boolean {
  if (!s || typeof s !== "object") return false;
  const { at, note, shownNote } = s as Partial<Record<keyof StoredStamp, unknown>>;
  return typeof at === "number" && typeof note === "string" && note !== "" && shownNote === note && isPublicNote(note);
}

/**
 * The notes the owner chose to show (rules 1 and 2), by day ascending, whether or not the challenge
 * is listed right now. Public routes use visibleNotes (db/cohorts.ts); the moderator's preview uses
 * this, so a hidden member's chosen notes can be read before restoring it.
 */
export function consentedNotes(item: Item): MemberNote[] {
  const stamps = item.stamps && typeof item.stamps === "object" ? (item.stamps as Record<string, unknown>) : {};
  const notes: MemberNote[] = [];
  for (let day = 1; day <= TOTAL_DAYS; day++) {
    const s = stamps[String(day)];
    if (isShownStamp(s)) notes.push({ day, note: (s as StoredStamp).note! });
  }
  return notes;
}
