import { HttpError, MESSAGES } from "../errors";
import type { SuggestionProvider } from "../ports";

/** Placeholder until the rule-based provider exists: the endpoint answers 503 ai_unavailable. */
export class UnavailableSuggestionProvider implements SuggestionProvider {
  async suggest(): Promise<never> {
    throw new HttpError(503, "ai_unavailable", MESSAGES.suggestionsUnavailable);
  }
}

/**
 * Hook for "ひらめき提案" (FR-13, ADR 0003): filter the built-in ideas (about 60, separate from the
 * official recipes) by minutes / category / place, rank by keyword overlap with the hint, return up to 3.
 * No generative AI and no external calls; the hint is never stored.
 * TODO(suggestions): return the rule-based provider here.
 */
export function createSuggestionProvider(): SuggestionProvider {
  return new UnavailableSuggestionProvider();
}
