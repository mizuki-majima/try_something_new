import { Link } from "react-router";
import { usePageTitle } from "../lib/hooks";
import "./NotFoundPage.css";

export default function NotFoundPage() {
  usePageTitle("ページが見つかりません");
  return (
    <section className="nf" aria-labelledby="nf-title">
      <p className="nf-sticker" aria-hidden="true">
        404
      </p>
      <h1 id="nf-title" className="nf-title">
        ページが見つかりません
      </h1>
      <p className="nf-text">URL が変わったか、削除された可能性があります。</p>
      <div className="nf-actions">
        <Link to="/" className="btn primary">
          きょうに戻る
        </Link>
        <Link to="/recipes" className="btn">
          レシピを見る
        </Link>
      </div>
    </section>
  );
}
