/**
 * 記録 "/log" (FR-15, CUF-2 step 4): the finished challenges with their verdict stickers, then まとめ
 * (totals and the verdicts), then every ひとこと across challenges, newest first. While a challenge is
 * still open, one line points to きょう, where it lives.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { VERDICTS, VERDICT_KEYS, addDays, jpDate, jpPeriod, type Challenge, type Verdict } from "@thirty/shared";
import { Seal } from "../components/Seal";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { VerdictBadge } from "../features/share/VerdictBadge";
import { isOpen, stampedDays, viewChallenge } from "../lib/challenge";
import { usePageTitle } from "../lib/hooks";
import { useApp } from "../lib/store";
import "./log.css";

/** `shown`: the owner shows this note in 「みんな」 (#17). */
type NoteItem = { key: string; date: string; day: number; note: string; at: number; shown: boolean; challenge: Challenge };

const NOTES_PAGE = 30;

function noteTimeline(challenges: readonly Challenge[]): NoteItem[] {
  const out: NoteItem[] = [];
  for (const c of challenges) {
    for (const day of stampedDays(c)) {
      const s = c.stamps[String(day)];
      if (!s?.note) continue;
      out.push({ key: `${c.id}:${day}`, date: addDays(c.startDate, day - 1), day, note: s.note, at: s.at, shown: s.shown === true, challenge: c });
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || b.at - a.at);
}

export default function LogPage() {
  usePageTitle("記録");
  const { challenges, today, ready, hasSession, lastSyncedAt, lastSyncError, refreshing, refresh } = useApp();
  const [shown, setShown] = useState(NOTES_PAGE);

  const done = useMemo(
    () => challenges.filter((c) => c.status === "done").sort((a, b) => (b.finishedAt ?? b.updatedAt) - (a.finishedAt ?? a.updatedAt)),
    [challenges],
  );
  const tried = challenges.filter((c) => viewChallenge(c, today).phase !== "waiting").length;
  const totalStamps = challenges.reduce((n, c) => n + stampedDays(c).length, 0);
  const counts = useMemo(() => {
    const m: Record<Verdict, number> = { continue: 0, stop: 0, modify: 0 };
    for (const c of done) if (c.verdict) m[c.verdict]++;
    return m;
  }, [done]);
  const notes = useMemo(() => noteTimeline(challenges), [challenges]);
  const hasOpen = challenges.some(isOpen);

  if (!ready && challenges.length === 0) return <Loading label="記録を読み込んでいます…" />;
  if (challenges.length === 0 && hasSession && lastSyncedAt === null && lastSyncError) {
    return (
      <section className="lp-page">
        <h1 className="lp-h1">記録</h1>
        <ErrorState title="記録を読み込めませんでした" message={lastSyncError} onRetry={() => void refresh()} retrying={refreshing} />
      </section>
    );
  }
  if (challenges.length === 0) {
    return (
      <section className="lp-page">
        <h1 className="lp-h1">記録</h1>
        <EmptyState
          seal="記"
          title="まだ記録はありません"
          action={
            <Link to="/recipes" className="btn primary">
              レシピから選ぶ
            </Link>
          }
        >
          30日を始めると、押した印やひとこと、振り返りがここにたまっていきます。
        </EmptyState>
      </section>
    );
  }

  return (
    <section className="lp-page">
      <h1 className="lp-h1">記録</h1>
      {hasOpen && (
        <p className="lp-open">
          続けている30日は「きょう」にあります。<Link to="/">きょうを開く</Link>
        </p>
      )}

      <section className="lp-section" aria-labelledby="lp-done-h">
        <h2 className="lp-h2" id="lp-done-h">
          終わった30日
        </h2>
        {done.length === 0 ? (
          <p className="lp-empty">振り返りを終えた30日が、ここに並びます。30日目（7日目からは「ここで区切る」）に振り返れます。</p>
        ) : (
          <ul className="lp-done">
            {done.map((c) => (
              <li key={c.id}>
                <Link to={`/c/${c.id}`} className="lp-card">
                  <Seal char={c.seal} size="lg" />
                  <span className="lp-card-body">
                    <span className="lp-card-title">{c.title}</span>
                    <span className="lp-card-meta">
                      <span>{jpPeriod(c.startDate)}</span>
                      <span>
                        <b>{stampedDays(c).length}</b>/30日
                      </span>
                      {c.verdict && <VerdictBadge verdict={c.verdict} />}
                    </span>
                    {c.reflection && <span className="lp-card-quote">「{c.reflection}」</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="lp-section" aria-labelledby="lp-sum-h">
        <h2 className="lp-h2" id="lp-sum-h">
          まとめ
        </h2>
        <div className="lp-stats">
          <p className="lp-stat lp-stat-tried">
            <b>{tried}</b>
            <small>試した数</small>
          </p>
          <p className="lp-stat lp-stat-stamps">
            <b>{totalStamps}</b>
            <small>押した印の合計</small>
          </p>
        </div>
        <ul className="lp-verdicts" aria-label="判定の内訳">
          {VERDICT_KEYS.map((k) => (
            <li key={k} className={`lp-v lp-v-${k}`}>
              <span>{VERDICTS[k].label}</span>
              <b>{counts[k]}</b>
            </li>
          ))}
        </ul>
      </section>

      <section className="lp-section" aria-labelledby="lp-notes-h">
        <h2 className="lp-h2" id="lp-notes-h">
          メモ
        </h2>
        {notes.length === 0 ? (
          <p className="lp-empty">印を押した日に残したひとことが、新しい順にここに並びます。</p>
        ) : (
          <>
            <ol className="lp-notes">
              {notes.slice(0, shown).map((n) => (
                <li key={n.key} className="lp-note">
                  <time dateTime={n.date} className="lp-note-date">
                    {jpDate(n.date)}
                  </time>
                  <Link to={`/c/${n.challenge.id}`} className="lp-note-body">
                    <span className="lp-note-head">
                      <span className="lp-note-seal" aria-hidden="true">
                        {n.challenge.seal}
                      </span>
                      <span>
                        {n.challenge.title}・{n.day}日目
                      </span>
                      {n.shown && <span className="lp-note-tag">みんな</span>}
                    </span>
                    <span className="lp-note-text">{n.note}</span>
                  </Link>
                </li>
              ))}
            </ol>
            {notes.length > shown && (
              <button type="button" className="btn lp-more" onClick={() => setShown((n) => n + NOTES_PAGE)}>
                もっと見る（残り{notes.length - shown}件）
              </button>
            )}
          </>
        )}
      </section>
    </section>
  );
}
