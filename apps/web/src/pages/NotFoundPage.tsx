import { Link } from "react-router";
import { EmptyState } from "../components/States";
import { usePageTitle } from "../lib/hooks";

export default function NotFoundPage() {
  usePageTitle("ページが見つかりません");
  return (
    <section className="stack">
      <h1 className="h2">ページが見つかりません</h1>
      <EmptyState
        seal="無"
        title="このページはありません"
        action={
          <Link to="/" className="btn primary">
            きょうに戻る
          </Link>
        }
      >
        URLが変わったか、削除された可能性があります。
      </EmptyState>
    </section>
  );
}
