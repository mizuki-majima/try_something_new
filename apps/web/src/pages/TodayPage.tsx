/**
 * きょう "/" (SPEC UI, FR-3/FR-4, CUF-1): first visit → hero with three ways to start (レシピ as the one
 * green button, ガチャ as an outline button, 自分で決める as a text button); otherwise one stamp card per
 * open challenge (active / waiting / ended), then the "次の1日組" teaser and 「もうひとつ試す？」 as a row of
 * quiet links. Every write goes through the store (optimistic, queued offline).
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";
import {
  API,
  EARLY_REFLECT_FROM_DAY,
  LIMITS,
  TOTAL_DAYS,
  diffDays,
  jpDate,
  jpPeriod,
  nextFirst,
  type Challenge,
  type UpcomingResponse,
} from "@thirty/shared";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { TextField } from "../components/Field";
import { Grid30 } from "../components/Grid30";
import { NoteShareSwitch, useShownNoteEdit, useUnstampedNoteToast } from "../components/NoteShareSwitch";
import { Seal } from "../components/Seal";
import { ErrorState, Loading } from "../components/States";
import { useToast } from "../components/Toast";
import { StartChallengeSheet, type StartPreset } from "../features/start/StartChallengeSheet";
import { errorMessage, request } from "../lib/api";
import { isOpen, sortForToday, viewChallenge } from "../lib/challenge";
import { prefersReducedMotion, usePageTitle } from "../lib/hooks";
import { NOTE_SHOWN_UNSTAMP, cleanNote, noteFieldSuffix } from "../lib/noteShare";
import { useApp, useAppActions, useStillShown, useUser } from "../lib/store";
import "./today.css";

const TED_TALK_URL = "https://www.ted.com/talks/matt_cutts_try_something_new_for_30_days";

export default function TodayPage() {
  usePageTitle();
  const app = useApp();
  const { challenges, today, ready, hasSession, lastSyncError, lastSyncedAt, refreshing, online } = app;
  const [start, setStart] = useState<{ preset: StartPreset | null } | null>(null);

  const open = useMemo(() => sortForToday(challenges.filter(isOpen), today), [challenges, today]);
  const doneCount = challenges.length - challenges.filter(isOpen).length;
  const nf = nextFirst(today);
  const reserved = open.filter((c) => c.startDate === nf).length;

  let main;
  if (!ready && challenges.length === 0) {
    main = <Loading label="記録を読み込んでいます…" />;
  } else if (challenges.length === 0 && hasSession && lastSyncedAt === null && lastSyncError) {
    main = (
      <>
        <h1 className="td-date">きょう</h1>
        <ErrorState title="記録を読み込めませんでした" message={lastSyncError} onRetry={() => void app.refresh()} retrying={refreshing} />
      </>
    );
  } else if (open.length === 0) {
    main = <Hero onCustom={() => setStart({ preset: null })} />;
  } else {
    main = (
      <>
        <h1 className="td-date">
          きょう<span>{jpDate(today)}</span>
        </h1>
        <div className="td-list">
          {open.map((c) => (
            <ChallengeCard key={c.id} challenge={c} today={today} />
          ))}
        </div>
      </>
    );
  }

  return (
    <div className="td-page">
      {main}
      <CohortTeaser today={today} online={online} reserved={reserved} onReserve={() => setStart({ preset: { firstOfMonth: true } })} />
      {open.length > 0 && open.length < LIMITS.openChallenges && (
        <section className="td-more" aria-labelledby="td-more-h">
          <h2 id="td-more-h" className="td-more-h">
            もうひとつ試す？
          </h2>
          <div className="td-more-links">
            <Link className="linkbtn" to="/recipes">
              レシピから選ぶ
            </Link>
            <Link className="linkbtn" to="/gacha">
              ガチャで決める
            </Link>
            <button type="button" className="linkbtn" onClick={() => setStart({ preset: null })}>
              自分で決める
            </button>
          </div>
        </section>
      )}
      {doneCount > 0 && (
        <p className="td-history">
          振り返りを終えた30日：<b>{doneCount}件</b>
          <Link to="/log">記録を見る</Link>
        </p>
      )}
      <StartChallengeSheet open={start !== null} onClose={() => setStart(null)} preset={start?.preset ?? null} />
    </div>
  );
}

// ---------- hero (first visit) ----------

function Hero({ onCustom }: { onCustom: () => void }) {
  return (
    <section className="td-hero" aria-labelledby="td-hero-h">
      <span className="td-hero-seal" aria-hidden="true">
        卅
      </span>
      <p className="td-hero-kicker">新しいことを、30日だけ。</p>
      <h1 id="td-hero-h" className="td-hero-h">
        <span className="td-ph">どうせ過ぎる</span>
        <span className="td-ph">
          <mark>30日</mark>なら、
        </span>
        <br />
        <span className="td-ph">ひとつ試してみる。</span>
      </h1>
      <p className="td-hero-sub">続けなくていい。30日だけ、新しいことをやってみる場所です。やめるのも、形を変えるのも、立派な結果。</p>
      <div className="td-ctas">
        <Link className="btn primary lg td-cta" to="/recipes">
          レシピから選ぶ
        </Link>
        <Link className="btn lg td-cta" to="/gacha">
          ガチャで決める
        </Link>
        <button type="button" className="linkbtn td-cta-text" onClick={onCustom}>
          自分で決める
        </button>
      </div>
      <ol className="td-steps">
        <li className="td-step td-step-1">
          <span className="td-step-n" aria-hidden="true">
            1
          </span>
          <b>ひとつ選ぶ</b>
          <small>レシピ、ガチャ、または自分で</small>
        </li>
        <li className="td-step td-step-2">
          <span className="td-step-n" aria-hidden="true">
            2
          </span>
          <b>毎日1タップ</b>
          <small>カードに印を押す。忘れた日は空けておけばいい</small>
        </li>
        <li className="td-step td-step-3">
          <span className="td-step-n" aria-hidden="true">
            3
          </span>
          <b>30日目に決める</b>
          <small>続ける／やめる／形を変える</small>
        </li>
      </ol>
      <p className="td-credit">
        着想：
        <a href={TED_TALK_URL} target="_blank" rel="noopener noreferrer">
          Matt Cutts “Try something new for 30 days”（TED）<span className="sr-only">（新しいタブで開きます）</span>
        </a>
      </p>
    </section>
  );
}

// ---------- one challenge ----------

function vibrate(): void {
  try {
    if (!prefersReducedMotion()) navigator.vibrate?.(18);
  } catch {
    // not supported
  }
}

function ChallengeCard({ challenge: c, today }: { challenge: Challenge; today: string }) {
  const { stamp, unstamp, updateChallenge } = useAppActions();
  const toast = useToast();
  const unstamped = useUnstampedNoteToast();
  const titleId = useId();
  const v = viewChallenge(c, today);
  const [fresh, setFresh] = useState<number | null>(null);
  const [confirmUndo, setConfirmUndo] = useState<number | null>(null);
  const doneRef = useRef<HTMLParagraphElement>(null);
  const stampRef = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<"done" | "stamp" | null>(null);

  // The "ドン" animation plays once, right after this card's stamp button was pressed.
  useEffect(() => {
    if (fresh === null) return;
    const t = setTimeout(() => setFresh(null), 1600);
    return () => clearTimeout(t);
  }, [fresh]);

  // The pressed button disappears; keep keyboard / screen-reader focus on what replaced it.
  useEffect(() => {
    const target = focusNext.current === "done" ? doneRef.current : focusNext.current === "stamp" ? stampRef.current : null;
    if (target) {
      target.focus({ preventScroll: true });
      focusNext.current = null;
    }
  });

  function doStamp(day: number, fromButton = false) {
    const r = stamp(c.id, day);
    if (!r.ok) {
      toast(r.message, { tone: "error" });
      return;
    }
    setFresh(day);
    vibrate();
    if (fromButton) focusNext.current = "done";
  }

  function doUnstamp(day: number, confirmed = false) {
    const note = c.stamps[String(day)]?.note;
    if (note && !confirmed) {
      setConfirmUndo(day);
      return;
    }
    const r = unstamp(c.id, day);
    if (!r.ok) {
      toast(r.message, { tone: "error" });
      return;
    }
    unstamped(c.id, day);
    if (v.phase === "active" && day === v.day) focusNext.current = "stamp";
  }

  function toggle(day: number) {
    if (c.stamps[String(day)]) doUnstamp(day);
    else doStamp(day);
  }

  function startToday() {
    const r = updateChallenge(c.id, { startDate: today });
    if (!r.ok) toast(r.message, { tone: "error" });
    else toast("今日から始めました。1日目の分を押しましょう");
  }

  const canToggle = v.phase === "active" || v.phase === "ended";
  const gridToday = v.phase === "active" ? v.day : v.phase === "ended" ? TOTAL_DAYS : 0;
  const todayNote = v.todayStamped ? (c.stamps[String(v.day)]?.note ?? "") : "";
  const todayShown = v.todayStamped && c.stamps[String(v.day)]?.shown === true;
  const undoNote = confirmUndo !== null ? (c.stamps[String(confirmUndo)]?.note ?? "") : "";
  const undoMessage = `この日のひとこと「${undoNote}」も消えます。`;
  const undoShown = confirmUndo !== null && c.stamps[String(confirmUndo)]?.shown === true;

  return (
    <article className={`td-card td-${v.phase}${fresh !== null ? " is-thud" : ""}`} aria-labelledby={titleId}>
      <header className="td-head">
        <Seal char={c.seal} size="lg" label={`印「${c.seal}」`} />
        <div className="td-headtext">
          <h2 className="td-title" id={titleId}>
            {c.title}
          </h2>
          <p className="td-meta">
            <span>{jpPeriod(c.startDate)}</span>
            {v.phase === "active" && <span className="td-tag td-tag-day">{v.day}日目</span>}
            {v.phase === "waiting" && <span className="td-tag">予約中</span>}
            {v.phase === "ended" && <span className="td-tag td-tag-end">振り返り待ち</span>}
            {v.firstOfMonth && <span className="td-tag td-tag-first">1日組</span>}
          </p>
        </div>
        <p className="td-count">
          <b>{v.stampCount}</b>
          <small>/30</small>
          <span className="sr-only">日 押した</span>
        </p>
      </header>

      <Grid30
        seal={c.seal}
        stampedDays={v.stampedDays}
        today={gridToday}
        locked={v.phase !== "active"}
        justStamped={fresh}
        onCellClick={canToggle ? toggle : undefined}
        label={`「${c.title}」の30日カード`}
        className="td-grid"
      />

      <div className="td-action">
        {v.phase === "active" && !v.todayStamped && (
          <button ref={stampRef} type="button" className="btn primary lg stampbtn td-stamp" onClick={() => doStamp(v.day, true)}>
            <Seal char={c.seal} inverse />
            <span>きょう（{v.day}日目）の分を押す</span>
          </button>
        )}
        {v.phase === "active" && v.todayStamped && (
          <div className={fresh === v.day ? "td-done is-fresh" : "td-done"}>
            <div className="td-done-row">
              <span className="td-done-seal" aria-hidden="true">
                {c.seal}
              </span>
              <div className="td-done-msg">
                <p className="td-done-text" ref={doneRef} tabIndex={-1}>
                  {v.day}日目、押しました
                </p>
                <button type="button" className="linkbtn td-undo" onClick={() => doUnstamp(v.day)}>
                  取り消す
                </button>
              </div>
            </div>
            <DayNoteInput challengeId={c.id} day={v.day} note={todayNote} isShown={todayShown} />
          </div>
        )}
        {v.phase === "waiting" && (
          <div className="td-wait">
            <p>
              <b>{jpDate(c.startDate)}にスタート</b>
              <span>
                あと{v.daysUntilStart}日。{v.firstOfMonth ? "同じ日に始める仲間と並びます。" : ""}
              </span>
            </p>
            <button type="button" className="btn" onClick={startToday}>
              今日から始める
            </button>
          </div>
        )}
        {v.phase === "ended" && (
          <div className="td-end">
            <p className="td-end-h">30日が終わりました</p>
            <p>
              おつかれさまでした。{v.stampCount}日押せました。続ける・やめる・形を変えるを決めて、カードにしましょう。
            </p>
            <Link className="btn primary lg" to={`/c/${c.id}/reflect`}>
              振り返る
            </Link>
          </div>
        )}
      </div>

      <div className="td-foot">
        <Link to={`/c/${c.id}`}>詳細・メモ</Link>
        {v.phase === "active" && v.day >= EARLY_REFLECT_FROM_DAY && <Link to={`/c/${c.id}/reflect`}>ここで区切る</Link>}
      </div>

      <ConfirmDialog
        open={confirmUndo !== null}
        title={`${confirmUndo ?? ""}日目の印を取り消しますか？`}
        message={
          undoShown ? (
            <>
              <p>{undoMessage}</p>
              <p>{NOTE_SHOWN_UNSTAMP}</p>
            </>
          ) : (
            undoMessage
          )
        }
        confirmLabel="取り消す"
        cancelLabel="そのままにする"
        danger
        onConfirm={() => {
          const day = confirmUndo;
          setConfirmUndo(null);
          if (day !== null) doUnstamp(day, true);
        }}
        onCancel={() => setConfirmUndo(null)}
      />
    </article>
  );
}

/**
 * One-line ひとこと for today's stamp. Saves on blur and on Enter (not while an IME is composing).
 * `isShown`: the note is shown in 「みんな」 (#17); saving another text makes it private again.
 */
function DayNoteInput({ challengeId, day, note, isShown }: { challengeId: string; day: number; note: string; isShown: boolean }) {
  const { setNote } = useAppActions();
  const toast = useToast();
  const shownNoteEdit = useShownNoteEdit();
  // The server still shows the old text (an edit is queued): another edit is an edit of a shown note too.
  const stillShown = useStillShown(challengeId, day);
  const progressOn = useUser()?.shareProgress !== false;
  const [draft, setDraft] = useState(note);
  const [synced, setSynced] = useState(note);
  const [saved, setSaved] = useState(false);
  if (note !== synced) {
    // The stored note changed (saved, or synced from elsewhere): show it.
    setSynced(note);
    setDraft(note);
  }

  /** False when the draft could not be saved (the toast says why). */
  function save(): boolean {
    if (draft === note) return true;
    const r = setNote(challengeId, day, draft);
    if (!r.ok) {
      toast(r.message, { tone: "error" });
      return false;
    }
    setSaved(true);
    if ((isShown || stillShown) && cleanNote(draft) !== note) shownNoteEdit.edited(challengeId, day);
    return true;
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    save();
  }

  return (
    <div className="td-note">
      <TextField
        label={`きょうのひとこと${noteFieldSuffix(isShown, progressOn)}`}
        value={draft}
        onChange={(value) => {
          setDraft(value);
          setSaved(false);
        }}
        onBlur={() => save()}
        onKeyDown={onKeyDown}
        max={LIMITS.note}
        placeholder="例：朝の光がきれいだった"
        enterKeyHint="done"
        autoComplete="off"
      />
      <p className="td-saved" role="status" aria-live="polite">
        {saved ? "保存しました" : ""}
      </p>
      <NoteShareSwitch
        challengeId={challengeId}
        day={day}
        note={note}
        shown={isShown}
        draft={draft}
        onSaveDraft={save}
        resetAt={shownNoteEdit.resetAt}
      />
    </div>
  );
}

// ---------- 次の1日組 ----------

type Upcoming = { key: string; data?: UpcomingResponse; error?: string };

function CohortTeaser({ today, online, reserved, onReserve }: { today: string; online: boolean; reserved: number; onReserve: () => void }) {
  const nf = nextFirst(today);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Upcoming | null>(null);
  const key = `${nf}#${attempt}`;

  useEffect(() => {
    if (!online) return;
    const ctrl = new AbortController();
    request<UpcomingResponse>("GET", API.cohortUpcoming, { signal: ctrl.signal }).then(
      (data) => setState({ key, data }),
      (err: unknown) => {
        if (!ctrl.signal.aborted) setState({ key, error: errorMessage(err) });
      },
    );
    return () => ctrl.abort();
  }, [key, online]);

  const current = state?.key === key ? state : null;
  const data = current?.data && current.data.startDate === nf ? current.data : null;
  // count is reservations (one person may have several); peopleCount, when sent, is people.
  const people = data?.peopleCount;

  return (
    <section className="td-teaser" aria-labelledby="td-teaser-h">
      <div className="td-teaser-text">
        <h2 id="td-teaser-h" className="td-teaser-h">
          次の1日組
        </h2>
        <p className="td-teaser-date">
          <b>{jpDate(nf)}</b>スタート
          <span className="td-teaser-left">あと{diffDays(today, nf)}日</span>
        </p>
        <p className="td-teaser-meta" aria-live="polite">
          {!online ? null : data ? (
            typeof people === "number" ? (
              <>
                いま予約しているのは<b>{people}人</b>
              </>
            ) : (
              <>
                いまの予約は<b>{data.count}件</b>
              </>
            )
          ) : current?.error ? (
            <>
              予約の人数を読み込めませんでした。
              <button type="button" className="linkbtn" onClick={() => setAttempt((n) => n + 1)}>
                再試行
              </button>
            </>
          ) : (
            "予約の人数を確認しています…"
          )}
          {reserved > 0 && <span className="td-tag td-tag-first">あなたも予約済み</span>}
        </p>
        <p className="td-teaser-note">同じ日に始める人と「みんな」で進み具合が並びます。</p>
      </div>
      <div className="td-teaser-btns">
        <button type="button" className="btn td-teaser-btn" onClick={onReserve}>
          {reserved > 0 ? "もうひとつ予約する" : "1日組で予約する"}
        </button>
        <Link to="/together" className="td-teaser-link">
          みんなを見る
        </Link>
      </div>
    </section>
  );
}
