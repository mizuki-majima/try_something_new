/**
 * Start-a-challenge flow (FR-3, CUF-1): title, 印, start day (today / the next 1st = 1日組) and,
 * for a new account, the nickname shown in みんな. Used by Today, RecipeDetail and Gacha.
 * Starting is optimistic through the store, so it also works offline (the create is queued).
 */
import { useId, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { LIMITS, diffDays, firstGrapheme, isFirstOfMonth, jpDate, jpPeriod, nextFirst, type Recipe, type Suggestion } from "@thirty/shared";
import { TextField } from "../../components/Field";
import { Sheet } from "../../components/Sheet";
import { useToast } from "../../components/Toast";
import { isOpen } from "../../lib/challenge";
import { useApp } from "../../lib/store";
import { SealField } from "./SealField";
import "./start.css";

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

/** The server's name for an account that never chose one. */
export const DEFAULT_NICKNAME = "名無し";

export function isDefaultNickname(nickname: string | null | undefined): boolean {
  const n = (nickname ?? "").trim();
  return n === "" || n === DEFAULT_NICKNAME;
}

export function StartChallengeSheet(props: StartChallengeSheetProps) {
  return (
    <Sheet open={props.open} onClose={props.onClose} title="新しい30日">
      {/* Mounted only while open, so every opening starts from the recipe / preset again. */}
      <StartForm {...props} />
    </Sheet>
  );
}

type When = "today" | "first";

function StartForm({ onClose, recipe, preset, onStarted }: StartChallengeSheetProps) {
  const app = useApp();
  const navigate = useNavigate();
  const toast = useToast();
  const uid = useId();

  const p: StartPreset | null = preset ?? null;
  const recipeId = recipe?.id ?? p?.recipeId ?? null;
  const [title, setTitle] = useState(() => p?.title ?? recipe?.title ?? "");
  const [seal, setSeal] = useState(() => p?.seal ?? recipe?.seal ?? "");
  const [when, setWhen] = useState<When>(() => (p?.firstOfMonth ? "first" : "today"));
  // Decided once per opening, so the field does not vanish when the account is created meanwhile.
  const [askNickname] = useState(() => !app.hasSession || !app.user || isDefaultNickname(app.user.nickname));
  const [nickname, setNickname] = useState(() => app.pendingNickname ?? (app.user && !isDefaultNickname(app.user.nickname) ? app.user.nickname : ""));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const today = app.today;
  const nf = nextFirst(today);
  const openCount = app.challenges.filter(isOpen).length;
  const full = openCount >= LIMITS.openChallenges;
  const sealFallback = firstGrapheme(title.trim());
  const ids = { title: `${uid}-title`, seal: `${uid}-seal`, nickname: `${uid}-nick`, when: `${uid}-when` };

  function submit(e: FormEvent) {
    e.preventDefault();
    const startDate = when === "today" ? today : nf;
    const res = app.startChallenge({
      title,
      seal: seal.trim() || sealFallback,
      startDate,
      recipeId,
      nickname: askNickname ? nickname : undefined,
    });
    if (!res.ok) {
      const fields = res.fields;
      setErrors(fields);
      const known = ["title", "seal", "nickname", "startDate"].filter((k) => fields[k]);
      setFormError(known.length ? null : res.message);
      const first = known[0] === "startDate" ? ids.when : known[0] ? ids[known[0] as "title" | "seal" | "nickname"] : null;
      if (first) document.getElementById(first)?.focus();
      return;
    }
    toast(when === "today" ? "30日、スタート。きょうの分を押しましょう" : `${jpDate(startDate)}から始まります。1日組で予約しました`);
    onClose();
    if (onStarted) onStarted(res.value.id);
    else navigate("/");
  }

  const clear = (key: string) => {
    if (errors[key]) setErrors(({ [key]: _gone, ...rest }) => rest);
  };

  return (
    <form className="st-form" onSubmit={submit} noValidate>
      {full && (
        <p className="st-full" role="status">
          いま進めている30日が{LIMITS.openChallenges}件あります。どれかを振り返るか削除すると、新しく始められます。
        </p>
      )}

      <TextField
        id={ids.title}
        label="チャレンジ名"
        value={title}
        onChange={(v) => {
          setTitle(v);
          clear("title");
        }}
        max={LIMITS.challengeTitle}
        error={errors.title}
        placeholder="例：毎日1枚、写真を撮る"
        autoComplete="off"
        enterKeyHint="next"
      />

      <SealField
        id={ids.seal}
        value={seal}
        onChange={(v) => {
          setSeal(v);
          clear("seal");
        }}
        fallback={sealFallback}
        error={errors.seal}
      />

      <fieldset className="st-when" aria-describedby={errors.startDate ? `${ids.when}-err` : undefined}>
        <legend>いつから</legend>
        <label className="st-radio">
          <input
            id={ids.when}
            type="radio"
            name={`${uid}-when`}
            value="today"
            checked={when === "today"}
            onChange={() => {
              setWhen("today");
              clear("startDate");
            }}
          />
          <span>
            <b>今日から{isFirstOfMonth(today) ? "（1日組）" : ""}</b>
            <small>{jpPeriod(today)}</small>
          </span>
        </label>
        <label className="st-radio">
          <input
            type="radio"
            name={`${uid}-when`}
            value="first"
            checked={when === "first"}
            onChange={() => {
              setWhen("first");
              clear("startDate");
            }}
          />
          <span>
            <b>{jpDate(nf)}から（1日組）</b>
            <small>
              同じ日に始める仲間と並びます。あと{diffDays(today, nf)}日 · {jpPeriod(nf)}
            </small>
          </span>
        </label>
        {errors.startDate && (
          <span className="field-err" id={`${ids.when}-err`}>
            {errors.startDate}
          </span>
        )}
      </fieldset>

      {askNickname && (
        <TextField
          id={ids.nickname}
          label="ニックネーム（任意）"
          value={nickname}
          onChange={(v) => {
            setNickname(v);
            clear("nickname");
          }}
          max={LIMITS.nickname}
          error={errors.nickname}
          placeholder={DEFAULT_NICKNAME}
          hint="「みんな」の1日組の一覧に表示されます。空けておくと「名無し」。あとから設定で変えられます。"
          autoComplete="nickname"
          enterKeyHint="done"
        />
      )}

      <p className="st-note">
        {app.user?.shareProgress === false
          ? "進捗の公開はオフになっています。「みんな」には表示されません（設定で変えられます）。"
          : "進捗（タイトル・印・押した日）は「みんな」に表示されます。ひとことメモと写真は表示されません。設定でオフにできます。"}
      </p>

      {formError && (
        <p className="st-error" role="alert">
          {formError}
        </p>
      )}

      <button type="submit" className="btn primary lg st-submit" disabled={full}>
        30日、始める
      </button>
    </form>
  );
}
