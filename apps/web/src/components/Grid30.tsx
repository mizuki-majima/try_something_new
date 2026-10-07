/**
 * The 30-cell stamp card (ラジオ体操カード). Each cell is a button labelled "N日目" (+ "（済）").
 *
 * - `today`: today's day number for this challenge. Cells after it are future: faded and disabled.
 *   Pass the finishedDay for a closed challenge, 0 for one that has not started.
 * - `locked`: the record is fixed (done) or not started; cells are not stamp toggles. Clicks still
 *   reach onCellClick (the detail page opens the day's memo), unless the cell is in the future.
 * - Without onCellClick every cell is disabled (read-only card).
 */
import { TOTAL_DAYS } from "@thirty/shared";

type Props = {
  seal: string;
  stampedDays: readonly number[] | ReadonlySet<number>;
  today: number;
  locked?: boolean;
  /** Day that was just stamped → plays the stamp animation once. */
  justStamped?: number | null;
  /** Day shown as selected (detail page). */
  selectedDay?: number | null;
  onCellClick?: (day: number) => void;
  /** Accessible name of the whole card. */
  label?: string;
  className?: string;
};

const DAYS = Array.from({ length: TOTAL_DAYS }, (_, i) => i + 1);

export function Grid30({ seal, stampedDays, today, locked = false, justStamped, selectedDay, onCellClick, label, className }: Props) {
  const stamped = stampedDays instanceof Set ? stampedDays : new Set(stampedDays as readonly number[]);
  return (
    <div className={className ? `grid30 ${className}` : "grid30"} role="group" aria-label={label ?? "30日のカード"}>
      {DAYS.map((day) => {
        const on = stamped.has(day);
        const isToday = !locked && day === today;
        const future = day > today;
        const disabled = future || !onCellClick;
        const cls = [
          "cell",
          isToday ? "today" : "",
          future ? "future" : "",
          locked ? "locked" : "",
          locked && !disabled ? "clickable" : "",
          selectedDay === day ? "selected" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <button
            key={day}
            type="button"
            className={cls}
            disabled={disabled}
            aria-label={`${day}日目${on ? "（済）" : ""}`}
            aria-pressed={on}
            aria-current={isToday ? "date" : undefined}
            onClick={disabled ? undefined : () => onCellClick?.(day)}
          >
            <span className="n" aria-hidden="true">
              {day}
            </span>
            {on && (
              <span className={justStamped === day ? "st new" : "st"} aria-hidden="true">
                {seal}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
