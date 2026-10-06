/**
 * Start-a-challenge flow (title, seal, start day, nickname). Used by Today, RecipeDetail and Gacha.
 * OWNER: the "today/challenge/reflect/log" page developer. This file is a typed placeholder so other
 * pages can import it while it is being built; keep the props stable.
 */
import type { Recipe, Suggestion } from "@thirty/shared";

export type StartPreset = {
  title?: string;
  seal?: string;
  recipeId?: string | null;
  /** Preselect "next 1st" (1日組). */
  firstOfMonth?: boolean;
};

export type StartChallengeSheetProps = {
  open: boolean;
  onClose: () => void;
  /** Start from a recipe (official or community). */
  recipe?: Pick<Recipe, "id" | "title" | "seal"> | null;
  /** Start from a ひらめき提案 or free input. */
  preset?: StartPreset | Pick<Suggestion, "title" | "seal"> | null;
  /** Called with the new challenge id after it was created (optimistically). Default: navigate to "/". */
  onStarted?: (challengeId: string) => void;
};

export function StartChallengeSheet(_props: StartChallengeSheetProps) {
  return null;
}
