/**
 * /recipes/:id — one recipe (SPEC FR-10, FR-11, FR-18): 何をする / やり方のコツ / 30日後に起こりそうなこと,
 * stories (newest first), "これを30日やる" (StartChallengeSheet) and "体験談を書く".
 * Official recipes render at once from the bundle and work offline (without stories).
 */
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { LIMITS, StoryInputSchema, TOTAL_DAYS, VERDICTS, VERDICT_KEYS, type Recipe, type Story, type Verdict } from "@thirty/shared";
import { ChipGroup, type ChipOption } from "../components/Chip";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ConsentNote } from "../components/ConsentNote";
import { Field, TextAreaField, TextField } from "../components/Field";
import { ChevronLeftIcon } from "../components/Icons";
import { RecipeMeta } from "../components/RecipeMeta";
import { ReportButton } from "../components/ReportButton";
import { Seal } from "../components/Seal";
import { Sheet } from "../components/Sheet";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { useToast } from "../components/Toast";
import { StartChallengeSheet } from "../features/start/StartChallengeSheet";
import { ApiClientError, errorMessage, isQuotaLimit } from "../lib/api";
import { usePageTitle } from "../lib/hooks";
import { deleteRecipe, deleteStory, postStory, useRecipe } from "../lib/recipes";
import { useApp, useToday } from "../lib/store";
import { parseWith } from "../lib/validation";
import { AFTER_LABEL, CategoryTag, HowList, RecipeSection, RecipeTags } from "./recipeParts";

/** Epoch ms → "10月6日" (with the year when it is not this year). */
function postedOn(ms: number, today: string): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  const y = d.getFullYear();
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return String(y) === today.slice(0, 4) ? md : `${y}年${md}`;
}

export default function RecipeDetailPage() {
  const { id } = useParams();
  const detail = useRecipe(id);
  const { recipe, stories } = detail;
  usePageTitle(recipe?.title ?? "レシピ");
  const navigate = useNavigate();
  const toast = useToast();
  const today = useToday();
  const { user, pendingNickname } = useApp();
  const [startOpen, setStartOpen] = useState(false);
  const [storyOpen, setStoryOpen] = useState(false);
  const [confirmRecipe, setConfirmRecipe] = useState(false);
  const [storyToDelete, setStoryToDelete] = useState<Story | null>(null);
  const [busy, setBusy] = useState(false);

  if (detail.notFound) {
    return (
      <section className="stack">
        <BackLink />
        <EmptyState
          seal="無"
          title="レシピが見つかりませんでした"
          action={
            <Link to="/recipes" className="btn primary">
              レシピ一覧へ
            </Link>
          }
        >
          削除されたか、URLが変わった可能性があります。
        </EmptyState>
      </section>
    );
  }

  if (!recipe) {
    return (
      <section className="stack">
        <BackLink />
        {detail.loading ? (
          <Loading />
        ) : (
          <ErrorState message={detail.error ?? "もう一度お試しください。"} onRetry={detail.reload} retrying={detail.loading} />
        )}
      </section>
    );
  }

  const r = recipe;
  const community = r.source === "community";

  async function removeRecipe() {
    setBusy(true);
    try {
      await deleteRecipe(r.id);
      toast("レシピを削除しました");
      navigate("/recipes", { replace: true });
    } catch (err) {
      toast(errorMessage(err), { tone: "error" });
      setBusy(false);
      setConfirmRecipe(false);
    }
  }

  async function removeStory(s: Story) {
    setBusy(true);
    try {
      await deleteStory(r.id, s.id);
      detail.removeStory(s.id);
      toast("体験談を削除しました");
    } catch (err) {
      toast(errorMessage(err), { tone: "error" });
    } finally {
      setBusy(false);
      setStoryToDelete(null);
    }
  }

  return (
    <article className="stack rd-page" aria-labelledby="rd-title">
      <BackLink />

      <header className={`card rd-head cat-${r.category}`}>
        <div className="rhead">
          <Seal char={r.seal} size="xl" label={`印「${r.seal}」`} />
          <div>
            <CategoryTag category={r.category} />
            <h1 className="rtitle rd-title" id="rd-title">
              {r.title}
            </h1>
            <RecipeMeta recipe={r}>
              <RecipeTags recipe={r} />
            </RecipeMeta>
          </div>
        </div>
        {community && (
          <p className="note rd-author">
            {r.authorName ?? "名無し"}さんの投稿
            {r.createdAt ? `・${postedOn(r.createdAt, today)}` : ""}
          </p>
        )}
      </header>

      <div className="card stack rd-body">
        <RecipeSection title="何をする" id="rd-what">
          <p className="lead">{r.summary}</p>
        </RecipeSection>
        {r.how.length > 0 && (
          <RecipeSection title="やり方のコツ" id="rd-how">
            <HowList how={r.how} />
          </RecipeSection>
        )}
        {r.after.trim() !== "" && (
          <RecipeSection title={AFTER_LABEL} id="rd-after">
            <p>{r.after}</p>
          </RecipeSection>
        )}
      </div>

      <div className="rd-ctas">
        <button type="button" className="btn primary lg" onClick={() => setStartOpen(true)}>
          これを30日やる
        </button>
        <button type="button" className="btn" onClick={() => setStoryOpen(true)}>
          体験談を書く
        </button>
      </div>

      {community && (
        <div className="row gap fw rd-owner">
          {r.isMine ? (
            <button type="button" className="btn sm danger" onClick={() => setConfirmRecipe(true)}>
              このレシピを削除
            </button>
          ) : (
            <ReportButton targetType="recipe" targetId={r.id} subject="このレシピ" />
          )}
        </div>
      )}

      <section className="stack rd-stories" aria-labelledby="rd-stories">
        <h2 className="h3" id="rd-stories">
          体験談{stories && stories.length > 0 ? `（${stories.length}）` : ""}
        </h2>
        {stories === null ? (
          detail.loading ? (
            <Loading inline label="体験談を読み込んでいます…" />
          ) : (
            <ErrorState title="体験談を読み込めませんでした" message={detail.error ?? "もう一度お試しください。"} onRetry={detail.reload} />
          )
        ) : stories.length === 0 ? (
          <EmptyState title="まだ体験談はありません">やってみたら、最初の体験談を書いてみませんか？</EmptyState>
        ) : (
          <ul className="rd-storylist">
            {stories.map((s) => (
              <StoryItem key={s.id} story={s} recipeId={r.id} today={today} onDelete={() => setStoryToDelete(s)} />
            ))}
          </ul>
        )}
      </section>

      {startOpen && <StartChallengeSheet open onClose={() => setStartOpen(false)} recipe={{ id: r.id, title: r.title, seal: r.seal }} />}

      <StorySheet
        open={storyOpen}
        recipe={r}
        defaultName={user?.nickname || pendingNickname || ""}
        onClose={() => setStoryOpen(false)}
        onPosted={(story) => {
          detail.addStory(story);
          detail.reload();
          setStoryOpen(false);
          toast("体験談を公開しました");
        }}
      />

      <ConfirmDialog
        open={confirmRecipe}
        title="このレシピを削除しますか？"
        message="レシピと、ついている体験談がすべて消えます。元に戻せません。"
        confirmLabel="削除する"
        danger
        busy={busy}
        onConfirm={() => void removeRecipe()}
        onCancel={() => setConfirmRecipe(false)}
      />
      <ConfirmDialog
        open={storyToDelete !== null}
        title="この体験談を削除しますか？"
        message="元に戻せません。"
        confirmLabel="削除する"
        danger
        busy={busy}
        onConfirm={() => storyToDelete && void removeStory(storyToDelete)}
        onCancel={() => setStoryToDelete(null)}
      />
    </article>
  );
}

function BackLink() {
  return (
    <Link to="/recipes" className="backlink">
      <ChevronLeftIcon />
      レシピ一覧
    </Link>
  );
}

function StoryItem({ story, recipeId, today, onDelete }: { story: Story; recipeId: string; today: string; onDelete: () => void }) {
  const name = story.authorName || "名無し";
  const verdict = story.verdict && story.verdict in VERDICTS ? story.verdict : null;
  return (
    <li className="rd-story" data-testid="story">
      <div className="row between gap fw">
        <b className="rd-story-who">{name}</b>
        <span className="row gap fw">
          {typeof story.days === "number" && <span className="tag">{story.days}日</span>}
          {verdict && <span className={`badge ${verdict}`}>{VERDICTS[verdict].label}</span>}
        </span>
      </div>
      <blockquote className="story">{story.body}</blockquote>
      <div className="row between gap">
        <span className="note">{postedOn(story.createdAt, today)}</span>
        {story.isMine ? (
          <button type="button" className="linkbtn danger" onClick={onDelete}>
            削除<span className="sr-only">（あなたの体験談）</span>
          </button>
        ) : (
          <ReportButton targetType="story" targetId={`${recipeId}:${story.id}`} subject={`${name}さんの体験談`} />
        )}
      </div>
    </li>
  );
}

type VerdictChoice = Verdict | "none";
const VERDICT_OPTIONS: readonly ChipOption<VerdictChoice>[] = [
  { value: "none", label: "選ばない" },
  ...VERDICT_KEYS.map((k) => ({ value: k, label: VERDICTS[k].label })),
];

type StorySheetProps = {
  open: boolean;
  recipe: Pick<Recipe, "id" | "title" | "seal">;
  defaultName: string;
  onClose: () => void;
  onPosted: (story: Story) => void;
};

/** "体験談を書く": body (500), name, optional days and verdict. The draft survives closing the sheet. */
function StorySheet({ open, recipe, defaultName, onClose, onPosted }: StorySheetProps) {
  const [body, setBody] = useState("");
  // null = untouched → follows the nickname (which may arrive after the first render).
  const [name, setName] = useState<string | null>(null);
  const [days, setDays] = useState("");
  const [verdict, setVerdict] = useState<VerdictChoice>("none");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shownName = name ?? defaultName;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const input = {
      body,
      ...(shownName.trim() ? { authorName: shownName } : {}),
      ...(days.trim() !== "" ? { days: days.trim() } : {}),
      ...(verdict !== "none" ? { verdict } : {}),
    };
    const parsed = parseWith(StoryInputSchema, input);
    if (!parsed.ok) {
      setErrors(friendlyStoryErrors(parsed.fields));
      setFormError(null);
      return;
    }
    setErrors({});
    setFormError(null);
    setBusy(true);
    try {
      const story = await postStory(recipe.id, parsed.data);
      setBody("");
      setDays("");
      setVerdict("none");
      onPosted(story);
    } catch (err) {
      if (isQuotaLimit(err)) {
        setFormError("今日の体験談はここまでです。明日また書けます。");
      } else {
        if (err instanceof ApiClientError && err.fields) setErrors(friendlyStoryErrors(err.fields));
        setFormError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="体験談を書く" dismissible={!busy}>
      <form className="form" onSubmit={submit} noValidate>
        <div className="rhead">
          <Seal char={recipe.seal} size="lg" />
          <div>
            <b>{recipe.title}</b>
          </div>
        </div>
        <TextAreaField
          label="体験談"
          value={body}
          onChange={setBody}
          max={LIMITS.story}
          rows={6}
          error={errors.body}
          placeholder="いつやった？ 何日続いた？ やってみてどうだった？"
        />
        <TextField label="名前" value={shownName} onChange={setName} max={LIMITS.nickname} error={errors.authorName} placeholder="名無し" autoComplete="nickname" />
        <Field label="続いた日数（任意）" hint={`0〜${TOTAL_DAYS}日`} error={errors.days}>
          {(a) => (
            <input
              id={a.id}
              type="number"
              inputMode="numeric"
              min={0}
              max={TOTAL_DAYS}
              step={1}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              aria-describedby={a.describedBy}
              aria-invalid={a.invalid || undefined}
            />
          )}
        </Field>
        <div className="field">
          <span className="label" id="story-verdict-label">
            そのあと（任意）
          </span>
          <ChipGroup labelledBy="story-verdict-label" value={verdict} options={VERDICT_OPTIONS} onChange={setVerdict} />
        </div>
        <p className="note">このレシピを開いた人全員に表示されます。URLは入れられません。</p>
        {formError && (
          <p className="note err" role="alert">
            {formError}
          </p>
        )}
        <ConsentNote action="post" />
        <button type="submit" className="btn primary lg" disabled={busy} aria-busy={busy}>
          {busy ? "送信中…" : "公開する"}
        </button>
      </form>
    </Sheet>
  );
}

function friendlyStoryErrors(fields: Record<string, string>): Record<string, string> {
  const out = { ...fields };
  if (out.days) out.days = `日数は0〜${TOTAL_DAYS}の数字で入力してください`;
  return out;
}
