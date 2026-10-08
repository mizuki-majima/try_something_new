/**
 * The notice next to 「30日、始める」, the post buttons and 「見せる」 (a day note in 「みんな」): the Terms
 * say starting or posting means agreeing to them (TermsPage 「この規約について」), so the user is told
 * so where they act.
 */
import { Link } from "react-router";

const VERBS = { start: "始める", post: "投稿する", show: "見せる" } as const;

export function ConsentNote({ action }: { action: keyof typeof VERBS }) {
  return (
    <p className="note consent-note">
      {VERBS[action]}と<Link to="/terms">利用規約</Link>と<Link to="/privacy">プライバシーポリシー</Link>
      に同意したことになります。
    </p>
  );
}
