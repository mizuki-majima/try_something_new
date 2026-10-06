/**
 * チャレンジ詳細 "/c/:id" (SPEC UI, FR-3/4/5/14): the 30 cells — tap a day for its ひとこと, photo
 * (device only) and a forgotten stamp — plus edit, reminders (push settings / calendar), "ここで区切る",
 * delete, the list of notes and, once reflected, the reflection and the share card.
 */
import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type Ref } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { EARLY_REFLECT_FROM_DAY, LIMITS, TOTAL_DAYS, addDays, firstGrapheme, jpDate, jpPeriod, nextFirst, type Challenge } from "@thirty/shared";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { TextAreaField, TextField } from "../components/Field";
import { Grid30 } from "../components/Grid30";
import { CalendarIcon, CameraIcon, ChevronLeftIcon, DownloadIcon, EditIcon, TrashIcon } from "../components/Icons";
import { Seal } from "../components/Seal";
import { Sheet } from "../components/Sheet";
import { EmptyState, Loading } from "../components/States";
import { useToast } from "../components/Toast";
import { VerdictBadge } from "../features/share/VerdictBadge";
import { SealField } from "../features/start/SealField";
import { downloadIcs, googleCalendarUrl, reminderSchedule, type ReminderEvent } from "../lib/calendar";
import { viewChallenge, type ChallengeView } from "../lib/challenge";
import { usePageTitle } from "../lib/hooks";
import { canStorePhotos, deleteChallengePhotos, deletePhoto, getPhotoUrl, listPhotoDays, photoErrorMessage, savePhoto } from "../lib/photos";
import { useApp, useAppActions } from "../lib/store";
import "./challenge.css";

export default function ChallengePage() {
  const { id } = useParams();
  const { challenges, today, ready } = useApp();
  const c = useMemo(() => challenges.find((x) => x.id === id), [challenges, id]);
  usePageTitle(c ? c.title : "チャレンジ");

  if (!c) {
    if (!ready) return <Loading label="読み込んでいます…" />;
    return (
      <section className="cp">
        <h1 className="cp-h1">チャレンジが見つかりません</h1>
        <EmptyState
          seal="無"
          title="このチャレンジはありません"
          action={
            <Link to="/" className="btn primary">
              きょうに戻る
            </Link>
          }
        >
          削除したか、別の端末のアカウントのものかもしれません。
        </EmptyState>
      </section>
    );
  }
  return <ChallengeDetail key={c.id} c={c} today={today} />;
}

function ChallengeDetail({ c, today }: { c: Challenge; today: string }) {
  const { deleteChallenge } = useAppActions();
  const navigate = useNavigate();
  const toast = useToast();
  const v = viewChallenge(c, today);
  const [selected, setSelected] = useState<number | null>(v.phase === "active" ? v.day : null);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [photoVersion, setPhotoVersion] = useState(0);
  const [photoDays, setPhotoDays] = useState<number[]>([]);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;
    listPhotoDays(c.id).then((days) => {
      if (!cancelled) setPhotoDays(days);
    });
    return () => {
      cancelled = true;
    };
  }, [c.id, photoVersion]);

  const gridToday = v.phase === "active" ? v.day : v.phase === "ended" ? TOTAL_DAYS : v.maxDay;
  const notes = v.stampedDays.map((d) => ({ day: d, note: c.stamps[String(d)]?.note ?? "" })).filter((n) => n.note);
  const photoSet = new Set(photoDays);

  /** Open a day. From the notes list (far below the card) focus moves to the panel; from the grid it only scrolls. */
  function selectDay(day: number, moveFocus = false) {
    setSelected(day);
    requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      if (moveFocus) panel.focus();
      else panel.scrollIntoView?.({ block: "nearest" });
    });
  }

  function onDelete() {
    const r = deleteChallenge(c.id);
    setConfirmDelete(false);
    if (!r.ok) {
      toast(r.message, { tone: "error" });
      return;
    }
    void deleteChallengePhotos(c.id).catch(() => undefined);
    toast("削除しました");
    navigate("/", { replace: true });
  }

  return (
    <section className="cp" aria-labelledby="cp-title">
      <Link to="/" className="backlink cp-back">
        <ChevronLeftIcon />
        きょう
      </Link>

      <header className="cp-head">
        <Seal char={c.seal} size="xl" label={`印「${c.seal}」`} />
        <div className="cp-headtext">
          <h1 className="cp-h1" id="cp-title">
            {c.title}
          </h1>
          <p className="cp-meta">
            <span>{jpPeriod(c.startDate)}</span>
            {v.phase === "active" && <span className="cp-tag cp-tag-day">{v.day}日目</span>}
            {v.phase === "waiting" && <span className="cp-tag">予約中・あと{v.daysUntilStart}日</span>}
            {v.phase === "ended" && <span className="cp-tag">30日が終わりました</span>}
            {v.firstOfMonth && <span className="cp-tag cp-tag-first">1日組</span>}
            {c.verdict && <VerdictBadge verdict={c.verdict} />}
          </p>
        </div>
        <p className="cp-count">
          <b>{v.stampCount}</b>
          <small>/30</small>
          <span className="sr-only">日 押した</span>
        </p>
      </header>

      <div className="cp-tools">
        {c.status !== "done" && (
          <button type="button" className="btn sm" onClick={() => setEditing(true)}>
            <EditIcon />
            編集
          </button>
        )}
        {v.phase === "ended" && (
          <Link to={`/c/${c.id}/reflect`} className="btn sm primary">
            振り返る
          </Link>
        )}
        {v.phase === "active" && v.day >= EARLY_REFLECT_FROM_DAY && (
          <Link to={`/c/${c.id}/reflect`} className="btn sm">
            ここで区切る
          </Link>
        )}
        {c.status === "done" && (
          <Link to={`/c/${c.id}/reflect`} className="btn sm primary">
            シェア用カード
          </Link>
        )}
      </div>

      <div className="cp-card">
        <Grid30
          seal={c.seal}
          stampedDays={v.stampedDays}
          today={gridToday}
          locked={v.phase !== "active"}
          selectedDay={selected}
          onCellClick={v.phase === "waiting" ? undefined : (day) => selectDay(day)}
          label={`「${c.title}」の30日カード（日付を選ぶとメモと写真）`}
          className="cp-grid"
        />
        {v.phase === "waiting" ? (
          <p className="cp-hint">{jpDate(c.startDate)}に始まります。始まったら、ここに毎日の印が並びます。</p>
        ) : selected === null ? (
          <p className="cp-hint">日付を選ぶと、その日のひとことや写真を残せます。押し忘れた日もここで押せます。</p>
        ) : (
          <DayPanel
            ref={panelRef}
            key={selected}
            c={c}
            v={v}
            day={selected}
            hasPhoto={photoSet.has(selected)}
            onPhotosChanged={() => setPhotoVersion((n) => n + 1)}
          />
        )}
      </div>

      {c.status === "done" && (
        <section className="cp-section" aria-labelledby="cp-refl-h">
          <h2 className="cp-h2" id="cp-refl-h">
            振り返り
          </h2>
          <div className="cp-reflection">
            {c.verdict && <VerdictBadge verdict={c.verdict} size="lg" />}
            {c.reflection ? <p className="cp-quote">「{c.reflection}」</p> : <p className="note">ひとことはありません。</p>}
            <p className="note">{c.finishedDay ? `${c.finishedDay}日目で区切りました。` : ""}</p>
            <Link to={`/c/${c.id}/reflect`} className="btn primary">
              シェア用カードを見る
            </Link>
          </div>
        </section>
      )}

      {notes.length > 0 && (
        <section className="cp-section" aria-labelledby="cp-notes-h">
          <h2 className="cp-h2" id="cp-notes-h">
            メモ
          </h2>
          <ol className="cp-notes">
            {notes.map((n) => (
              <li key={n.day}>
                <button type="button" className="cp-note" onClick={() => selectDay(n.day, true)}>
                  <b>{n.day}日目</b>
                  <span>{n.note}</span>
                  {photoSet.has(n.day) && <span className="cp-tag">写真</span>}
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}

      {(v.phase === "active" || v.phase === "waiting") && <ReminderBlock c={c} today={today} />}

      <section className="cp-section cp-danger" aria-labelledby="cp-del-h">
        <h2 className="cp-h2" id="cp-del-h">
          削除
        </h2>
        <p className="note">印・ひとこと・この端末の写真がすべて消えます。元に戻せません。</p>
        <button type="button" className="btn danger" onClick={() => setConfirmDelete(true)}>
          <TrashIcon />
          このチャレンジを削除
        </button>
      </section>

      <EditSheet open={editing} onClose={() => setEditing(false)} c={c} today={today} v={v} />
      <ConfirmDialog
        open={confirmDelete}
        title="このチャレンジを削除しますか？"
        message={`「${c.title}」の印・ひとこと・写真がすべて消えます。元に戻せません。`}
        confirmLabel="削除する"
        danger
        onConfirm={onDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </section>
  );
}

// ---------- one day ----------

type DayPanelProps = {
  ref: Ref<HTMLElement>;
  c: Challenge;
  v: ChallengeView;
  day: number;
  hasPhoto: boolean;
  onPhotosChanged: () => void;
};

function DayPanel({ ref, c, v, day, hasPhoto, onPhotosChanged }: DayPanelProps) {
  const { stamp, unstamp, setNote } = useAppActions();
  const toast = useToast();
  const headId = useId();
  const stampData = c.stamps[String(day)];
  const stamped = Boolean(stampData);
  const note = stampData?.note ?? "";
  const done = c.status === "done";
  const canStamp = (v.phase === "active" || v.phase === "ended") && day <= v.maxDay;
  const [draft, setDraft] = useState(note);
  const [shown, setShown] = useState(note);
  const [saved, setSaved] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  if (note !== shown) {
    setShown(note);
    setDraft(note);
  }

  function saveNote() {
    if (draft === note) return;
    const r = setNote(c.id, day, draft);
    if (!r.ok) toast(r.message, { tone: "error" });
    else setSaved(true);
  }

  function toggle(confirmed = false) {
    if (stamped) {
      if (note && !confirmed) {
        setConfirmUndo(true);
        return;
      }
      const r = unstamp(c.id, day);
      if (!r.ok) toast(r.message, { tone: "error" });
    } else {
      const r = stamp(c.id, day);
      if (!r.ok) toast(r.message, { tone: "error" });
      else toast(`${day}日目の印を押しました`);
    }
  }

  return (
    <section className="cp-day" ref={ref} tabIndex={-1} aria-labelledby={headId}>
      <div className="cp-day-head">
        <h2 className="cp-day-h" id={headId}>
          {day}日目
          <span>{jpDate(addDays(c.startDate, day - 1))}</span>
        </h2>
        <span className={stamped ? "cp-tag cp-tag-on" : "cp-tag"}>{stamped ? "押した" : "まだ"}</span>
      </div>

      {stamped && !done && (
        <div className="cp-day-note">
          <TextAreaField
            label="この日のひとこと（自分だけに見えます）"
            value={draft}
            onChange={(value) => {
              setDraft(value);
              setSaved(false);
            }}
            onBlur={saveNote}
            max={LIMITS.note}
            rows={2}
            placeholder="例：駅まで遠回りした"
          />
          <div className="cp-day-save">
            <span className="note" role="status" aria-live="polite">
              {saved ? "保存しました" : ""}
            </span>
            {draft !== note && (
              <button type="button" className="btn sm" onClick={saveNote}>
                保存
              </button>
            )}
          </div>
        </div>
      )}
      {stamped && done && (note ? <p className="cp-quote-sm">{note}</p> : <p className="note">ひとことはありません。</p>)}
      {!stamped && !done && canStamp && <p className="note">印を押すと、ひとことを残せます。</p>}

      <DayPhoto challengeId={c.id} day={day} hasPhoto={hasPhoto} onChange={onPhotosChanged} />

      {canStamp && (
        <button type="button" className={stamped ? "btn sm ghost" : "btn sm primary"} onClick={() => toggle()}>
          {stamped ? "この日の印を取り消す" : "この日の印を押す"}
        </button>
      )}
      {done && <p className="note">振り返りを終えたので、印はこのまま残ります。</p>}

      <ConfirmDialog
        open={confirmUndo}
        title={`${day}日目の印を取り消しますか？`}
        message={`この日のひとこと「${note}」も消えます。`}
        confirmLabel="取り消す"
        cancelLabel="そのままにする"
        danger
        onConfirm={() => {
          setConfirmUndo(false);
          toggle(true);
        }}
        onCancel={() => setConfirmUndo(false)}
      />
    </section>
  );
}

type PhotoState = { key: string; url: string | null };

function coarsePointer(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

/** The day's photo: stored only on this device, re-encoded without location data. */
function DayPhoto({ challengeId, day, hasPhoto, onChange }: { challengeId: string; day: number; hasPhoto: boolean; onChange: () => void }) {
  const [version, setVersion] = useState(0);
  const [photo, setPhoto] = useState<PhotoState | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<"saving" | "removing" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [touch] = useState(coarsePointer);
  const key = `${challengeId}:${day}:${version}:${hasPhoto ? 1 : 0}`;

  useEffect(() => {
    let cancelled = false;
    canStorePhotos().then((ok) => {
      if (!cancelled) setAvailable(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    getPhotoUrl(challengeId, day).then((url) => {
      if (cancelled) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      made = url;
      setPhoto({ key, url });
    });
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [challengeId, day, key]);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy("saving");
    setError(null);
    try {
      await savePhoto(challengeId, day, file);
      setVersion((n) => n + 1);
      onChange();
    } catch (err) {
      setError(photoErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function onRemove() {
    setBusy("removing");
    setError(null);
    try {
      await deletePhoto(challengeId, day);
      setVersion((n) => n + 1);
      onChange();
    } catch (err) {
      setError(photoErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const current = photo?.key === key ? photo : null;
  const url = current?.url ?? null;

  return (
    <div className="cp-photo">
      <p className="cp-photo-h">写真</p>
      {url ? (
        <img className="cp-photo-img" src={url} alt={`${day}日目の写真`} />
      ) : current === null && hasPhoto ? (
        <Loading inline label="写真を読み込んでいます…" />
      ) : null}
      {available === false ? (
        <p className="note err">この端末では写真を保存できません。</p>
      ) : (
        <div className="cp-photo-btns">
          {touch && (
            <label className={`btn sm cp-file${busy ? " is-disabled" : ""}`}>
              <CameraIcon />
              {url ? "撮り直す" : "写真を撮る"}
              <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => void onFile(e)} disabled={busy !== null} />
            </label>
          )}
          <label className={`btn sm cp-file${busy ? " is-disabled" : ""}`}>
            {!touch && <CameraIcon />}
            {url ? "別の写真にする" : "写真を選ぶ"}
            <input type="file" accept="image/*" className="sr-only" onChange={(e) => void onFile(e)} disabled={busy !== null} />
          </label>
          {url && (
            <button type="button" className="linkbtn danger" onClick={() => void onRemove()} disabled={busy !== null}>
              写真を外す
            </button>
          )}
        </div>
      )}
      {busy === "saving" && <Loading inline label="写真を縮小して保存しています…" />}
      {error && (
        <p className="note err" role="alert">
          {error}
        </p>
      )}
      <p className="note">写真はこの端末だけに保存され、送信されません。位置情報などは取り除いてから保存します。</p>
    </div>
  );
}

// ---------- reminders ----------

function ReminderBlock({ c, today }: { c: Challenge; today: string }) {
  const { user, tz } = useApp();
  const sched = reminderSchedule(c, today);
  if (!sched) return null;
  const time = user?.reminder?.time ?? "21:00";
  const origin = typeof location !== "undefined" ? location.origin : "";
  const ev: ReminderEvent = { title: c.title, startDate: sched.startDate, count: sched.count, time, url: `${origin}/c/${c.id}`, uid: c.id };
  return (
    <section className="cp-section" id="reminder" aria-labelledby="cp-rem-h">
      <h2 className="cp-h2" id="cp-rem-h">
        毎日のリマインド
      </h2>
      <p className="cp-rem-status">
        {user?.reminder?.enabled ? `通知：毎日 ${time} に、まだ押していなければお知らせします。` : "通知はオフになっています。"}
        <Link to="/settings#reminder">通知の設定</Link>
      </p>
      <p className="note">
        カレンダーに毎日の予定を入れることもできます（{jpDate(sched.startDate)}から毎日 {time}・{sched.count}日分）。
      </p>
      <div className="cp-cal">
        <a className="btn" href={googleCalendarUrl(ev, tz)} target="_blank" rel="noopener noreferrer">
          <CalendarIcon />
          Googleカレンダーに入れる<span className="sr-only">（新しいタブで開きます）</span>
        </a>
        <button type="button" className="btn" onClick={() => downloadIcs(ev)}>
          <DownloadIcon />
          .ics をダウンロード
        </button>
      </div>
      <p className="note">時刻は「設定」のリマインドの時刻を使います。iPhone のカレンダーなどには .ics を開いて追加できます。</p>
    </section>
  );
}

// ---------- edit ----------

function EditSheet({ open, onClose, c, today, v }: { open: boolean; onClose: () => void; c: Challenge; today: string; v: ChallengeView }) {
  return (
    <Sheet open={open} onClose={onClose} title="チャレンジを編集">
      <EditForm onClose={onClose} c={c} today={today} v={v} />
    </Sheet>
  );
}

function EditForm({ onClose, c, today, v }: { onClose: () => void; c: Challenge; today: string; v: ChallengeView }) {
  const { updateChallenge } = useAppActions();
  const toast = useToast();
  const uid = useId();
  const nf = nextFirst(today);
  const [title, setTitle] = useState(c.title);
  const [seal, setSeal] = useState(c.seal);
  const [startDate, setStartDate] = useState(c.startDate);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const fallback = firstGrapheme(title.trim());

  function submit(e: FormEvent) {
    e.preventDefault();
    const patch: { title?: string; seal?: string; startDate?: string } = {};
    if (title !== c.title) patch.title = title;
    const sealValue = seal.trim() || fallback;
    if (sealValue !== c.seal) patch.seal = sealValue;
    if (v.phase === "waiting" && startDate !== c.startDate) patch.startDate = startDate;
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    const r = updateChallenge(c.id, patch);
    if (!r.ok) {
      setErrors(r.fields);
      setFormError(r.fields.title || r.fields.seal || r.fields.startDate ? null : r.message);
      return;
    }
    toast("保存しました");
    onClose();
  }

  return (
    <form className="st-form" onSubmit={submit} noValidate>
      <TextField label="チャレンジ名" value={title} onChange={setTitle} max={LIMITS.challengeTitle} error={errors.title} autoComplete="off" />
      <SealField value={seal} onChange={setSeal} fallback={fallback} error={errors.seal} />
      {v.phase === "waiting" && (
        <fieldset className="st-when">
          <legend>いつから</legend>
          <label className="st-radio">
            <input type="radio" name={`${uid}-when`} checked={startDate === today} onChange={() => setStartDate(today)} />
            <span>
              <b>今日から</b>
              <small>{jpPeriod(today)}</small>
            </span>
          </label>
          <label className="st-radio">
            <input type="radio" name={`${uid}-when`} checked={startDate === nf} onChange={() => setStartDate(nf)} />
            <span>
              <b>{jpDate(nf)}から（1日組）</b>
              <small>同じ日に始める仲間と並びます · {jpPeriod(nf)}</small>
            </span>
          </label>
          {errors.startDate && <span className="field-err">{errors.startDate}</span>}
        </fieldset>
      )}
      {formError && (
        <p className="st-error" role="alert">
          {formError}
        </p>
      )}
      <button type="submit" className="btn primary lg st-submit">
        保存する
      </button>
    </form>
  );
}
