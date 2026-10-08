/**
 * Asks before a reservation starts today instead (#21). Moving a reserved start (the next 1st = 1日組,
 * or any other future day) to today takes the challenge out of that day's group, so every screen that
 * can do it (きょう's 「今日から始める」, the edit sheet's 「今日から」) asks first. 「やめておく」 sends
 * and queues nothing: the reservation stays as it was.
 */
import { isFirstOfMonth, jpDate } from "@thirty/shared";
import { ConfirmDialog } from "../../components/ConfirmDialog";

export const START_TODAY_TITLE = "今日から始めますか？";

/** The dialog's one line: what the participant gives up. Pure, so each wording can be tested. */
export function startTodayMessage(reservedStart: string, today: string): string {
  if (!isFirstOfMonth(reservedStart)) return `予約していた${jpDate(reservedStart)}ではなく、今日から始めます。`;
  // Today may be a 1st too (a reservation for next month made on the 1st): then today's group takes them in.
  if (isFirstOfMonth(today)) return `${jpDate(reservedStart)}の1日組から外れて、今日（${jpDate(today)}）の1日組で始めます。`;
  return `${jpDate(reservedStart)}の1日組から外れます。`;
}

/** True when `nextStart` moves a reserved (future) start to today: the change that must be confirmed. */
export function movesReservationToToday(reservedStart: string, nextStart: string | undefined, today: string): boolean {
  return nextStart === today && reservedStart > today;
}

type Props = {
  open: boolean;
  /** The reserved start date (YYYY-MM-DD, after today). */
  reservedStart: string;
  today: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function StartTodayConfirm({ open, reservedStart, today, onConfirm, onCancel }: Props) {
  return (
    <ConfirmDialog
      open={open}
      title={START_TODAY_TITLE}
      message={startTodayMessage(reservedStart, today)}
      confirmLabel="今日から始める"
      cancelLabel="やめておく"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
