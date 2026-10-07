/**
 * Recipe data for the レシピ / ガチャ pages (SPEC FR-10..FR-13).
 *
 *   const { recipes, loading, error, reload } = useRecipes();   // official at once, community when it arrives
 *   const d = useRecipe(id);                                     // detail + stories, offline fallback for official
 *   const recipe = await createRecipe(input);                    // POST, then the list refetches past the SW cache
 *
 * The official recipes are bundled (OFFICIAL_RECIPES), so the list works offline and on API errors.
 * The service worker serves /api/recipes stale-while-revalidate; after a mutation the next fetch
 * uses { cache: "no-cache" }, which the SW sends to the network.
 */
import {
  API,
  CATEGORIES,
  OFFICIAL_RECIPES,
  PLACES,
  findOfficialRecipe,
  type Category,
  type OfficialRecipe,
  type Place,
  type Recipe,
  type RecipeDetailResponse,
  type RecipeInput,
  type RecipeListResponse,
  type Story,
  type StoryInput,
} from "@thirty/shared";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ApiClientError, errorMessage, request } from "./api";

// ---------- shapes ----------

/** An official recipe as a list item before the server's counters arrive. */
export function officialRecipe(r: OfficialRecipe): Recipe {
  return {
    ...r,
    how: [...r.how],
    source: "official",
    authorName: null,
    isMine: false,
    featured: false,
    startCount: 0,
    storyCount: 0,
    createdAt: null,
  };
}

const OFFICIAL_LIST: readonly Recipe[] = OFFICIAL_RECIPES.map(officialRecipe);
const OFFICIAL_IDS = new Set(OFFICIAL_RECIPES.map((r) => r.id));

const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

function isRecipeLike(r: unknown): r is Recipe {
  const o = r as Recipe | null;
  return (
    !!o &&
    typeof o === "object" &&
    typeof o.id === "string" &&
    typeof o.title === "string" &&
    typeof o.seal === "string" &&
    typeof o.summary === "string" &&
    typeof o.minutes === "number" &&
    o.category in CATEGORIES &&
    o.place in PLACES
  );
}

/** Normalise a server recipe (defensive: a bad row must not break the page). */
function cleanRecipe(r: Recipe): Recipe {
  return {
    ...r,
    how: Array.isArray(r.how) ? r.how.filter((h): h is string => typeof h === "string" && h.trim() !== "") : [],
    after: typeof r.after === "string" ? r.after : "",
    difficulty: ([1, 2, 3] as const).includes(r.difficulty) ? r.difficulty : 1,
    source: r.source === "community" ? "community" : "official",
    authorName: typeof r.authorName === "string" && r.authorName ? r.authorName : null,
    isMine: r.isMine === true,
    featured: r.featured === true,
    startCount: count(r.startCount),
    storyCount: count(r.storyCount),
    createdAt: typeof r.createdAt === "number" ? r.createdAt : null,
  };
}

/**
 * Bundled official recipes (in their bundled order, with the server's counters when known)
 * followed by every other recipe the server listed (community ones).
 */
export function mergeRecipes(remote: readonly unknown[] | null | undefined): Recipe[] {
  if (!remote) return [...OFFICIAL_LIST];
  const byId = new Map<string, Recipe>();
  for (const r of remote) if (isRecipeLike(r) && !byId.has(r.id)) byId.set(r.id, cleanRecipe(r));
  const out = OFFICIAL_LIST.map((o) => {
    const r = byId.get(o.id);
    return r ? { ...o, featured: r.featured, startCount: r.startCount, storyCount: r.storyCount } : o;
  });
  for (const r of byId.values()) if (!OFFICIAL_IDS.has(r.id)) out.push(r);
  return out;
}

// ---------- search / filter / sort ----------

export const RECIPE_SORTS = { recommended: "おすすめ", popular: "人気", new: "新着" } as const;
export type RecipeSort = keyof typeof RECIPE_SORTS;
export type CategoryFilter = Category | "all";

export function isRecipeSort(v: unknown): v is RecipeSort {
  return typeof v === "string" && v in RECIPE_SORTS;
}

export function isCategory(v: unknown): v is Category {
  return typeof v === "string" && v in CATEGORIES;
}

/** NFKC so "５分" finds "5分"; lower case for the odd latin word. */
function norm(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

function haystack(r: Recipe): string {
  return norm(`${r.title} ${r.summary} ${r.minutes}分 1日${r.minutes}分`);
}

/** Search title / summary / minutes ("5分") — every word must match — and narrow by category. */
export function filterRecipes(list: readonly Recipe[], opts: { q?: string; category?: CategoryFilter }): Recipe[] {
  const terms = norm(opts.q ?? "")
    .split(/\s+/)
    .filter(Boolean);
  const category = opts.category ?? "all";
  return list.filter((r) => (category === "all" || r.category === category) && terms.every((t) => haystack(r).includes(t)));
}

/**
 * おすすめ: featured first, then by starts. 人気: by starts (then stories). 新着: newest community
 * recipe first, official ones last. Ties keep the incoming order (official in bundled order).
 */
export function sortRecipes(list: readonly Recipe[], sort: RecipeSort): Recipe[] {
  const cmp: (a: Recipe, b: Recipe) => number =
    sort === "popular"
      ? (a, b) => b.startCount - a.startCount || b.storyCount - a.storyCount
      : sort === "new"
        ? (a, b) => Number(a.createdAt === null) - Number(b.createdAt === null) || (b.createdAt ?? 0) - (a.createdAt ?? 0)
        : (a, b) => Number(b.featured) - Number(a.featured) || b.startCount - a.startCount;
  return list
    .map((r, i) => ({ r, i }))
    .sort((x, y) => cmp(x.r, y.r) || x.i - y.i)
    .map((x) => x.r);
}

// ---------- gacha ----------

/** 時間 chips → max minutes per day (null = 制限なし). */
export const GACHA_TIMES = [
  { value: "5", label: "5分", max: 5 },
  { value: "15", label: "15分", max: 15 },
  { value: "30", label: "30分", max: 30 },
  { value: "60", label: "60分", max: 60 },
  { value: "any", label: "制限なし", max: null },
] as const;
export type GachaTime = (typeof GACHA_TIMES)[number]["value"];

export function maxMinutesOf(time: GachaTime): number | null {
  return GACHA_TIMES.find((t) => t.value === time)?.max ?? null;
}

/** place "any" = no restriction; a recipe for "どこでも" fits every place. */
export type GachaFilters = { maxMinutes: number | null; category: Category | null; place: Place };
export type GachaRelaxed = "place" | "category" | "time";

export function matchesGacha(r: Pick<Recipe, "minutes" | "category" | "place">, f: GachaFilters): boolean {
  if (f.maxMinutes !== null && r.minutes > f.maxMinutes) return false;
  if (f.category !== null && r.category !== f.category) return false;
  if (f.place !== "any" && r.place !== "any" && r.place !== f.place) return false;
  return true;
}

const RELAX_ORDER: readonly GachaRelaxed[] = ["place", "category", "time"];

function isActive(f: GachaFilters, k: GachaRelaxed): boolean {
  return k === "place" ? f.place !== "any" : k === "category" ? f.category !== null : f.maxMinutes !== null;
}

function relax(f: GachaFilters, k: GachaRelaxed): GachaFilters {
  return k === "place" ? { ...f, place: "any" } : k === "category" ? { ...f, category: null } : { ...f, maxMinutes: null };
}

/**
 * The gacha's candidates. Recipes in `exclude` (ones the user is already doing) are skipped
 * unless nothing else fits. When nothing matches, conditions are dropped in the order
 * place → category → time and reported in `relaxed` so the page can say so.
 */
export function gachaPool(
  recipes: readonly Recipe[],
  filters: GachaFilters,
  exclude?: ReadonlySet<string>,
): { pool: Recipe[]; relaxed: GachaRelaxed[] } {
  let current = filters;
  const relaxed: GachaRelaxed[] = [];
  for (;;) {
    const matching = recipes.filter((r) => matchesGacha(r, current));
    const fresh = exclude?.size ? matching.filter((r) => !exclude.has(r.id)) : matching;
    if (fresh.length) return { pool: fresh, relaxed };
    if (matching.length) return { pool: matching, relaxed };
    const next = RELAX_ORDER.find((k) => isActive(current, k));
    if (!next) return { pool: [], relaxed };
    current = relax(current, next);
    relaxed.push(next);
  }
}

export const RELAXED_LABELS: Record<GachaRelaxed, string> = { place: "場所", category: "ジャンル", time: "時間" };

// ---------- list store (module level: shared by every page that shows recipes) ----------

type ListState = {
  remote: readonly unknown[] | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  fetchedAt: number;
};

const INITIAL_LIST: ListState = { remote: null, status: "idle", error: null, fetchedAt: 0 };
let listState: ListState = INITIAL_LIST;
/** Set by a mutation: the next list fetch skips the service worker's cached copy. */
let listStale = false;
let listInflight: Promise<void> | null = null;
const listListeners = new Set<() => void>();
const LIST_FRESH_MS = 30_000;

function setList(next: ListState): void {
  listState = next;
  for (const l of [...listListeners]) l();
}

function subscribeList(l: () => void): () => void {
  listListeners.add(l);
  return () => listListeners.delete(l);
}

const getList = () => listState;

/** Fetch the recipe list now (shared in-flight request). `fresh` bypasses the SW cache. */
export function loadRecipes(opts: { fresh?: boolean } = {}): Promise<void> {
  if (listInflight && !opts.fresh) return listInflight;
  const fresh = opts.fresh === true || listStale;
  listStale = false;
  setList({ ...listState, status: "loading", error: null });
  const p: Promise<void> = request<RecipeListResponse>("GET", API.recipes, fresh ? { cache: "no-cache" } : {}).then(
    (res) => {
      if (listInflight !== p) return;
      setList({ remote: Array.isArray(res?.recipes) ? res.recipes : [], status: "ready", error: null, fetchedAt: Date.now() });
    },
    (err: unknown) => {
      if (listInflight !== p) return;
      setList({ ...listState, status: "error", error: errorMessage(err) });
    },
  );
  listInflight = p;
  void p.finally(() => {
    if (listInflight === p) listInflight = null;
  });
  return p;
}

/** After a write: refetch past the SW cache now (if a list is on screen) or on the next visit. */
export function invalidateRecipes(): void {
  listStale = true;
  if (listListeners.size > 0) void loadRecipes({ fresh: true });
}

/** Tests only: forget the module-level cache. */
export function resetRecipesCache(): void {
  listState = INITIAL_LIST;
  listStale = false;
  listInflight = null;
}

export type RecipesResult = {
  /** Official recipes (always) + community recipes once the server answered. */
  recipes: Recipe[];
  /** The server list is being fetched. */
  loading: boolean;
  /** The server list failed (the official recipes are still in `recipes`). */
  error: string | null;
  /** True once the server list arrived at least once. */
  synced: boolean;
  reload: () => void;
};

export function useRecipes(): RecipesResult {
  const state = useSyncExternalStore(subscribeList, getList, getList);
  useEffect(() => {
    const s = getList();
    if (s.status === "loading") return;
    if (s.status === "ready" && !listStale && Date.now() - s.fetchedAt < LIST_FRESH_MS) return;
    void loadRecipes();
  }, []);
  const recipes = useMemo(() => mergeRecipes(state.remote), [state.remote]);
  const reload = useCallback(() => void loadRecipes({ fresh: true }), []);
  return {
    recipes,
    loading: state.status === "loading" || state.status === "idle",
    error: state.status === "error" ? state.error : null,
    synced: state.remote !== null,
    reload,
  };
}

/** A recipe we can show before the detail request returns: bundled, or from the list cache. */
export function knownRecipe(id: string): Recipe | null {
  const official = findOfficialRecipe(id);
  if (official) {
    const fromList = listState.remote ? mergeRecipes(listState.remote).find((r) => r.id === id) : undefined;
    return fromList ?? officialRecipe(official);
  }
  const remote = listState.remote?.find((r): r is Recipe => isRecipeLike(r) && r.id === id);
  return remote ? cleanRecipe(remote) : null;
}

// ---------- detail ----------

export type RecipeDetail = {
  recipe: Recipe | null;
  /** null when the stories could not be loaded (offline fallback). */
  stories: Story[] | null;
  notFound: boolean;
  /** Set when the request failed; `recipe` may still be the bundled / cached copy. */
  error: string | null;
};

const byNewest = (a: Story, b: Story) => (b.createdAt ?? 0) - (a.createdAt ?? 0);

function isStoryLike(s: unknown): s is Story {
  const o = s as Story | null;
  return !!o && typeof o === "object" && typeof o.id === "string" && typeof o.body === "string";
}

/** GET the detail; on a network / server failure fall back to what we already know. */
export async function fetchRecipeDetail(id: string, opts: { fresh?: boolean; signal?: AbortSignal } = {}): Promise<RecipeDetail> {
  try {
    const res = await request<RecipeDetailResponse>("GET", API.recipe(id), {
      ...(opts.fresh ? { cache: "no-cache" as const } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!isRecipeLike(res?.recipe)) throw new ApiClientError(500, "internal", "サーバーの応答を読み取れませんでした。");
    const stories = Array.isArray(res.stories) ? res.stories.filter(isStoryLike).sort(byNewest) : [];
    return { recipe: cleanRecipe(res.recipe), stories, notFound: false, error: null };
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 404) {
      return { recipe: null, stories: null, notFound: true, error: null };
    }
    return { recipe: knownRecipe(id), stories: null, notFound: false, error: errorMessage(err) };
  }
}

type DetailEntry = RecipeDetail & { key: string; id: string };

export type RecipeDetailResult = RecipeDetail & {
  loading: boolean;
  /** Refetch past the SW cache (after a write, or 再試行). */
  reload: () => void;
  /** Show a just-posted story at once (the refetch confirms it). */
  addStory: (story: Story) => void;
  removeStory: (storyId: string) => void;
};

export function useRecipe(id: string | undefined): RecipeDetailResult {
  const [version, setVersion] = useState(0);
  const [entry, setEntry] = useState<DetailEntry | null>(null);
  const key = `${id ?? ""}#${version}`;

  useEffect(() => {
    if (!id) return;
    const ctrl = new AbortController();
    let alive = true;
    void fetchRecipeDetail(id, { fresh: version > 0, signal: ctrl.signal }).then((d) => {
      if (!alive) return;
      setEntry((prev) => {
        // A failed refetch keeps the stories we already show.
        if (d.error && prev && prev.id === id && prev.stories && !d.notFound) {
          return { ...prev, key, error: d.error };
        }
        return { ...d, key, id };
      });
    });
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [id, version, key]);

  const seed = useMemo(() => (id ? knownRecipe(id) : null), [id]);
  const current = entry && entry.id === id ? entry : null;
  const loading = !!id && (!current || current.key !== key);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const addStory = useCallback((story: Story) => {
    setEntry((prev) => (prev && prev.id === story.recipeId ? { ...prev, stories: [story, ...(prev.stories ?? []).filter((s) => s.id !== story.id)] } : prev));
  }, []);
  const removeStory = useCallback((storyId: string) => {
    setEntry((prev) => (prev ? { ...prev, stories: prev.stories ? prev.stories.filter((s) => s.id !== storyId) : prev.stories } : prev));
  }, []);

  if (!id) return { recipe: null, stories: null, notFound: true, error: null, loading: false, reload, addStory, removeStory };
  return {
    recipe: current?.recipe ?? (current?.notFound ? null : seed),
    stories: current?.stories ?? null,
    notFound: current?.notFound ?? false,
    error: current && current.key === key ? current.error : null,
    loading,
    reload,
    addStory,
    removeStory,
  };
}

// ---------- writes ----------

/** POST a community recipe (FR-11). Throws ApiClientError (fields on 400, 429 over the daily limit). */
export async function createRecipe(input: RecipeInput): Promise<Recipe> {
  const res = await request<{ recipe: Recipe }>("POST", API.recipes, { body: input, auth: "required" });
  if (!isRecipeLike(res?.recipe)) throw new ApiClientError(500, "internal", "サーバーの応答を読み取れませんでした。");
  const recipe = cleanRecipe(res.recipe);
  // Show it at once; the fresh refetch below (or on the next visit) confirms it.
  const remote = listState.remote ?? [];
  setList({ ...listState, remote: [...remote.filter((r) => !(isRecipeLike(r) && r.id === recipe.id)), recipe] });
  invalidateRecipes();
  return recipe;
}

export async function deleteRecipe(id: string): Promise<void> {
  await request<void>("DELETE", API.recipe(id), { auth: "required" });
  if (listState.remote) setList({ ...listState, remote: listState.remote.filter((r) => !(isRecipeLike(r) && r.id === id)) });
  invalidateRecipes();
}

export async function postStory(recipeId: string, input: StoryInput): Promise<Story> {
  const res = await request<{ story: Story }>("POST", API.stories(recipeId), { body: input, auth: "required" });
  if (!isStoryLike(res?.story)) throw new ApiClientError(500, "internal", "サーバーの応答を読み取れませんでした。");
  invalidateRecipes(); // storyCount
  return res.story;
}

export async function deleteStory(recipeId: string, storyId: string): Promise<void> {
  await request<void>("DELETE", API.story(recipeId, storyId), { auth: "required" });
  invalidateRecipes();
}
