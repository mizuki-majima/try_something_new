/**
 * /together — みんなの30日 (SPEC FR-8, FR-9, CUF-3). Tabs: 今月の組 / 次の1日組 / 先月の組.
 * A month tab lists GET /api/cohorts/:month (nickname, seal, title, stamped days, cheers);
 * "応援" is optimistic (+1, once a day). 次の1日組 shows GET /api/cohorts/upcoming.
 * 「詳しく見る」 opens one member's details in a sheet, from the same public data; only when the member
 * shows day notes (shownNoteCount, #17) does it fetch them, on every open (GET /api/members/:id/notes).
 * Public: nickname, seal, title, stamped days, and the day notes their owner chose to show. The list
 * itself never carries note text, and notes nobody chose to show are never sent at all.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import {
  API,
  LIMITS,
  TOTAL_DAYS,
  VERDICTS,
  addDays,
  containsUrl,
  dayIndex,
  diffDays,
  graphemeLength,
  isFirstOfMonth,
  jpDate,
  jpPeriod,
  monthKey,
  nextFirst,
  type CheerResponse,
  type CohortMember,
  type CohortResponse,
  type MemberNote,
  type MemberNotesResponse,
  type UpcomingResponse,
} from "@thirty/shared";
import { Grid30 } from "../components/Grid30";
import { HeartIcon } from "../components/Icons";
import { MemberNoteList } from "../components/MemberNotes";
import { MiniGrid30 } from "../components/MiniGrid30";
import { ReportButton } from "../components/ReportButton";
import { Seal } from "../components/Seal";
import { Sheet } from "../components/Sheet";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { useToast } from "../components/Toast";
import { StartChallengeSheet, type StartChallengeSheetProps } from "../features/start/StartChallengeSheet";
import { ApiClientError, errorMessage, request } from "../lib/api";
import { jpMonth } from "../lib/format";
import { usePageTitle } from "../lib/hooks";
import { useToday, useUser } from "../lib/store";
import "./TogetherPage.css";

type TabId = "now" | "next" | "prev";
const TAB_IDS: readonly TabId[] = ["now", "next", "prev"];
const isTab = (v: unknown): v is TabId => typeof v === "string" && (TAB_IDS as readonly string[]).includes(v);

type StartTarget = Pick<StartChallengeSheetProps, "recipe" | "preset">;

/** The cohort months around `today`: this month, the month before, and the next 1st. */
export function cohortMonths(today: string): { now: string; prev: string; nextFirst: string } {
  const now = monthKey(today);
  return { now, prev: monthKey(addDays(`${now}-01`, -1)), nextFirst: nextFirst(today) };
}

/** Yours first, then the most recently active. */
export function sortMembers(list: readonly CohortMember[]): CohortMember[] {
  return [...list].sort((a, b) => Number(b.isMine) - Number(a.isMine) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function isMemberLike(m: unknown): m is CohortMember {
  const o = m as CohortMember | null;
  return !!o && typeof o === "object" && typeof o.challengeId === "string" && typeof o.title === "string" && Array.isArray(o.stampDays);
}

/** The longest run of consecutive stamped days (1–30). */
export function longestStreak(stampDays: readonly number[]): number {
  const days = [...new Set(stampDays.filter((d) => Number.isInteger(d) && d >= 1 && d <= TOTAL_DAYS))].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  let prev = -1;
  for (const d of days) {
    run = d === prev + 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

/**
 * Where a member's 30 days stand today, in words (the detail sheet). `done` can mean the owner closed
 * early (「ここで区切る」, from day 7) and the public data has no finishedDay, so it never claims 30 days.
 */
export function memberStatus(m: Pick<CohortMember, "startDate" | "done" | "verdict">, today: string): string {
  const day = dayIndex(m.startDate, today);
  if (m.done) {
    const verdict = m.verdict && m.verdict in VERDICTS ? VERDICTS[m.verdict].label : null;
    // day is the viewer's, which can be a day off the owner's (time zones): only say 「途中で」 when it is sure.
    const ended = day <= TOTAL_DAYS - 2 ? "途中で区切りました" : "振り返りを終えました";
    return verdict ? `${ended}（「${verdict}」）` : ended;
  }
  if (day < 1) return `${jpDate(m.startDate)}から始まります`;
  if (day > TOTAL_DAYS) return "振り返り待ち";
  return `${day}日目`;
}

// ---------- data ----------

type Loaded<T> = { key: string; data?: T; error?: string };

/** GET once per key; `reload` refetches. `loading` is derived (no setState inside the effect). */
function useRemote<T>(path: string, parse: (raw: unknown) => T) {
  const [version, setVersion] = useState(0);
  const [entry, setEntry] = useState<Loaded<T> | null>(null);
  const key = `${path}#${version}`;
  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    request<unknown>("GET", path, { signal: ctrl.signal }).then(
      (raw) => {
        if (alive) setEntry({ key, data: parse(raw) });
      },
      (err: unknown) => {
        if (alive) setEntry({ key, error: errorMessage(err) });
      },
    );
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [path, key, parse]);
  const current = entry?.key === key ? entry : null;
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const update = useCallback((fn: (data: T) => T) => setEntry((e) => (e?.data !== undefined ? { ...e, data: fn(e.data) } : e)), []);
  return { data: current?.data, error: current?.error ?? null, loading: current === null, reload, update };
}

const isDayCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= TOTAL_DAYS;

/** shownNoteCount (#17) is kept only as a count of days (1–30); anything else means no notes are shown. */
function withNoteCount(m: CohortMember): CohortMember {
  const { shownNoteCount, ...rest } = m;
  return isDayCount(shownNoteCount) ? { ...rest, shownNoteCount } : rest;
}

const parseCohort = (raw: unknown): CohortMember[] => {
  const members = (raw as CohortResponse | null)?.members;
  return sortMembers(Array.isArray(members) ? members.filter(isMemberLike).map(withNoteCount) : []);
};

/**
 * GET /api/members/:id/notes, cleaned before anything is drawn: notes of this challenge only, on a day
 * the card shows as stamped, 1–LIMITS.note characters without a URL (the public-text rules), one per
 * day, by day. Anything else is left out, and a response of another shape is no notes at all.
 */
export function parseMemberNotes(raw: unknown, challengeId: string, stampDays: readonly number[]): MemberNote[] {
  const r = raw as Partial<MemberNotesResponse> | null;
  if (!r || typeof r !== "object" || r.challengeId !== challengeId || !Array.isArray(r.notes)) return [];
  const stamped = new Set(stampDays);
  const byDay = new Map<number, string>();
  for (const item of r.notes as unknown[]) {
    const { day, note } = (item && typeof item === "object" ? item : {}) as Partial<MemberNote>;
    if (!isDayCount(day) || !stamped.has(day) || byDay.has(day)) continue;
    if (typeof note !== "string" || containsUrl(note)) continue;
    const n = graphemeLength(note);
    if (n >= 1 && n <= LIMITS.note) byDay.set(day, note);
  }
  return [...byDay].sort(([a], [b]) => a - b).map(([day, note]) => ({ day, note }));
}

/** The API's own answer that this challenge shows no note (well formed and empty, not a list left out). */
export function answeredNoNotes(raw: unknown, challengeId: string): boolean {
  const r = raw as Partial<MemberNotesResponse> | null;
  return !!r && typeof r === "object" && r.challengeId === challengeId && Array.isArray(r.notes) && r.notes.length === 0;
}

/** count / byRecipe count reservations (one person may have several); peopleCount, when the API sends it, counts people. */
const parseUpcoming = (raw: unknown): UpcomingResponse | null => {
  const r = raw as UpcomingResponse | null;
  if (!r || typeof r.startDate !== "string") return null;
  return {
    startDate: r.startDate,
    count: typeof r.count === "number" && r.count > 0 ? Math.floor(r.count) : 0,
    ...(typeof r.peopleCount === "number" && r.peopleCount >= 0 ? { peopleCount: Math.floor(r.peopleCount) } : {}),
    byRecipe: Array.isArray(r.byRecipe) ? r.byRecipe.filter((b) => b && typeof b.title === "string" && typeof b.count === "number") : [],
  };
};

/** 「N人が待っています」 when the API counted people, else the number of reservations. */
export function upcomingWaiting(data: UpcomingResponse): string | null {
  if (data.count <= 0) return null;
  return data.peopleCount !== undefined && data.peopleCount > 0 ? `${data.peopleCount}人が待っています` : `${data.count}件の予約があります`;
}

// ---------- page ----------

export default function TogetherPage() {
  usePageTitle("みんな");
  const today = useToday();
  const user = useUser();
  const months = useMemo(() => cohortMonths(today), [today]);
  const [params, setParams] = useSearchParams();
  const tabParam = params.get("tab");
  const tab: TabId = isTab(tabParam) ? tabParam : "now";
  const [start, setStart] = useState<StartTarget | null>(null);
  const tabRefs = useRef<Record<TabId, HTMLButtonElement | null>>({ now: null, next: null, prev: null });
  const year = Number(today.slice(0, 4));

  const tabs: { id: TabId; label: string; sub: string }[] = [
    { id: "now", label: "今月の組", sub: jpMonth(months.now, year) },
    { id: "next", label: "次の1日組", sub: jpDate(months.nextFirst) },
    { id: "prev", label: "先月の組", sub: jpMonth(months.prev, year) },
  ];

  function select(id: TabId, focus = false) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id === "now") next.delete("tab");
        else next.set("tab", id);
        return next;
      },
      { replace: true },
    );
    if (focus) tabRefs.current[id]?.focus();
  }

  function onTabKey(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const n = TAB_IDS.length;
    const target =
      e.key === "ArrowRight" ? (index + 1) % n : e.key === "ArrowLeft" ? (index - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (target < 0) return;
    e.preventDefault();
    select(TAB_IDS[target]!, true);
  }

  return (
    <section className="stack tg-page" aria-labelledby="tg-title">
      <h1 className="h2" id="tg-title">
        みんなの30日
      </h1>
      <p className="note">
        同じ月に始めた人が、ここに並びます。1日に始めた人は「1日組」。応援は1日1回、数だけが届きます。
      </p>

      <div className="tg-privacy">
        <p>
          一覧に出るのは、<b>ニックネーム・印・タイトル・押した日・判定・応援の数</b>と、本人が「みんなに見せる」を選んだひとことの数。そのひとことは「詳しく見る」で読めます。ほかのひとことと写真は表示されません。
        </p>
        {user && !user.shareProgress ? (
          <p>
            あなたの進捗は、いま非公開です。<Link to="/settings#profile">設定で公開する</Link>
          </p>
        ) : (
          <Link to="/settings#profile">表示をOFFにする</Link>
        )}
      </div>

      <div role="tablist" aria-label="1日組" className="tg-tabs">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`tg-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`tg-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className="tg-tab"
            onClick={() => select(t.id)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            <span>{t.label}</span>
            <small>{t.sub}</small>
          </button>
        ))}
      </div>

      {TAB_IDS.map((id) => (
        <div key={id} role="tabpanel" id={`tg-panel-${id}`} aria-labelledby={`tg-tab-${id}`} hidden={tab !== id} tabIndex={0} className="tg-panel">
          {tab === id &&
            (id === "next" ? (
              <UpcomingPanel today={today} onStart={setStart} />
            ) : (
              <MonthPanel key={id === "now" ? months.now : months.prev} month={id === "now" ? months.now : months.prev} current={id === "now"} today={today} />
            ))}
        </div>
      ))}

      {start && <StartChallengeSheet open onClose={() => setStart(null)} recipe={start.recipe ?? null} preset={start.preset ?? null} />}
    </section>
  );
}

// ---------- month ----------

function MonthPanel({ month, current, today }: { month: string; current: boolean; today: string }) {
  const toast = useToast();
  const { data: members, error, loading, reload, update } = useRemote(API.cohort(month), parseCohort);
  const [sending, setSending] = useState<ReadonlySet<string>>(() => new Set());
  const [detailId, setDetailId] = useState<string | null>(null);

  async function cheer(m: CohortMember) {
    if (m.isMine || m.cheeredToday || sending.has(m.challengeId)) return;
    const id = m.challengeId;
    setSending((s) => new Set(s).add(id));
    const patch = (fn: (x: CohortMember) => CohortMember) => update((list) => list.map((x) => (x.challengeId === id ? fn(x) : x)));
    patch((x) => ({ ...x, cheers: x.cheers + 1, cheeredToday: true }));
    try {
      const res = await request<CheerResponse>("POST", API.cheer(id), { auth: "required" });
      if (typeof res?.cheers === "number") patch((x) => ({ ...x, cheers: res.cheers, cheeredToday: true }));
      toast(`${m.nickname}さんを応援しました`);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 409) {
        patch((x) => ({ ...x, cheers: Math.max(0, x.cheers - 1), cheeredToday: true }));
        toast("今日はもう応援しました");
      } else {
        patch((x) => ({ ...x, cheers: Math.max(0, x.cheers - 1), cheeredToday: false }));
        toast(errorMessage(err), { tone: "error" });
      }
    } finally {
      setSending((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  // Read from the list so a cheer in the sheet shows on the card too.
  const detail = detailId ? members?.find((m) => m.challengeId === detailId) ?? null : null;

  if (loading) return <Loading label="みんなの30日を読み込んでいます…" />;
  if (error || !members) return <ErrorState message={error ?? "もう一度お試しください。"} onRetry={reload} />;
  if (members.length === 0) {
    return current ? (
      <EmptyState
        seal="初"
        title="まだ誰もいません。最初の1人になりませんか？"
        action={
          <Link to="/recipes" className="btn primary">
            レシピから選ぶ
          </Link>
        }
      >
        今月始めたチャレンジは、ここに並びます。
      </EmptyState>
    ) : (
      <EmptyState seal="無" title="この月に始めた人はいません" />
    );
  }

  return (
    <>
      {/* One person may have several challenges in a month: count challenges, not people. */}
      <p className="note tg-count">{members.length}件のチャレンジ</p>
      <ul className="people tg-people">
        {members.map((m) => (
          <MemberCard
            key={m.challengeId}
            member={m}
            today={today}
            busy={sending.has(m.challengeId)}
            onCheer={() => void cheer(m)}
            onOpen={() => setDetailId(m.challengeId)}
          />
        ))}
      </ul>
      {detail && (
        <MemberDetailSheet
          member={detail}
          today={today}
          busy={sending.has(detail.challengeId)}
          onCheer={() => void cheer(detail)}
          onClose={() => setDetailId(null)}
        />
      )}
    </>
  );
}

function MemberCard({
  member: m,
  today,
  busy,
  onCheer,
  onOpen,
}: {
  member: CohortMember;
  today: string;
  busy: boolean;
  onCheer: () => void;
  onOpen: () => void;
}) {
  const day = dayIndex(m.startDate, today);
  const running = !m.done && day >= 1 && day <= TOTAL_DAYS;
  const stamped = new Set(m.stampDays.filter((d) => Number.isInteger(d) && d >= 1 && d <= TOTAL_DAYS)).size;
  const verdict = m.done && m.verdict && m.verdict in VERDICTS ? m.verdict : null;
  const nickname = m.nickname || "名無し";
  const disabled = m.isMine || m.cheeredToday || busy;
  const notes = m.shownNoteCount ?? 0;
  return (
    <li className={m.isMine ? "person me tg-member" : "person tg-member"} data-testid="member">
      <Seal char={m.seal} size="lg" />
      <div className="tg-member-body">
        <div className="ptop">
          <div className="tg-member-text">
            <div className="who">
              {nickname}
              {m.isMine && <span className="tg-you">あなた</span>}
            </div>
            <div className="t">{m.title}</div>
          </div>
          {/* The mini grid below names the count for screen readers. */}
          <div className="cnt" aria-hidden="true">
            {stamped}
            <small>/{TOTAL_DAYS}</small>
          </div>
        </div>
        <MiniGrid30 stampDays={m.stampDays} today={running ? day : null} />
        <div className="row gap fw tg-tags">
          {isFirstOfMonth(m.startDate) ? <span className="tg-first">1日組</span> : <span className="pill">{jpDate(m.startDate)}から</span>}
          {running && m.stampDays.includes(day) && <span className="pill today">きょう済</span>}
          {!m.done && day > TOTAL_DAYS && <span className="pill">振り返り待ち</span>}
          {verdict && <span className={`badge ${verdict}`}>{VERDICTS[verdict].label}</span>}
          {/* How many, never the text: that is read in 「詳しく見る」. */}
          {notes > 0 && (
            <span className="pill tg-notes-pill" data-testid="notes-pill">
              <span aria-hidden="true">ひとこと {notes}</span>
              <span className="sr-only">（本人が見せているひとこと {notes}件）</span>
            </span>
          )}
        </div>
        <div className="row between gap fw tg-actions">
          <button
            type="button"
            className={m.cheeredToday ? "btn sm tg-cheer done" : "btn sm tg-cheer"}
            disabled={disabled}
            aria-busy={busy || undefined}
            onClick={onCheer}
            data-testid="cheer"
          >
            <HeartIcon />
            <span className="sr-only">{m.isMine ? "あなたへの" : `${nickname}さんを`}</span>
            {m.cheeredToday ? "応援済み" : "応援"}
            <span className="tg-cheer-n">{m.cheers}</span>
          </button>
          <div className="row gap tg-actions-end">
            <button type="button" className="btn sm ghost tg-open" onClick={onOpen} data-testid="member-open">
              詳しく見る<span className="sr-only">（{nickname}さん）</span>
            </button>
            {!m.isMine && <ReportButton targetType="member" targetId={m.challengeId} subject={`${nickname}さんの表示`} />}
          </div>
        </div>
      </div>
    </li>
  );
}

/** One member's 30 days in full: the same public data as the card, larger, plus the period and streak. */
function MemberDetailSheet({
  member: m,
  today,
  busy,
  onCheer,
  onClose,
}: {
  member: CohortMember;
  today: string;
  busy: boolean;
  onCheer: () => void;
  onClose: () => void;
}) {
  const nickname = m.nickname || "名無し";
  const day = dayIndex(m.startDate, today);
  const stamped = new Set(m.stampDays.filter((d) => Number.isInteger(d) && d >= 1 && d <= TOTAL_DAYS));
  const verdict = m.done && m.verdict && m.verdict in VERDICTS ? m.verdict : null;
  // A closed challenge may have ended early and the day it ended is not public: days after the last
  // stamp are drawn as "not yet", never as missed. A stamped day is never drawn as future (the viewer's
  // day can be one behind the owner's).
  const lastStamped = Math.max(0, ...stamped);
  const gridDay = m.done ? lastStamped : Math.min(Math.max(day, lastStamped, 0), TOTAL_DAYS);
  const locked = m.done || day < 1 || day > TOTAL_DAYS;
  const disabled = m.isMine || m.cheeredToday || busy;
  const who = m.isMine ? "あなた" : `${nickname}さん`;
  return (
    <Sheet open onClose={onClose} title={`${who}の30日`}>
      <div className="tg-detail" data-testid="member-detail">
        <div className="tg-detail-head">
          <Seal char={m.seal} size="lg" />
          <div className="tg-member-text">
            <div className="t tg-detail-title">{m.title}</div>
            <div className="row gap fw tg-tags">
              {isFirstOfMonth(m.startDate) ? <span className="tg-first">1日組</span> : <span className="pill">{jpDate(m.startDate)}から</span>}
              {m.isMine && <span className="tg-you">あなた</span>}
              {verdict && <span className={`badge ${verdict}`}>{VERDICTS[verdict].label}</span>}
            </div>
          </div>
        </div>
        <dl className="tg-detail-stats">
          <div>
            <dt>期間</dt>
            <dd>{jpPeriod(m.startDate)}</dd>
          </div>
          <div>
            <dt>いま</dt>
            <dd>{memberStatus(m, today)}</dd>
          </div>
          <div>
            <dt>押した日</dt>
            <dd>
              {stamped.size}
              <small>/{TOTAL_DAYS}日</small>
            </dd>
          </div>
          <div>
            <dt>いちばん長い連続</dt>
            <dd>
              {longestStreak(m.stampDays)}
              <small>日</small>
            </dd>
          </div>
        </dl>
        <Grid30 seal={m.seal} stampedDays={stamped} today={gridDay} locked={locked} label={`${who}の30日のカード`} readOnly />
        {m.done && gridDay < TOTAL_DAYS && (
          <p className="note">{lastStamped > 0 ? "最後に押した日より後は、斜線で表示しています。" : "押した日がないので、すべて斜線で表示しています。"}</p>
        )}
        <div className="row between gap fw tg-actions">
          {/* aria-disabled, not disabled: focus stays on the button after cheering (inside the dialog). */}
          <button
            type="button"
            className={m.cheeredToday ? "btn sm tg-cheer done" : "btn sm tg-cheer"}
            aria-disabled={disabled || undefined}
            aria-busy={busy || undefined}
            onClick={disabled ? undefined : onCheer}
          >
            <HeartIcon />
            <span className="sr-only">{m.isMine ? "あなたへの" : `${nickname}さんを`}</span>
            {m.cheeredToday ? "応援済み" : "応援"}
            <span className="tg-cheer-n">{m.cheers}</span>
          </button>
          {m.isMine ? (
            <Link to={`/c/${m.challengeId}`} className="btn sm ghost tg-open" onClick={onClose}>
              自分の記録を開く
            </Link>
          ) : (
            <ReportButton targetType="member" targetId={m.challengeId} subject={`${nickname}さんの表示`} />
          )}
        </div>
        <MemberNotesSection member={m} />
        <p className="note">ひとことは、本人が「みんなに見せる」を選んだものだけ表示しています。写真は本人だけが見られます。</p>
      </div>
    </Sheet>
  );
}

type NotesEntry = { key: string; raw?: unknown; error?: string; gone?: boolean };

/**
 * The member's shown notes, fetched each time the sheet opens and never cached, so turning one back to
 * 「自分だけ」 (or progress off, a moderator's hide) applies to the very next look. A 404 means the
 * member is not listed any more: nothing to show, not an error.
 */
function useMemberNotes(challengeId: string, enabled: boolean) {
  const [attempt, setAttempt] = useState(0);
  const [entry, setEntry] = useState<NotesEntry | null>(null);
  const key = `${challengeId}#${attempt}`;
  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    let alive = true;
    request<unknown>("GET", API.memberNotes(challengeId), { signal: ctrl.signal, auth: "none" }).then(
      (raw) => {
        if (alive) setEntry({ key, raw });
      },
      (err: unknown) => {
        if (!alive) return;
        setEntry(err instanceof ApiClientError && err.status === 404 ? { key, gone: true } : { key, error: errorMessage(err) });
      },
    );
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [challengeId, key, enabled]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const current = enabled && entry?.key === key ? entry : null;
  return { current, loading: enabled && current === null, retry };
}

/**
 * 「本人が見せているひとこと」 in the details sheet (#17): plain text, by day. Your own card always asks
 * the API: the list (gsi1, read once per visit) can lag behind a note you just showed, so "nothing
 * shown" is said only when the strongly consistent read answered no notes.
 */
function MemberNotesSection({ member: m }: { member: CohortMember }) {
  const headId = useId();
  const { current, loading, retry } = useMemberNotes(m.challengeId, m.isMine || (m.shownNoteCount ?? 0) > 0);
  const notes = current?.raw !== undefined ? parseMemberNotes(current.raw, m.challengeId, m.stampDays) : [];

  let body: ReactNode = null;
  if (loading) body = <Loading inline label="ひとことを読み込んでいます…" />;
  else if (current?.error) body = <ErrorState title="ひとことを読み込めませんでした。" message={current.error} onRetry={retry} retryLabel="もう一度" />;
  else if (notes.length > 0) body = <MemberNoteList notes={notes} />;
  else if (m.isMine && current?.raw !== undefined && answeredNoNotes(current.raw, m.challengeId)) {
    body = <p className="note">いま「みんな」に見せているひとことはありません。「自分の記録を開く」から日を選ぶと、日ごとに「みんなに見せる」を選べます。</p>;
  }
  if (!body) return null;
  return (
    <section className="tg-notes" aria-labelledby={headId} data-testid="member-notes">
      <h3 className="tg-notes-h" id={headId}>
        本人が見せているひとこと
      </h3>
      {body}
    </section>
  );
}

// ---------- next 1st ----------

function UpcomingPanel({ today, onStart }: { today: string; onStart: (t: StartTarget) => void }) {
  const { data, error, loading, reload } = useRemote(API.cohortUpcoming, parseUpcoming);
  if (loading) return <Loading label="次の1日組を読み込んでいます…" />;
  if (error || !data) return <ErrorState message={error ?? "もう一度お試しください。"} onRetry={reload} />;
  const daysLeft = Math.max(0, diffDays(today, data.startDate));
  const reserve = () => onStart({ preset: { firstOfMonth: true } });

  return (
    <div className="stack">
      <div className="card tg-next">
        <p className="tg-next-date">
          <b>{jpDate(data.startDate)}</b>スタート
        </p>
        <p className="tg-next-meta">
          あと<b>{daysLeft}</b>日・{upcomingWaiting(data) ?? "まだ予約はありません"}
        </p>
        <button type="button" className="btn primary" onClick={reserve}>
          1日組で予約する
        </button>
      </div>
      {data.byRecipe.length === 0 ? (
        <EmptyState seal="初" title="まだ誰もいません。最初の1人になりませんか？">
          {jpDate(data.startDate)}に、同じ日に始める人と並べます。
        </EmptyState>
      ) : (
        <>
          <h2 className="h3">この組で始めるもの</h2>
          <ul className="people tg-upcoming">
            {data.byRecipe.map((b, i) => (
              <li key={`${b.recipeId ?? b.title}-${i}`} className="person tg-upc" data-testid="upcoming">
                <Seal char={b.seal} size="lg" />
                <div className="tg-upc-body">
                  <div className="tg-member-text">
                    <div className="t">{b.title}</div>
                    <div className="who">{b.count}件</div>
                  </div>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() =>
                      onStart(
                        b.recipeId
                          ? { recipe: { id: b.recipeId, title: b.title, seal: b.seal }, preset: { firstOfMonth: true } }
                          : { preset: { title: b.title, seal: b.seal, firstOfMonth: true } },
                      )
                    }
                  >
                    この組で始める<span className="sr-only">：{b.title}</span>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
