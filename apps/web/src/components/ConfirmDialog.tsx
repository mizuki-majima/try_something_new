import { useId, useRef, type ReactNode } from "react";
import { Sheet } from "./Sheet";

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

/** A small centered alertdialog. Focus starts on the cancel button so Enter never destroys by accident. */
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
      <div className="dialog-actions">
        <button ref={cancelRef} type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </button>
        <button type="button" className={danger ? "btn danger solid" : "btn primary"} onClick={onConfirm} disabled={busy} aria-busy={busy}>
          {confirmLabel}
        </button>
      </div>
    </Sheet>
  );
}
