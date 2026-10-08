/**
 * /recipes — チャレンジレシピ (SPEC FR-10), in the 「えらぶ」 tab with /gacha (ChooseNav above the h1).
 * The bundled official recipes show at once (also offline); community recipes and the counters merge
 * in when the API answers. Search, category and sort live in the URL (?q=&cat=&sort=) so "back" from
 * a recipe keeps them.
 */
import { useDeferredValue, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { CATEGORY_KEYS, type Category } from "@thirty/shared";
import { ChipGroup, type ChipOption } from "../components/Chip";
import { ChooseNav } from "../components/ChooseNav";
import { EmptyState, Loading } from "../components/States";
import { usePageTitle } from "../lib/hooks";
import { RECIPE_SORTS, filterRecipes, isCategory, isRecipeSort, sortRecipes, useRecipes, type CategoryFilter, type RecipeSort } from "../lib/recipes";
import { CategoryLabel, RecipeCard } from "./recipeParts";

const CATEGORY_OPTIONS: readonly ChipOption<CategoryFilter>[] = [
  { value: "all", label: "すべて" },
  ...CATEGORY_KEYS.map((k: Category) => ({ value: k, label: <CategoryLabel category={k} /> })),
];

const SORT_OPTIONS: readonly ChipOption<RecipeSort>[] = (Object.keys(RECIPE_SORTS) as RecipeSort[]).map((k) => ({
  value: k,
  label: RECIPE_SORTS[k],
}));

export default function RecipesPage() {
  usePageTitle("レシピ");
  const { recipes, loading, error, synced, reload } = useRecipes();
  const [params, setParams] = useSearchParams();
  // The input keeps its own state (IME composition must not round-trip through the router).
  const [q, setQ] = useState(() => params.get("q") ?? "");
  const deferredQ = useDeferredValue(q);
  const catParam = params.get("cat");
  const sortParam = params.get("sort");
  const category: CategoryFilter = isCategory(catParam) ? catParam : "all";
  const sort: RecipeSort = isRecipeSort(sortParam) ? sortParam : "recommended";

  function setParam(key: string, value: string, fallback: string) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (!value || value === fallback) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  }

  const list = useMemo(() => sortRecipes(filterRecipes(recipes, { q: deferredQ, category }), sort), [recipes, deferredQ, category, sort]);
  const filtered = q.trim() !== "" || category !== "all";

  function clearFilters() {
    setQ("");
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("q");
        next.delete("cat");
        return next;
      },
      { replace: true },
    );
  }

  return (
    <section className="stack rp-page" aria-labelledby="rp-title">
      <ChooseNav current="recipes" />
      <div className="pagehead">
        <h1 className="h2" id="rp-title">
          チャレンジレシピ
        </h1>
        <Link to="/recipes/new" className="rp-write">
          ＋ レシピを書く
        </Link>
      </div>
      <p className="note">やり方のコツと「30日後」つき。気になるものを開いて、そのまま始められます。</p>

      <div className="rp-filters">
        <label className="sr-only" htmlFor="rp-q">
          レシピをさがす
        </label>
        <input
          id="rp-q"
          className="search"
          type="search"
          value={q}
          placeholder="さがす（例：写真、5分）"
          enterKeyHint="search"
          autoComplete="off"
          onChange={(e) => {
            setQ(e.target.value);
            setParam("q", e.target.value.trim(), "");
          }}
        />
        <div className="rp-row">
          <span className="gl" id="rp-cat-label">
            ジャンル
          </span>
          <ChipGroup labelledBy="rp-cat-label" className="rp-cats" value={category} options={CATEGORY_OPTIONS} onChange={(v) => setParam("cat", v, "all")} />
        </div>
        <div className="rp-row">
          <span className="gl" id="rp-sort-label">
            並び替え
          </span>
          <ChipGroup labelledBy="rp-sort-label" value={sort} options={SORT_OPTIONS} onChange={(v) => setParam("sort", v, "recommended")} />
        </div>
      </div>

      <div className="row between gap fw rp-status">
        <p className="note" aria-live="polite" data-testid="recipe-count">
          {list.length}件
        </p>
        {loading && !synced && <Loading inline label="みんなのレシピを読み込んでいます…" />}
      </div>
      {error && (
        <p className="rp-notice" role="status">
          みんなのレシピを読み込めませんでした。公式レシピだけを表示しています。
          <button type="button" className="linkbtn" onClick={reload} disabled={loading}>
            {loading ? "読み込んでいます…" : "再試行"}
          </button>
        </p>
      )}

      {list.length > 0 ? (
        <ul className="rlist rp-list">
          {list.map((r) => (
            <li key={r.id}>
              <RecipeCard recipe={r} />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          seal="無"
          title="見つかりませんでした"
          action={
            <div className="row gap fw rp-empty-actions">
              {filtered && (
                <button type="button" className="btn" onClick={clearFilters}>
                  条件をクリア
                </button>
              )}
              <Link to="/recipes/new" className="btn primary">
                ＋ レシピを書く
              </Link>
            </div>
          }
        >
          ことばを変えるか、ジャンルを「すべて」にしてみてください。ないものは、自分で書けます。
        </EmptyState>
      )}
    </section>
  );
}
