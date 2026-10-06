import type { ReactNode } from "react";
import type { Place } from "@thirty/shared";
import { difficultyAria, difficultyLabel, minutesLabel, placeLabel } from "../lib/format";

type Props = {
  recipe: { minutes: number; place: Place; difficulty: number };
  /** Extra tags after the line (体験談あり, 投稿, AI案 …). */
  children?: ReactNode;
};

/** "1日5分 · どこでも · きつさ ●○○" as in the prototype's recipe cards. */
export function RecipeMeta({ recipe, children }: Props) {
  return (
    <span className="meta">
      <span>{minutesLabel(recipe.minutes)}</span>
      <span>{placeLabel(recipe.place)}</span>
      <span>
        <span aria-hidden="true">{difficultyLabel(recipe.difficulty)}</span>
        <span className="sr-only">{difficultyAria(recipe.difficulty)}</span>
      </span>
      {children}
    </span>
  );
}
