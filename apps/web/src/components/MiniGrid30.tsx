/** Tiny 15×2 progress strip for the cohort list. */
import { TOTAL_DAYS } from "@thirty/shared";

type Props = {
  stampDays: readonly number[];
  /** Today's day number (dashed outline), or null when not running. */
  today?: number | null;
};

const DAYS = Array.from({ length: TOTAL_DAYS }, (_, i) => i + 1);

export function MiniGrid30({ stampDays, today = null }: Props) {
  const on = new Set(stampDays);
  return (
    <div className="mini" role="img" aria-label={`30日中${on.size}日押した`}>
      {DAYS.map((d) => (
        <i key={d} className={[on.has(d) ? "on" : "", d === today ? "now" : ""].filter(Boolean).join(" ") || undefined} />
      ))}
    </div>
  );
}
