/**
 * /together — みんなの30日 (SPEC FR-8, FR-9, CUF-3). Tabs: 今月の組 / 次の1日組 / 先月の組.
 * A month tab lists GET /api/cohorts/:month (nickname, seal, title, stamped days, cheers);
 * "応援" is optimistic (+1, once a day). 次の1日組 shows GET /api/cohorts/upcoming.
 * Only nickname, seal, title and stamped days are public; the daily notes never are.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useSearchParams } from "react-router";
import {
  API,
  TOTAL_DAYS,
  VERDICTS,
  addDays,
  dayIndex,
  diffDays,
  isFirstOfMonth,
  jpDate,
  monthKey,
  nextFirst,
  type CheerResponse,
  type CohortMember,
  type CohortResponse,
  type UpcomingResponse,
} from "@thirty/shared";
import { HeartIcon } from "../components/Icons";
import { MiniGrid30 } from "../components/MiniGrid30";
import { ReportButton } from "../components/ReportButton";
import { Seal } from "../components/Seal";
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

const parseCohort = (raw: unknown): CohortMember[] => {
  const members = (raw as CohortResponse | null)?.members;
  return sortMembers(Array.isArray(members) ? members.filter(isMemberLike) : []);
};

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
          一覧に出るのは、<b>ニックネーム・印・タイトル・押した日</b>だけ。ひとことは表示されません。
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
          <MemberCard key={m.challengeId} member={m} today={today} busy={sending.has(m.challengeId)} onCheer={() => void cheer(m)} />
        ))}
      </ul>
    </>
  );
}

function MemberCard({ member: m, today, busy, onCheer }: { member: CohortMember; today: string; busy: boolean; onCheer: () => void }) {
  const day = dayIndex(m.startDate, today);
  const running = !m.done && day >= 1 && day <= TOTAL_DAYS;
  const stamped = new Set(m.stampDays.filter((d) => Number.isInteger(d) && d >= 1 && d <= TOTAL_DAYS)).size;
  const verdict = m.done && m.verdict && m.verdict in VERDICTS ? m.verdict : null;
  const nickname = m.nickname || "名無し";
  const disabled = m.isMine || m.cheeredToday || busy;
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
        </div>
        <div className="row between gap tg-actions">
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
          {!m.isMine && <ReportButton targetType="member" targetId={m.challengeId} subject={`${nickname}さんの表示`} />}
        </div>
      </div>
    </li>
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
