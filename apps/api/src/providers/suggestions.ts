/**
 * "ひらめき提案" (FR-13, ADR 0003): rule-based, over the built-in ideas in suggestion-ideas.ts.
 * No generative AI and no external calls. The hint is only matched in memory, never stored or logged.
 *
 * 1. Filter by category / place / maxMinutes. An idea for place "any" fits every place filter, and
 *    the place filter "any" (or none) accepts every idea. maxMinutes undefined = no limit.
 * 2. Score against the hint: +3 for every tag contained in the hint, plus a small bonus for
 *    2-character pieces (kanji / katakana / latin) shared by the hint and the title or summary.
 * 3. Take the best 3 with variety (a penalty for repeating a category) and a random tie-break.
 * 4. When the filters leave fewer than 3, fill up by dropping the minutes filter, then place, then
 *    category — silently: the strict matches always come first.
 */
import { SuggestionSchema, type Suggestion } from "@thirty/shared";
import { HttpError, MESSAGES } from "../errors";
import { log } from "../log";
import type { SuggestInput, SuggestionProvider } from "../ports";
import { SUGGESTION_IDEAS, type SuggestionIdea } from "./suggestion-ideas";

/** Placeholder that answers 503 ai_unavailable (kept for tests that need a failing provider). */
export class UnavailableSuggestionProvider implements SuggestionProvider {
  async suggest(): Promise<never> {
    throw new HttpError(503, "ai_unavailable", MESSAGES.suggestionsUnavailable);
  }
}

export const SUGGESTION_COUNT = 3;
const TAG_SCORE = 3;
const BIGRAM_SCORE = 0.5;
const BIGRAM_MAX = 2;
/** Subtracted per already picked idea of the same category, so 3 results rarely share one. */
const SAME_CATEGORY_PENALTY = 1;
/** Pieces that appear in almost every title and say nothing about the idea. */
const STOP_BIGRAMS = new Set(["毎日", "一日", "今日", "自分", "時間"]);
const BIGRAM_CHAR = /^[\p{Script=Han}\p{Script=Katakana}\p{Script=Latin}ー]$/u;

const normalize = (s: string) => s.normalize("NFKC").toLowerCase();

/** Distinct 2-character pieces of the hint made only of kanji, katakana or latin letters. */
export function hintBigrams(hint: string): Set<string> {
  const chars = Array.from(normalize(hint));
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) {
    const a = chars[i]!;
    const b = chars[i + 1]!;
    if (!BIGRAM_CHAR.test(a) || !BIGRAM_CHAR.test(b)) continue;
    const bg = a + b;
    if (!STOP_BIGRAMS.has(bg)) out.add(bg);
  }
  return out;
}

/** Relevance of an idea to the hint (0 without a hint). */
export function scoreIdea(idea: SuggestionIdea, hint: string | undefined): number {
  const h = hint ? normalize(hint).trim() : "";
  if (!h) return 0;
  let score = 0;
  for (const tag of idea.tags) {
    const t = normalize(tag);
    if (t && h.includes(t)) score += TAG_SCORE;
  }
  const text = normalize(`${idea.title} ${idea.summary}`);
  let shared = 0;
  for (const bg of hintBigrams(h)) if (text.includes(bg)) shared++;
  return score + Math.min(BIGRAM_MAX, shared * BIGRAM_SCORE);
}

const matchesCategory = (idea: SuggestionIdea, input: SuggestInput) => !input.category || idea.category === input.category;
const matchesPlace = (idea: SuggestionIdea, input: SuggestInput) =>
  !input.place || input.place === "any" || idea.place === "any" || idea.place === input.place;
const matchesMinutes = (idea: SuggestionIdea, input: SuggestInput) =>
  input.maxMinutes === undefined || idea.minutes <= input.maxMinutes;

/** Strict first, then without minutes, then without place, then anything. */
const TIERS: ((idea: SuggestionIdea, input: SuggestInput) => boolean)[] = [
  (i, q) => matchesCategory(i, q) && matchesPlace(i, q) && matchesMinutes(i, q),
  (i, q) => matchesCategory(i, q) && matchesPlace(i, q),
  (i, q) => matchesCategory(i, q),
  () => true,
];

function toSuggestion(idea: SuggestionIdea): Suggestion | undefined {
  const parsed = SuggestionSchema.safeParse({
    seal: idea.seal,
    title: idea.title,
    category: idea.category,
    minutes: idea.minutes,
    place: idea.place,
    difficulty: idea.difficulty,
    summary: idea.summary,
    how: [...idea.how],
    after: idea.after,
  });
  if (parsed.success) return parsed.data;
  // A bug in the built-in data, not user input: skip the idea and keep going.
  log.warn("suggestions: invalid built-in idea skipped", { seal: idea.seal });
  return undefined;
}

export type SuggestionProviderOptions = {
  /** Random source in [0, 1) for tie-breaks (inject a seeded one in tests). */
  random?: () => number;
  ideas?: readonly SuggestionIdea[];
};

export class RuleBasedSuggestionProvider implements SuggestionProvider {
  private readonly random: () => number;
  private readonly ideas: readonly SuggestionIdea[];

  constructor(opts: SuggestionProviderOptions = {}) {
    this.random = opts.random ?? Math.random;
    this.ideas = opts.ideas ?? SUGGESTION_IDEAS;
  }

  async suggest(input: SuggestInput): Promise<Suggestion[]> {
    return this.pick(input);
  }

  pick(input: SuggestInput): Suggestion[] {
    const scored = this.ideas.map((idea) => ({ idea, score: scoreIdea(idea, input.hint), key: this.random() }));
    const used = new Set<SuggestionIdea>();
    const picked: SuggestionIdea[] = [];
    const out: Suggestion[] = [];

    for (const tier of TIERS) {
      while (out.length < SUGGESTION_COUNT) {
        let best: (typeof scored)[number] | undefined;
        let bestScore = -Infinity;
        for (const c of scored) {
          if (used.has(c.idea) || !tier(c.idea, input)) continue;
          const repeats = picked.filter((p) => p.category === c.idea.category).length;
          const s = c.score - repeats * SAME_CATEGORY_PENALTY;
          if (s > bestScore || (s === bestScore && best !== undefined && c.key < best.key)) {
            best = c;
            bestScore = s;
          }
        }
        if (!best) break;
        used.add(best.idea);
        const suggestion = toSuggestion(best.idea);
        if (!suggestion) continue;
        picked.push(best.idea);
        out.push(suggestion);
      }
      if (out.length >= SUGGESTION_COUNT) break;
    }
    return out;
  }
}

export function createSuggestionProvider(opts: SuggestionProviderOptions = {}): SuggestionProvider {
  return new RuleBasedSuggestionProvider(opts);
}
