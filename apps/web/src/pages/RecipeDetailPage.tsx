import { usePageTitle } from "../lib/hooks";

/** Placeholder — replaced by the page's owner. */
export default function RecipeDetailPage() {
  usePageTitle("レシピ");
  return (
    <section>
      <h1 className="h2">レシピ</h1>
      <p className="note">準備中</p>
    </section>
  );
}
