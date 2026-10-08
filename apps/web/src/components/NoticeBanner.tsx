/**
 * お知らせ: the in-app notice of the revised Terms and Privacy policy (#17, ADR 0007). The Terms
 * (「規約の変更」) promise to show a change and the day it takes effect on screen before that day.
 *
 * - A band under the header, in the page flow (it never covers the page), on every screen but the
 *   Terms and the Privacy policy, which carry the same notice at their top (改定のお知らせ).
 * - 「閉じる」 hides it on this device. The choice is stored with the effective date, so a new date
 *   shows it again. Storage may be missing or throw: lib/storage guards every access and keeps an
 *   in-memory copy, so the band still renders and still closes without it.
 * - It goes away by itself NOTICE_DAYS after the effective date (the viewer's own date).
 */
import { useState } from "react";
import { Link, useLocation } from "react-router";
import { EFFECTIVE, EFFECTIVE_ON, NOTICE_HIDDEN_FROM } from "../lib/legal";
import { KEYS, readString, writeString } from "../lib/storage";
import { useToday } from "../lib/store";

/** The pages that show this notice themselves. */
const LEGAL_PATHS: ReadonlySet<string> = new Set(["/terms", "/privacy"]);

/** Whether the band shows today: before NOTICE_HIDDEN_FROM, unless closed for this effective date. */
export function noticeVisible(today: string, dismissedFor: string | null): boolean {
  return today < NOTICE_HIDDEN_FROM && dismissedFor !== EFFECTIVE_ON;
}

export function NoticeBanner() {
  const today = useToday();
  const { pathname } = useLocation();
  const [dismissedFor, setDismissedFor] = useState(() => readString(KEYS.noticeNoteShow));
  if (LEGAL_PATHS.has(pathname) || !noticeVisible(today, dismissedFor)) return null;

  const close = () => {
    writeString(KEYS.noticeNoteShow, EFFECTIVE_ON);
    setDismissedFor(EFFECTIVE_ON);
    // The focused button goes away with the band: keep the keyboard on the page, not on <body>.
    document.getElementById("main")?.focus({ preventScroll: true });
  };

  return (
    <section className="notice-band" aria-labelledby="notice-band-h" data-testid="notice-band">
      <div className="notice-in">
        <p className="notice-text">
          <b id="notice-band-h" className="notice-h">
            お知らせ
          </b>{" "}
          {EFFECTIVE}以降、ひとことメモを日ごとに選んで「みんな」に見せられるようになります。選ばないひとことは、今までに書いたものも含めて、これまでどおり自分だけに見えます。
          <Link to="/terms">利用規約とプライバシーポリシーの改定</Link>
        </p>
        <button type="button" className="btn sm notice-close" onClick={close} aria-label="お知らせを閉じる">
          閉じる
        </button>
      </div>
    </section>
  );
}
