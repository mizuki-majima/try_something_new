/**
 * /recipes/new — レシピを書く (SPEC FR-11). Validated with RecipeInputSchema (the API re-validates
 * with the same schema; its field errors are shown too). Router state { suggestion } prefills the
 * form (from ひらめき提案「レシピとして投稿」).
 */
import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  CATEGORIES,
  CATEGORY_KEYS,
  LIMITS,
  PLACES,
  PLACE_KEYS,
  QUOTAS,
  RecipeInputSchema,
  firstGrapheme,
  type Category,
  type Place,
  type Suggestion,
} from "@thirty/shared";
import { ChipGroup, type ChipOption } from "../components/Chip";
import { ConsentNote } from "../components/ConsentNote";
import { Field, TextAreaField, TextField } from "../components/Field";
import { ChevronLeftIcon, PlusIcon } from "../components/Icons";
import { Seal } from "../components/Seal";
import { useToast } from "../components/Toast";
import { ApiClientError, errorMessage } from "../lib/api";
import { usePageTitle } from "../lib/hooks";
import { createRecipe } from "../lib/recipes";
import { useApp } from "../lib/store";
import { parseWith } from "../lib/validation";
import { AFTER_LABEL, CategoryLabel } from "./recipeParts";

type Difficulty = "1" | "2" | "3";

export type RecipeDraft = {
  title: string;
  seal: string;
  category: Category;
  minutes: string;
  place: Place;
  difficulty: Difficulty;
  summary: string;
  how: string[];
  after: string;
  /** null = untouched (follows the nickname). */
  authorName: string | null;
};

const CATEGORY_OPTIONS: readonly ChipOption<Category>[] = CATEGORY_KEYS.map((k) => ({ value: k, label: <CategoryLabel category={k} /> }));
const PLACE_OPTIONS: readonly ChipOption<Place>[] = PLACE_KEYS.map((k) => ({ value: k, label: PLACES[k] }));
const DIFFICULTY_OPTIONS: readonly ChipOption<Difficulty>[] = [
  { value: "1", label: <DifficultyLabel n={1} text="かるめ" /> },
  { value: "2", label: <DifficultyLabel n={2} text="ふつう" /> },
  { value: "3", label: <DifficultyLabel n={3} text="きつめ" /> },
];

function DifficultyLabel({ n, text }: { n: number; text: string }) {
  return (
    <>
      <span aria-hidden="true" className="rn-dots">
        {"●".repeat(n)}
        {"○".repeat(3 - n)}
      </span>
      {text}
    </>
  );
}

const EMPTY_DRAFT: RecipeDraft = {
  title: "",
  seal: "",
  category: CATEGORY_KEYS[0],
  minutes: "10",
  place: "any",
  difficulty: "1",
  summary: "",
  how: [""],
  after: "",
  authorName: null,
};

function isSuggestionLike(s: unknown): s is Suggestion {
  const o = s as Suggestion | null;
  return !!o && typeof o === "object" && typeof o.title === "string" && typeof o.summary === "string";
}

/** A draft from router state { suggestion }, else empty. Unknown values fall back to defaults. */
export function draftFromState(state: unknown): RecipeDraft {
  const s = (state as { suggestion?: unknown } | null)?.suggestion;
  if (!isSuggestionLike(s)) return EMPTY_DRAFT;
  const how = Array.isArray(s.how) ? s.how.filter((h): h is string => typeof h === "string").slice(0, LIMITS.recipeHowItems) : [];
  const minutes = typeof s.minutes === "number" && Number.isFinite(s.minutes) ? String(Math.min(180, Math.max(0, Math.round(s.minutes)))) : EMPTY_DRAFT.minutes;
  return {
    ...EMPTY_DRAFT,
    title: s.title,
    seal: typeof s.seal === "string" ? s.seal : "",
    category: s.category in CATEGORIES ? s.category : EMPTY_DRAFT.category,
    minutes,
    place: s.place in PLACES ? s.place : EMPTY_DRAFT.place,
    difficulty: s.difficulty === 2 || s.difficulty === 3 ? (String(s.difficulty) as Difficulty) : "1",
    summary: s.summary,
    how: how.length ? how : [""],
    after: typeof s.after === "string" ? s.after : "",
  };
}

/** Field ids, in form order (the first invalid one gets focus). */
const FIELD_IDS: Record<string, string> = {
  title: "rn-title",
  seal: "rn-seal",
  category: "rn-category",
  minutes: "rn-minutes",
  place: "rn-place",
  difficulty: "rn-difficulty",
  summary: "rn-summary",
  how: "rn-how-0",
  after: "rn-after",
  authorName: "rn-author",
};

type BuiltInput = { input: Record<string, unknown>; howIndex: number[] };

/** Draft → request body. Blank コツ rows are dropped; howIndex maps body index → row index. */
export function buildRecipeInput(d: RecipeDraft, nickname: string): BuiltInput {
  const howIndex: number[] = [];
  const how: string[] = [];
  d.how.forEach((h, i) => {
    if (h.trim() === "") return;
    howIndex.push(i);
    how.push(h);
  });
  const name = d.authorName ?? nickname;
  const input: Record<string, unknown> = {
    seal: d.seal.trim() || firstGrapheme(d.title),
    title: d.title,
    category: d.category,
    minutes: d.minutes.trim() === "" ? Number.NaN : Number(d.minutes),
    place: d.place,
    difficulty: Number(d.difficulty),
    summary: d.summary,
    how,
    after: d.after,
  };
  if (name.trim()) input.authorName = name;
  return { input, howIndex };
}

/** Schema / API errors → messages keyed by draft field ("how.2" = the third row on screen). */
export function draftErrors(fields: Record<string, string>, howIndex: readonly number[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, message] of Object.entries(fields)) {
    const m = /^how\.(\d+)/.exec(key);
    if (m) {
      const row = howIndex[Number(m[1])] ?? Number(m[1]);
      out[`how.${row}`] ??= message;
      continue;
    }
    if (key === "minutes") out.minutes = "1日あたりの時間は0〜180分の数字で入力してください";
    else if (key === "difficulty") out.difficulty = "きつさを選んでください";
    else if (key === "category") out.category = "ジャンルを選んでください";
    else if (key === "place") out.place = "場所を選んでください";
    else if (key === "seal") out.seal = message || "印は1文字で入力してください";
    else out[key] ??= message;
  }
  return out;
}

function firstErrorId(errors: Record<string, string>): string | undefined {
  for (const key of Object.keys(FIELD_IDS)) {
    if (errors[key]) return FIELD_IDS[key];
    if (key === "how") {
      const row = Object.keys(errors)
        .map((k) => /^how\.(\d+)$/.exec(k)?.[1])
        .filter((v): v is string => v !== undefined)
        .map(Number)
        .sort((a, b) => a - b)[0];
      if (row !== undefined) return `rn-how-${row}`;
    }
  }
  return undefined;
}

export default function RecipeNewPage() {
  usePageTitle("レシピを書く");
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const { user, pendingNickname } = useApp();
  const nickname = user?.nickname || pendingNickname || "";
  const [fromSuggestion] = useState(() => isSuggestionLike((location.state as { suggestion?: unknown } | null)?.suggestion));
  const [draft, setDraft] = useState<RecipeDraft>(() => draftFromState(location.state));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof RecipeDraft>(key: K, value: RecipeDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const sealPreview = draft.seal.trim() || firstGrapheme(draft.title) || "印";

  function focusFirstError(errs: Record<string, string>) {
    const id = firstErrorId(errs);
    if (id) requestAnimationFrame(() => document.getElementById(id)?.focus());
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const { input, howIndex } = buildRecipeInput(draft, nickname);
    const parsed = parseWith(RecipeInputSchema, input);
    if (!parsed.ok) {
      const errs = draftErrors(parsed.fields, howIndex);
      setErrors(errs);
      setFormError(`入力内容を確認してください（${Object.keys(errs).length}件）`);
      focusFirstError(errs);
      return;
    }
    setErrors({});
    setFormError(null);
    setBusy(true);
    try {
      const recipe = await createRecipe(parsed.data);
      toast("レシピを公開しました");
      navigate(`/recipes/${encodeURIComponent(recipe.id)}`, { replace: true });
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiClientError && err.status === 429) {
        setFormError(`今日はここまでです。レシピは1日${QUOTAS.recipesPerUserPerDay}件まで投稿できます。`);
        return;
      }
      if (err instanceof ApiClientError && err.fields && Object.keys(err.fields).length > 0) {
        const errs = draftErrors(err.fields, howIndex);
        setErrors(errs);
        focusFirstError(errs);
      }
      setFormError(errorMessage(err));
    }
  }

  function setHow(i: number, value: string) {
    setDraft((d) => ({ ...d, how: d.how.map((h, j) => (j === i ? value : h)) }));
  }
  function addHow() {
    const next = draft.how.length;
    setDraft((d) => (d.how.length >= LIMITS.recipeHowItems ? d : { ...d, how: [...d.how, ""] }));
    requestAnimationFrame(() => document.getElementById(`rn-how-${next}`)?.focus());
  }
  function removeHow(i: number) {
    setDraft((d) => ({ ...d, how: d.how.filter((_, j) => j !== i) }));
    // Errors are keyed by row; the rows below move up, so drop the stale ones.
    setErrors((errs) => Object.fromEntries(Object.entries(errs).filter(([k]) => !k.startsWith("how."))));
  }

  return (
    <section className="stack rn-page" aria-labelledby="rn-heading">
      <Link to="/recipes" className="backlink">
        <ChevronLeftIcon />
        レシピ一覧
      </Link>
      <h1 className="h2" id="rn-heading">
        レシピを書く
      </h1>
      <p className="note">
        やってみたことを、次の人のためのレシピに。公開すると、だれでも読めます。URLは入れられません（1日{QUOTAS.recipesPerUserPerDay}件まで）。
      </p>
      {fromSuggestion && (
        <p className="rn-from" role="status">
          ひらめき提案から下書きしました。自分の言葉に直してから公開してください。
        </p>
      )}

      <form className="card form rn-form" onSubmit={submit} noValidate>
        <TextField
          id="rn-title"
          label="タイトル"
          value={draft.title}
          onChange={(v) => set("title", v)}
          max={LIMITS.recipeTitle}
          error={errors.title}
          placeholder="例：毎日1枚、写真を撮る"
          autoComplete="off"
        />

        <div className="rn-seal-row">
          <Field label="印（1文字）" hint="空欄ならタイトルの1文字目" error={errors.seal} id="rn-seal">
            {(a) => (
              <input
                id={a.id}
                type="text"
                className="rn-seal-input"
                value={draft.seal}
                onChange={(e) => set("seal", e.target.value)}
                placeholder={firstGrapheme(draft.title) || "写"}
                autoComplete="off"
                aria-describedby={a.describedBy}
                aria-invalid={a.invalid || undefined}
              />
            )}
          </Field>
          <div className="rn-seal-preview" aria-hidden="true">
            <Seal char={sealPreview} size="lg" />
          </div>
        </div>

        <div className="field" id="rn-category" tabIndex={-1}>
          <span className="label" id="rn-category-label">
            ジャンル
          </span>
          <ChipGroup labelledBy="rn-category-label" className="rp-cats" value={draft.category} options={CATEGORY_OPTIONS} onChange={(v) => set("category", v)} />
          {errors.category && <span className="field-err">{errors.category}</span>}
        </div>

        <div className="two rn-two">
          <Field label="1日あたり（分）" hint="0〜180分。0は「時間を使わない」" error={errors.minutes} id="rn-minutes">
            {(a) => (
              <input
                id={a.id}
                type="number"
                inputMode="numeric"
                min={0}
                max={180}
                step={1}
                value={draft.minutes}
                onChange={(e) => set("minutes", e.target.value)}
                aria-describedby={a.describedBy}
                aria-invalid={a.invalid || undefined}
              />
            )}
          </Field>
          <div className="field" id="rn-place" tabIndex={-1}>
            <span className="label" id="rn-place-label">
              場所
            </span>
            <ChipGroup labelledBy="rn-place-label" value={draft.place} options={PLACE_OPTIONS} onChange={(v) => set("place", v)} />
            {errors.place && <span className="field-err">{errors.place}</span>}
          </div>
        </div>

        <div className="field" id="rn-difficulty" tabIndex={-1}>
          <span className="label" id="rn-difficulty-label">
            きつさ
          </span>
          <ChipGroup labelledBy="rn-difficulty-label" value={draft.difficulty} options={DIFFICULTY_OPTIONS} onChange={(v) => set("difficulty", v)} />
          {errors.difficulty && <span className="field-err">{errors.difficulty}</span>}
        </div>

        <TextField
          id="rn-summary"
          label="何をする（1文）"
          value={draft.summary}
          onChange={(v) => set("summary", v)}
          max={LIMITS.recipeSummary}
          error={errors.summary}
          placeholder="例：何でもいいので1日1枚、スマホで撮る。"
          autoComplete="off"
        />

        <fieldset className="field rn-how">
          <legend>やり方のコツ（{LIMITS.recipeHowItems}つまで・任意）</legend>
          {draft.how.length === 0 && <p className="note">コツがあれば足してください。</p>}
          <ol className="rn-howlist">
            {draft.how.map((h, i) => (
              <li key={i} className="rn-howrow">
                <TextField
                  id={`rn-how-${i}`}
                  label={`コツ ${i + 1}`}
                  value={h}
                  onChange={(v) => setHow(i, v)}
                  max={LIMITS.recipeHowItem}
                  error={errors[`how.${i}`]}
                  placeholder={i === 0 ? "例：時間帯を固定する" : undefined}
                  autoComplete="off"
                />
                <button type="button" className="btn sm ghost rn-howdel" onClick={() => removeHow(i)}>
                  削除<span className="sr-only">（コツ {i + 1}）</span>
                </button>
              </li>
            ))}
          </ol>
          {errors.how && <span className="field-err">{errors.how}</span>}
          <button type="button" className="btn sm rn-howadd" onClick={addHow} disabled={draft.how.length >= LIMITS.recipeHowItems}>
            <PlusIcon />
            コツを足す
          </button>
        </fieldset>

        <TextAreaField
          id="rn-after"
          label={`${AFTER_LABEL}（任意）`}
          hint="約束ではなく「こうなるかも」で書いてください"
          value={draft.after}
          onChange={(v) => set("after", v)}
          max={LIMITS.recipeAfter}
          rows={3}
          error={errors.after}
          placeholder="例：通勤路の見え方が変わるかもしれません。"
        />

        <TextField
          id="rn-author"
          label="名前（表示名）"
          value={draft.authorName ?? nickname}
          onChange={(v) => set("authorName", v)}
          max={LIMITS.nickname}
          error={errors.authorName}
          placeholder="名無し"
          autoComplete="nickname"
        />

        {formError && (
          <p className="note err" role="alert">
            {formError}
          </p>
        )}
        <ConsentNote action="post" />
        <button type="submit" className="btn primary lg" disabled={busy} aria-busy={busy}>
          {busy ? "公開しています…" : "レシピを公開する"}
        </button>
      </form>
    </section>
  );
}
