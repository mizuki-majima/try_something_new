import { usePageTitle } from "../lib/hooks";

/** Placeholder — replaced by the page's owner. */
export default function RecipeNewPage() {
  usePageTitle("レシピを書く");
  return (
    <section>
      <h1 className="h2">レシピを書く</h1>
      <p className="note">準備中</p>
    </section>
  );
}
