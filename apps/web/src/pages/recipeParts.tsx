/**
 * Small pieces shared by the recipe pages and the gacha: category sticker, recipe tags,
 * the list card and the "how / after" blocks. Styles: ./recipes.css.
 */
import type { ReactNode } from "react";
import { Link } from "react-router";
import { CATEGORIES, type Category, type Recipe } from "@thirty/shared";
import { RecipeMeta } from "../components/RecipeMeta";
import { Seal } from "../components/Seal";
import "./recipes.css";

/** Label for "30日後" — always a possibility, never a promise about results. */
export const AFTER_LABEL = "30日後に起こりそうなこと";

export function CategoryTag({ category }: { category: Category }) {
  return <span className={`cat-tag cat-${category}`}>{CATEGORIES[category] ?? category}</span>;
}

/** Category chip label with its colour dot (the dot is decorative). */
export function CategoryLabel({ category }: { category: Category }) {
  return (
    <>
      <span className={`cat-dot cat-${category}`} aria-hidden="true" />
      {CATEGORIES[category]}
    </>
  );
}

/** 体験談あり / みんなの投稿 / あなたの投稿 / N回はじめられました (startCount counts starts, not people). */
export function RecipeTags({ recipe }: { recipe: Recipe }) {
  return (
    <>
      {recipe.storyCount > 0 && <span className="tag story">体験談あり</span>}
      {recipe.isMine ? (
        <span className="tag rp-mine">あなたの投稿</span>
      ) : (
        recipe.source === "community" && <span className="tag rp-community">みんなの投稿</span>
      )}
      {recipe.startCount > 0 && <span className="tag">{recipe.startCount}回はじめられました</span>}
    </>
  );
}

export function RecipeCard({ recipe }: { recipe: Recipe }) {
  return (
    <Link to={`/recipes/${encodeURIComponent(recipe.id)}`} className={`recipe rp-card cat-${recipe.category}`} data-testid="recipe-card">
      <Seal char={recipe.seal} />
      <span className="rc">
        <span className="t rp-title">{recipe.title}</span>
        <span className="s">{recipe.summary}</span>
        <RecipeMeta recipe={recipe}>
          <CategoryTag category={recipe.category} />
          <RecipeTags recipe={recipe} />
        </RecipeMeta>
      </span>
    </Link>
  );
}

export function HowList({ how }: { how: readonly string[] }) {
  const items = how.filter((h) => h.trim() !== "");
  if (items.length === 0) return null;
  return (
    <ol className="how rp-how">
      {items.map((h, i) => (
        <li key={i}>{h}</li>
      ))}
    </ol>
  );
}

/** A titled block inside a recipe-like card (何をする / やり方のコツ / 30日後…). */
export function RecipeSection({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section className="rp-section" aria-labelledby={id}>
      <h2 className="h3" id={id}>
        {title}
      </h2>
      {children}
    </section>
  );
}
