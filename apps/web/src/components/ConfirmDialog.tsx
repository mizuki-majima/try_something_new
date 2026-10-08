import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Sheet } from "./Sheet";

/**
 * How long the confirm button ignores presses after the dialog opens. The second tap of a double tap
 * (or the second click of a double click) on the button that opened the dialog can land on the confirm
 * button while the dialog is still appearing (`rise`, 200ms), which would act without the question
 * being seen (#21 review). A timer, not `animationend`: with prefers-reduced-motion there is no animation.
 * Longer than a touch double tap (about 300ms), far shorter than reading the question.
 */
export const CONFIRM_ARM_MS = 400;

type Props = {
  open: boolean;
  title: string;
  message?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Red confirm button for destructive actions. */
  danger?: boolean;
  /** Disables both buttons and blocks closing while the action runs. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * A small centered alertdialog. Focus starts on the cancel button so Enter never destroys by accident,
 * and the confirm button ignores presses for its first CONFIRM_ARM_MS (cancel, Esc and × always work).
 */
export function ConfirmDialog({ open, title, message, confirmLabel, cancelLabel = "やめる", danger = false, busy = false, onConfirm, onCancel }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const messageId = useId();
  return (
    <Sheet
      open={open}
      onClose={onCancel}
      title={title}
      variant="dialog"
      role="alertdialog"
      initialFocus={cancelRef}
      describedBy={message ? messageId : undefined}
      dismissible={!busy}
    >
      {message && (
        <div id={messageId} className="stack" style={{ gap: 8 }}>
          {typeof message === "string" ? <p>{message}</p> : message}
        </div>
      )}
      <ConfirmActions
        cancelRef={cancelRef}
        confirmLabel={confirmLabel}
        cancelLabel={cancelLabel}
        danger={danger}
        busy={busy}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    </Sheet>
  );
}

type ActionsProps = Pick<Props, "confirmLabel" | "danger" | "busy" | "onConfirm" | "onCancel"> & {
  cancelLabel: string;
  cancelRef: RefObject<HTMLButtonElement | null>;
};

/** Mounted with the open panel, so every opening starts unarmed. */
function ConfirmActions({ cancelRef, confirmLabel, cancelLabel, danger, busy, onConfirm, onCancel }: ActionsProps) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setArmed(true), CONFIRM_ARM_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="dialog-actions">
      <button ref={cancelRef} type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
        {cancelLabel}
      </button>
      {/* aria-disabled, not disabled, while arming: the button keeps its place in the focus order and its look (data-arming). */}
      <button
        type="button"
        className={danger ? "btn danger solid" : "btn primary"}
        onClick={armed ? onConfirm : undefined}
        // An ignored press must not move focus here either, or a later Enter would confirm.
        onMouseDown={armed ? undefined : (e) => e.preventDefault()}
        disabled={busy}
        aria-disabled={armed ? undefined : true}
        data-arming={armed ? undefined : ""}
        aria-busy={busy}
      >
        {confirmLabel}
      </button>
    </div>
  );
}
