/** Derived, display-oriented facts about a challenge. Pure; shared by the きょう/詳細/記録 pages. */
import {
  EARLY_REFLECT_FROM_DAY,
  TOTAL_DAYS,
  VERDICTS,
  challengePhase,
  dayIndex,
  diffDays,
  isFirstOfMonth,
  lastDay,
  type Challenge,
  type ChallengePhase,
  type Verdict,
} from "@thirty/shared";

export type ChallengeView = {
  phase: ChallengePhase;
  /** Day number of today (may be < 1 before the start or > 30 after the end). */
  day: number;
  /** The last day that can hold a stamp today: 0 while waiting, finishedDay once done. */
  maxDay: number;
  stampedDays: number[];
  stampCount: number;
  todayStamped: boolean;
  /** Ended, or active from day 7 ("ここで区切る"). */
  canReflect: boolean;
  /** Days until the start (waiting only, otherwise 0). */
  daysUntilStart: number;
  /** Started on the 1st → member of a "1日組". */
  firstOfMonth: boolean;
  endDate: string;
};

export function stampedDays(c: Pick<Challenge, "stamps">): number[] {
  return Object.keys(c.stamps)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= TOTAL_DAYS)
    .sort((a, b) => a - b);
}

export function viewChallenge(c: Challenge, today: string): ChallengeView {
  const phase = challengePhase(c, today);
  const day = dayIndex(c.startDate, today);
  const days = stampedDays(c);
  const maxDay =
    phase === "done" ? (c.finishedDay ?? TOTAL_DAYS) : phase === "waiting" ? 0 : Math.min(day, TOTAL_DAYS);
  return {
    phase,
    day,
    maxDay,
    stampedDays: days,
    stampCount: days.length,
    todayStamped: phase === "active" && days.includes(day),
    canReflect: phase === "ended" || (phase === "active" && day >= EARLY_REFLECT_FROM_DAY),
    daysUntilStart: phase === "waiting" ? diffDays(today, c.startDate) : 0,
    firstOfMonth: isFirstOfMonth(c.startDate),
    endDate: lastDay(c.startDate),
  };
}

/** Not reflected yet: waiting, active or ended. These count toward LIMITS.openChallenges. */
export function isOpen(c: Challenge): boolean {
  return c.status !== "done";
}

const PHASE_ORDER: Record<ChallengePhase, number> = { ended: 0, active: 1, waiting: 2, done: 3 };

/** Ended first (they need a decision), then active by start date, then reservations. */
export function sortForToday(list: readonly Challenge[], today: string): Challenge[] {
  return [...list].sort((a, b) => {
    const pa = PHASE_ORDER[challengePhase(a, today)];
    const pb = PHASE_ORDER[challengePhase(b, today)];
    return pa - pb || a.startDate.localeCompare(b.startDate) || a.createdAt - b.createdAt;
  });
}

export function verdictLabel(v: Verdict): string {
  return VERDICTS[v].label;
}
