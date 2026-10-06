import { usePageTitle } from "../lib/hooks";

/** Placeholder — replaced by the page's owner. */
export default function GachaPage() {
  usePageTitle("ガチャ");
  return (
    <section>
      <h1 className="h2">次の30日ガチャ</h1>
      <p className="note">準備中</p>
    </section>
  );
}
