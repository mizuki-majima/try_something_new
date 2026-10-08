/**
 * 「みんなに見せる」 under a day's ひとこと (#17). Off by default. Turning it on first saves a draft
 * still in the field, then asks in a sheet that previews the note exactly as 「みんな」 will show it;
 * the store sends the choice online only and never optimistically, so the switch (and the field's
 * label) moves when the server has confirmed. Turning it off needs no question. The switch stays on
 * while the server still shows the note (a queued write that makes it private), so turning it off,
 * which skips the queue, withdraws the old text at once.
 */
import { useId, useRef, useState } from "react";
import { NOTE_SHOW_ERRORS, NOTE_SHOW_STATUS, NOTE_SHOW_TOASTS, cleanNote, notShowableReason } from "../lib/noteShare";
import { useAppActions, useStillShown, useSync, useUser } from "../lib/store";
import { ConsentNote } from "./ConsentNote";
import { MemberNoteList } from "./MemberNotes";
import { Sheet } from "./Sheet";
import { useToast } from "./Toast";
import "./NoteShareSwitch.css";

type Props = {
  challengeId: string;
  day: number;
  /** The saved note (the store's copy). */
  note: string;
  /** stamp.shown: the server says this note is shown. */
  shown: boolean;
  /** The field's text when it may differ from `note` (typed, not saved yet). */
  draft?: string;
  /**
   * Saves the draft (setNote) before asking. False when it could not be saved (the caller said why).
   * Absent when the note cannot be edited any more (a reflected challenge).
   */
  onSaveDraft?: () => boolean;
  /** When saving the field last made this shown note private (useShownNoteEdit), else 0. */
  resetAt?: number;
};

/** How soon after resetAt a click with no press seen here (a screen reader's) still means the switch as it was: on. */
const RESET_CLICK_MS = 1000;
/** The toasts that say the old text is still seen take three lines on a phone. */
const LONG_TOAST_MS = 5000;

/**
 * After saving another text for a shown note: `edited` says where the note stands, and `resetAt` is
 * when it happened (for NoteShareSwitch). The server makes the note private when the edit arrives, so
 * the toast says "done" only then; while the edit is queued (offline, or a retry) it says that the old
 * text is still seen until it is sent.
 */
export function useShownNoteEdit(): { resetAt: number; edited: (challengeId: string, day: number) => void } {
  const { afterShownNoteEdit } = useAppActions();
  const toast = useToast();
  const [resetAt, setResetAt] = useState(0);
  return {
    resetAt,
    edited(challengeId, day) {
      setResetAt(Date.now());
      void afterShownNoteEdit(challengeId, day).then((state) => {
        // "kept": the edit was refused (the queue's notice said why) and the note is shown as before.
        if (state === "private") toast(NOTE_SHOW_TOASTS.reset);
        else if (state === "queued") toast(NOTE_SHOW_TOASTS.resetQueued, { durationMs: LONG_TOAST_MS });
      });
    },
  };
}

/**
 * After undoing a stamp: the switch is gone with the stamp, so a note the server still shows is taken
 * back at once when online (the undo may wait in the queue). While it is still seen (offline, or that
 * failed too), say so.
 */
export function useUnstampedNoteToast(): (challengeId: string, day: number) => void {
  const { afterShownNoteEdit } = useAppActions();
  const toast = useToast();
  return (challengeId, day) => {
    void afterShownNoteEdit(challengeId, day, { withdraw: true }).then((state) => {
      if (state === "queued") toast(NOTE_SHOW_TOASTS.unstampQueued, { durationMs: LONG_TOAST_MS });
    });
  };
}

export function NoteShareSwitch({ challengeId, day, note, shown, draft = note, onSaveDraft, resetAt = 0 }: Props) {
  const { setNoteShown } = useAppActions();
  const user = useUser();
  const { online } = useSync();
  const toast = useToast();
  const statusId = useId();
  const stillShown = useStillShown(challengeId, day);
  // On while the server shows the note, also while a queued write that makes it private waits.
  const on = shown || stillShown;
  const [busy, setBusy] = useState(false);
  // What the switch said when it was pressed (a pointer or Space). A press moves focus out of the
  // field first, and saving there may already have made the note private (the switch re-renders as
  // off) before the click.
  const pressedOn = useRef<boolean | null>(null);
  // The cleaned text the sheet shows while it asks; the store refuses to show any other.
  const [asking, setAsking] = useState<string | null>(null);

  const unsaved = draft !== note;
  // What would be shown: the draft as the API will store it (null: it cannot be saved as it is).
  const cleaned = unsaved ? cleanNote(draft) : note;
  const hasText = cleaned === null ? draft.trim() !== "" : cleaned !== "";
  const blocked = cleaned ? notShowableReason(cleaned) : null;
  // Without an account yet, progress will be shown (the default).
  const progressOn = user?.shareProgress !== false;

  // Nothing here says a note is private while the server still shows it (a queued write).
  let status: string;
  if (shown && progressOn) status = onSaveDraft ? NOTE_SHOW_STATUS.on : NOTE_SHOW_STATUS.onFixed;
  else if (shown) status = stillShown ? NOTE_SHOW_STATUS.unsentProgressOff : NOTE_SHOW_STATUS.shownProgressOff;
  else if (stillShown) status = online ? NOTE_SHOW_STATUS.unsent : NOTE_SHOW_STATUS.unsentOffline;
  else if (!hasText) status = NOTE_SHOW_STATUS.empty;
  else if (!progressOn) status = NOTE_SHOW_STATUS.progressOff;
  else status = blocked ?? NOTE_SHOW_STATUS.off;
  // Turning it off is always possible; turning it on only when it can succeed. Never disabled while
  // busy: a focused input that becomes disabled drops keyboard focus to the page (aria-disabled).
  const disabled = !on && (!hasText || !progressOn || blocked !== null);

  function turnOn() {
    if (!online) {
      toast(NOTE_SHOW_ERRORS.offline, { tone: "error" });
      return;
    }
    if (unsaved && onSaveDraft && !onSaveDraft()) return;
    const seen = unsaved ? cleanNote(draft) : note;
    if (!seen) return;
    const reason = notShowableReason(seen);
    if (reason) {
      toast(reason, { tone: "error" });
      return;
    }
    setAsking(seen);
  }

  async function show() {
    if (asking === null || busy) return;
    setBusy(true);
    const r = await setNoteShown(challengeId, day, true, asking);
    setBusy(false);
    setAsking(null);
    if (r.ok) toast(NOTE_SHOW_TOASTS.shown);
    else toast(r.message, { tone: "error" });
  }

  async function turnOff() {
    setBusy(true);
    const r = await setNoteShown(challengeId, day, false);
    setBusy(false);
    if (r.ok) toast(NOTE_SHOW_TOASTS.hidden);
    else toast(r.message, { tone: "error" });
  }

  return (
    <div className="ns">
      <label
        className="ns-switch"
        onPointerDown={() => {
          pressedOn.current = on;
        }}
        onPointerCancel={() => {
          pressedOn.current = null; // a scroll that started on the switch: no click follows
        }}
      >
        <input
          type="checkbox"
          role="switch"
          className="ns-toggle"
          checked={on}
          disabled={disabled}
          aria-describedby={statusId}
          aria-disabled={busy || undefined}
          aria-busy={busy || undefined}
          onKeyDown={(e) => {
            if (e.key === " ") pressedOn.current = on;
          }}
          onBlur={() => {
            pressedOn.current = null;
          }}
          onChange={() => {
            // A click with no press seen here (a screen reader's) right after saving the field made
            // the note private was meant for the switch as it was: on.
            const wasOn = pressedOn.current ?? (on || Date.now() - resetAt < RESET_CLICK_MS);
            pressedOn.current = null;
            if (busy) return; // the controlled input goes back to `on`
            if (!wasOn) turnOn();
            else if (on) void turnOff();
            // else: pressed while on, and saving the field on the way already made it private (its
            // toast said so). Never read that as "show the new text".
          }}
        />
        <span>みんなに見せる</span>
      </label>
      <p className="note ns-status" id={statusId}>
        {status}
      </p>
      <Sheet open={asking !== null} onClose={() => setAsking(null)} title="このひとことを「みんな」に見せますか？" dismissible={!busy}>
        <div className="ns-ask">
          <div className="ns-preview">
            <p className="note">「みんな」の「詳しく見る」では、こう見えます</p>
            <MemberNoteList notes={[{ day, note: asking ?? "" }]} />
          </div>
          <ul className="ns-points">
            <li>アカウントがない人も含めて、誰でも見られます。</li>
            <li>見せるのは、この日のひとことだけです。ほかの日のひとことが見えるかどうかは変わりません。写真はどの日も自分だけに見えます。</li>
            <li>名前や連絡先、URL、ほかの人のことは書かないでください。</li>
            <li>「自分だけ」には、つながっているときならいつでも戻せます。書き換えたときも、送信が終わると「自分だけ」に戻ります。</li>
          </ul>
          <ConsentNote action="show" />
          <div className="dialog-actions">
            <button type="button" className="btn ghost" onClick={() => setAsking(null)} disabled={busy}>
              やめておく
            </button>
            <button type="button" className="btn primary" onClick={() => void show()} disabled={busy} aria-busy={busy}>
              見せる
            </button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}
