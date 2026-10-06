/** Display formatting in the app's voice. Dates are "YYYY-MM-DD" strings (see @thirty/shared dates). */
import { CATEGORIES, PLACES, VERDICTS, type Category, type Place, type Verdict } from "@thirty/shared";

export { jpDate, jpPeriod } from "@thirty/shared";

/** "1日5分" (0 → "1日0分", as in the prototype: it takes no extra time). */
export function minutesLabel(minutes: number): string {
  return `1日${Math.max(0, Math.round(minutes))}分`;
}

export function placeLabel(place: Place): string {
  return PLACES[place] ?? PLACES.any;
}

export function categoryLabel(category: Category): string {
  return CATEGORIES[category] ?? category;
}

export function verdictLabel(verdict: Verdict): string {
  return VERDICTS[verdict].label;
}

function clampDifficulty(d: number): 1 | 2 | 3 {
  return Math.min(3, Math.max(1, Math.round(d) || 1)) as 1 | 2 | 3;
}

/** "きつさ ●○○" */
export function difficultyLabel(d: number): string {
  const n = clampDifficulty(d);
  return `きつさ ${"●".repeat(n)}${"○".repeat(3 - n)}`;
}

/** Screen-reader text for the dots: "きつさ 3段階中1". */
export function difficultyAria(d: number): string {
  return `きつさ 3段階中${clampDifficulty(d)}`;
}

/** The pieces of a recipe meta line: ["1日5分", "どこでも", "きつさ ●○○"]. */
export function recipeMetaPieces(r: { minutes: number; place: Place; difficulty: number }): string[] {
  return [minutesLabel(r.minutes), placeLabel(r.place), difficultyLabel(r.difficulty)];
}

/** "2026-10" → "10月" (with the year when it is not `currentYear`). */
export function jpMonth(month: string, currentYear?: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return currentYear !== undefined && y !== currentYear ? `${y}年${m}月` : `${m}月`;
}

/** Epoch ms → "10月6日 21:05" in the device's time zone. */
export function jpDateTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

/** "3/30" style count used on cards. */
export function countOf30(n: number): string {
  return `${n}/30`;
}
