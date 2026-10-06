import { usePageTitle } from "../lib/hooks";

/** Placeholder — replaced by the page's owner. */
export default function ReflectPage() {
  usePageTitle("振り返り");
  return (
    <section>
      <h1 className="h2">30日の振り返り</h1>
      <p className="note">準備中</p>
    </section>
  );
}
