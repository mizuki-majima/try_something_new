/**
 * The notice next to 「30日、始める」 and the post buttons: the Terms say starting or posting
 * means agreeing to them (TermsPage 「この規約について」), so the user is told so where they act.
 */
import { Link } from "react-router";

export function ConsentNote({ action }: { action: "start" | "post" }) {
  return (
    <p className="note consent-note">
      {action === "start" ? "始める" : "投稿する"}と<Link to="/terms">利用規約</Link>と<Link to="/privacy">プライバシーポリシー</Link>
      に同意したことになります。
    </p>
  );
}
