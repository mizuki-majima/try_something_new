/**
 * Modal sheet: a bottom sheet on phones, a centered panel from 760px (variant "dialog" is always
 * centered and small). role=dialog + aria-modal, titled, focus kept inside, Esc / backdrop close,
 * focus returns to the opener. Rendered in a portal on <body>.
 */
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "./Icons";

export type SheetProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  variant?: "sheet" | "dialog";
  role?: "dialog" | "alertdialog";
  /** Element to focus when opened. Defaults to the panel itself (no keyboard pop-up on phones). */
  initialFocus?: RefObject<HTMLElement | null>;
  /** id of the element describing the dialog (alertdialog message). */
  describedBy?: string;
  /** Block Esc / backdrop close (e.g. while saving). */
  dismissible?: boolean;
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let openCount = 0;

export function Sheet(props: SheetProps) {
  if (!props.open || typeof document === "undefined") return null;
  return createPortal(<SheetPanel {...props} />, document.body);
}

function SheetPanel({ onClose, title, children, variant = "sheet", role = "dialog", initialFocus, describedBy, dismissible = true }: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = () => {
    if (dismissible) onClose();
  };

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (initialFocus?.current ?? panelRef.current)?.focus();
    openCount++;
    document.body.classList.add("is-locked");
    return () => {
      openCount--;
      if (openCount === 0) document.body.classList.remove("is-locked");
      if (opener?.isConnected) opener.focus();
    };
    // Focus only on open; initialFocus is read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    e.stopPropagation();
    const panel = panelRef.current;
    if (!panel) return;
    const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("[hidden]"));
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="sheet-root" onKeyDown={onKeyDown}>
      <div className="sheet-bg" onClick={() => close()} aria-hidden="true" />
      <div
        ref={panelRef}
        className={variant === "dialog" ? "sheet-panel dialog" : "sheet-panel"}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
      >
        <div className="sheet-head">
          <h2 className="sheet-title" id={titleId}>
            {title}
          </h2>
          <button type="button" className="iconbtn" onClick={() => close()} aria-label="閉じる" disabled={!dismissible}>
            <CloseIcon />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
