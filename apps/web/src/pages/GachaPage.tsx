/**
 * /gacha — 次の30日ガチャ (SPEC FR-12) and ひらめき提案（お試し）(FR-13, rule-based, no AI — ADR 0003),
 * in the 「えらぶ」 tab with /recipes (ChooseNav); ひらめき提案 sits under a line after the result.
 * The pool is useRecipes() narrowed by 時間 / ジャンル / 場所; when nothing fits, conditions are
 * relaxed (place → genre → time) with a note. The slot cycles for ~1.2 s, not under reduced motion.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import {
  API,
  CATEGORY_KEYS,
  LIMITS,
  PLACES,
  PLACE_KEYS,
  QUOTAS,
  SuggestRequestSchema,
  type Category,
  type Place,
  type Recipe,
  type SuggestRequest,
  type SuggestResponse,
  type Suggestion,
} from "@thirty/shared";
import { ChipGroup, type ChipOption } from "../components/Chip";
import { ChooseNav } from "../components/ChooseNav";
import { TextField } from "../components/Field";
import { SparkleIcon } from "../components/Icons";
import { RecipeMeta } from "../components/RecipeMeta";
import { Seal } from "../components/Seal";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { StartChallengeSheet, type StartChallengeSheetProps } from "../features/start/StartChallengeSheet";
import { ApiClientError, errorMessage, isQuotaLimit, request } from "../lib/api";
import { isOpen } from "../lib/challenge";
import { prefersReducedMotion, usePageTitle } from "../lib/hooks";
import { GACHA_TIMES, RELAXED_LABELS, gachaPool, maxMinutesOf, useRecipes, type GachaFilters, type GachaTime } from "../lib/recipes";
import { useChallenges } from "../lib/store";
import { parseWith } from "../lib/validation";
import { AFTER_LABEL, CategoryLabel, CategoryTag, HowList } from "./recipeParts";
import "./GachaPage.css";

type CategoryChoice = Category | "any";

const TIME_OPTIONS: readonly ChipOption<GachaTime>[] = GACHA_TIMES.map((t) => ({ value: t.value, label: t.label }));
const CATEGORY_OPTIONS: readonly ChipOption<CategoryChoice>[] = [
  { value: "any", label: "なんでも" },
  ...CATEGORY_KEYS.map((k) => ({ value: k, label: <CategoryLabel category={k} /> })),
];
const PLACE_OPTIONS: readonly ChipOption<Place>[] = PLACE_KEYS.map((k) => ({ value: k, label: PLACES[k] }));

const SPIN_MS = 1200;

/** Frame times for the slot: quick at first, slowing down towards SPIN_MS. */
function spinFrames(total = SPIN_MS): number[] {
  const out: number[] = [];
  let t = 0;
  let step = 50;
  while (t < total - 120) {
    out.push(t);
    t += step;
    step = Math.min(220, step * 1.14);
  }
  return out;
}

type StartTarget = Pick<StartChallengeSheetProps, "recipe" | "preset">;

export default function GachaPage() {
  usePageTitle("ガチャ");
  const navigate = useNavigate();
  const { recipes, loading: recipesLoading, synced } = useRecipes();
  const challenges = useChallenges();
  const [time, setTime] = useState<GachaTime>("any");
  const [category, setCategory] = useState<CategoryChoice>("any");
  const [place, setPlace] = useState<Place>("any");
  const [result, setResult] = useState<Recipe | null>(null);
  const [shown, setShown] = useState<Recipe | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [start, setStart] = useState<StartTarget | null>(null);
  const timers = useRef<number[]>([]);

  const filters: GachaFilters = useMemo(
    () => ({ maxMinutes: maxMinutesOf(time), category: category === "any" ? null : category, place }),
    [time, category, place],
  );
  const doing = useMemo(() => new Set(challenges.filter(isOpen).map((c) => c.recipeId).filter((id): id is string => !!id)), [challenges]);
  const { pool, relaxed } = useMemo(() => gachaPool(recipes, filters, doing), [recipes, filters, doing]);

  useEffect(() => {
    const list = timers.current;
    return () => list.forEach((t) => window.clearTimeout(t));
  }, []);

  function roll() {
    if (pool.length === 0 || spinning) return;
    const pick = pool[Math.floor(Math.random() * pool.length)]!;
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current.length = 0;
    if (prefersReducedMotion() || pool.length < 2) {
      setResult(pick);
      setShown(null);
      return;
    }
    setSpinning(true);
    setResult(null);
    let i = Math.floor(Math.random() * pool.length);
    for (const at of spinFrames()) {
      const r = pool[i++ % pool.length]!;
      timers.current.push(window.setTimeout(() => setShown(r), at));
    }
    timers.current.push(
      window.setTimeout(() => {
        setShown(null);
        setSpinning(false);
        setResult(pick);
      }, SPIN_MS),
    );
  }

  const slotRecipe = spinning ? shown : result;

  return (
    <section className="stack g-page" aria-labelledby="g-title">
      <ChooseNav current="gacha" />
      <h1 className="h2" id="g-title">
        次の30日ガチャ
      </h1>
      <p className="note">決められないときは、条件だけ決めて回す。出たものを素直にやってみるのがコツです。</p>

      <div className="card gf g-filters">
        <div>
          <span className="gl" id="g-time-label">
            1日に使える時間
          </span>
          <ChipGroup labelledBy="g-time-label" value={time} options={TIME_OPTIONS} onChange={setTime} />
        </div>
        <div>
          <span className="gl" id="g-cat-label">
            ジャンル
          </span>
          <ChipGroup labelledBy="g-cat-label" className="rp-cats" value={category} options={CATEGORY_OPTIONS} onChange={setCategory} />
        </div>
        <div>
          <span className="gl" id="g-place-label">
            場所
          </span>
          <ChipGroup labelledBy="g-place-label" value={place} options={PLACE_OPTIONS} onChange={setPlace} />
        </div>
      </div>

      <div className="g-machine">
        <div className={["slot", "g-slot", spinning ? "spin" : "", result && !spinning ? "landed" : ""].filter(Boolean).join(" ")} aria-hidden="true" data-testid="slot">
          {slotRecipe ? (
            <>
              <Seal char={slotRecipe.seal} size="sm" />
              <span className="g-slot-title">{slotRecipe.title}</span>
            </>
          ) : (
            <span className="g-slot-idle">候補 {pool.length}件</span>
          )}
        </div>
        <p className="sr-only" role="status">
          {spinning ? "抽選しています…" : result ? `出たのは「${result.title}」です` : ""}
        </p>
        {relaxed.length > 0 && pool.length > 0 && (
          <p className="g-relax" role="status">
            ぴったりのレシピがないので、{relaxed.map((k) => RELAXED_LABELS[k]).join("・")}の条件をはずして選びます。
          </p>
        )}
        {!synced && recipesLoading && <Loading inline label="みんなのレシピも読み込んでいます…" />}
        <button type="button" className="btn primary lg g-spin" onClick={roll} disabled={spinning || pool.length === 0} aria-busy={spinning}>
          {spinning ? "回しています…" : result ? "もう一回まわす" : "ガチャを回す"}
        </button>
        {pool.length === 0 && <p className="note">レシピがまだ読み込めていません。少し待ってからどうぞ。</p>}
      </div>

      {result && !spinning && (
        <section className={`card gres g-result cat-${result.category}`} aria-labelledby="g-result-title" data-testid="gacha-result">
          <div className="rhead">
            <Seal char={result.seal} size="lg" />
            <div>
              <CategoryTag category={result.category} />
              <h2 className="g-result-title" id="g-result-title">
                {result.title}
              </h2>
              <RecipeMeta recipe={result} />
            </div>
          </div>
          <p>{result.summary}</p>
          <div className="row gap fw g-actions">
            <button type="button" className="btn primary grow" onClick={() => setStart({ recipe: { id: result.id, title: result.title, seal: result.seal } })}>
              これを30日やる
            </button>
            <button type="button" className="btn" onClick={roll}>
              もう一回
            </button>
            <Link to={`/recipes/${encodeURIComponent(result.id)}`} className="btn ghost">
              くわしく
            </Link>
          </div>
        </section>
      )}

      <hr className="g-sep" />

      <Suggestions
        filters={filters}
        onStart={(s) => setStart({ preset: { title: s.title, seal: s.seal } })}
        onPost={(s) => navigate("/recipes/new", { state: { suggestion: s } })}
      />

      {start && <StartChallengeSheet open onClose={() => setStart(null)} recipe={start.recipe ?? null} preset={start.preset ?? null} />}
    </section>
  );
}

type SuggestState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; suggestions: Suggestion[] }
  | { status: "limit" }
  | { status: "error"; message: string };

/** The request body: only the conditions that narrow something. */
export function suggestBody(filters: GachaFilters, hint: string): SuggestRequest {
  const body: SuggestRequest = {};
  if (filters.maxMinutes !== null) body.maxMinutes = filters.maxMinutes;
  if (filters.category !== null) body.category = filters.category;
  if (filters.place !== "any") body.place = filters.place;
  if (hint.trim()) body.hint = hint.trim();
  return body;
}

function isSuggestion(s: unknown): s is Suggestion {
  const o = s as Suggestion | null;
  return !!o && typeof o === "object" && typeof o.title === "string" && typeof o.seal === "string" && typeof o.summary === "string";
}

function Suggestions({ filters, onStart, onPost }: { filters: GachaFilters; onStart: (s: Suggestion) => void; onPost: (s: Suggestion) => void }) {
  const [hint, setHint] = useState("");
  const [hintError, setHintError] = useState<string | undefined>(undefined);
  const [state, setState] = useState<SuggestState>({ status: "idle" });
  const [remaining, setRemaining] = useState<number | null>(null);
  const busy = state.status === "loading";
  const limitReached = state.status === "limit" || remaining === 0;

  async function ask(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    const body = suggestBody(filters, hint);
    const parsed = parseWith(SuggestRequestSchema, body);
    if (!parsed.ok) {
      setHintError(parsed.fields.hint ?? parsed.message);
      return;
    }
    setHintError(undefined);
    setState({ status: "loading" });
    try {
      const res = await request<SuggestResponse>("POST", API.suggestions, { body, auth: "required" });
      const list = Array.isArray(res?.suggestions) ? res.suggestions.filter(isSuggestion).slice(0, 3) : [];
      if (typeof res?.remainingToday === "number") setRemaining(Math.max(0, res.remainingToday));
      setState({ status: "done", suggestions: list });
    } catch (err) {
      if (isQuotaLimit(err)) {
        setRemaining(0);
        setState({ status: "limit" });
      } else if (err instanceof ApiClientError && err.status === 400 && err.fields?.hint) {
        setHintError(err.fields.hint);
        setState({ status: "idle" });
      } else {
        setState({ status: "error", message: errorMessage(err) });
      }
    }
  }

  return (
    <section className="card aibox g-ideas" aria-labelledby="g-ideas-title">
      <h2 className="g-ideas-title" id="g-ideas-title">
        ひらめき提案（お試し）
      </h2>
      <p className="note">上の条件とひとことから、レシピにない案を最大3つ出します。</p>
      <p className="g-norule" data-testid="no-ai-note">
        <SparkleIcon />
        いまは AI を使わず、ルールで選んでいます
      </p>
      <form className="form g-ideas-form" onSubmit={ask} noValidate>
        <TextField
          label="ひとこと（任意）"
          value={hint}
          onChange={setHint}
          max={LIMITS.aiHint}
          error={hintError}
          placeholder="最近気になっていること、ひとことで"
          autoComplete="off"
          enterKeyHint="send"
        />
        <div className="row gap fw between">
          <button type="submit" className="btn" disabled={busy || limitReached} aria-busy={busy}>
            {busy ? "考えています…" : "提案してもらう"}
          </button>
          <span className="note" data-testid="remaining">
            {remaining !== null ? `今日はあと ${remaining} 回` : `1日${QUOTAS.suggestionsPerUserPerDay}回まで`}
          </span>
        </div>
      </form>

      {state.status === "loading" && <Loading inline label="案を選んでいます…" />}
      {state.status === "limit" && (
        <p className="g-limit" role="alert">
          今日はここまで。明日また提案できます。ガチャはいつでも回せます。
        </p>
      )}
      {state.status === "error" && <ErrorState title="提案を作れませんでした" message={`${state.message} ガチャはそのまま使えます。`} onRetry={() => void ask()} />}
      {state.status === "done" &&
        (state.suggestions.length === 0 ? (
          <EmptyState title="条件に合う案がありませんでした">時間やジャンルをゆるめて、もう一度どうぞ。</EmptyState>
        ) : (
          <ul className="g-suggestions" aria-label="提案">
            {state.suggestions.map((s, i) => (
              <li key={`${s.title}-${i}`} className={`card g-suggestion cat-${s.category}`} data-testid="suggestion">
                <div className="rhead">
                  <Seal char={s.seal} size="lg" />
                  <div>
                    <CategoryTag category={s.category} />
                    <h3 className="g-sug-title">{s.title}</h3>
                    <RecipeMeta recipe={s} />
                  </div>
                </div>
                <p>{s.summary}</p>
                <HowList how={s.how ?? []} />
                {s.after && (
                  <p className="note">
                    <b>{AFTER_LABEL}：</b>
                    {s.after}
                  </p>
                )}
                <div className="row gap fw g-actions">
                  <button type="button" className="btn primary grow" onClick={() => onStart(s)}>
                    これを30日やる
                    <span className="sr-only">：{s.title}</span>
                  </button>
                  <button type="button" className="btn" onClick={() => onPost(s)}>
                    レシピとして投稿
                    <span className="sr-only">：{s.title}</span>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
