/**
 * 管理 (SPEC FR-18, FR-19): statistics against the pilot targets, reports and moderation, featured
 * recipes, contact messages. The admin token is kept in sessionStorage only (lib/admin.ts).
 * Not linked from anywhere and marked noindex.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router";
import {
  VERDICTS,
  VERDICT_KEYS,
  type AdminContactItem,
  type AdminModerate,
  type AdminReportItem,
  type AdminStats,
  type Recipe,
  type ReportTargetType,
} from "@thirty/shared";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { TextField } from "../components/Field";
import { Seal } from "../components/Seal";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { useToast } from "../components/Toast";
import {
  WRONG_TOKEN_MESSAGE,
  adminErrorMessage,
  clearAdminToken,
  fetchAdminContacts,
  fetchAdminReports,
  fetchAdminStats,
  fetchRecipesForAdmin,
  getAdminToken,
  isWrongToken,
  moderate,
  setAdminToken,
  setRecipeFeatured,
} from "../lib/admin";
import { jpDateTime } from "../lib/format";
import { usePageTitle } from "../lib/hooks";
import "./AdminPage.css";

/** <meta name="robots" content="noindex"> while this page is open. */
function useNoIndex(): void {
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
}

export default function AdminPage() {
  usePageTitle("管理");
  useNoIndex();
  const [token, setToken] = useState<string | null>(() => getAdminToken());
  const [loginError, setLoginError] = useState<string | null>(null);

  const onWrongToken = useCallback(() => {
    clearAdminToken();
    setToken(null);
    setLoginError(WRONG_TOKEN_MESSAGE);
  }, []);

  const onLogout = useCallback(() => {
    clearAdminToken();
    setToken(null);
    setLoginError(null);
  }, []);

  if (!token) {
    return (
      <AdminLogin
        error={loginError}
        onLogin={(t) => {
          setAdminToken(t);
          setLoginError(null);
          setToken(t);
        }}
      />
    );
  }
  return <AdminConsole onWrongToken={onWrongToken} onLogout={onLogout} />;
}

function AdminLogin({ error, onLogin }: { error: string | null; onLogin: (token: string) => void }) {
  const [value, setValue] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>();

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!value.trim()) {
      setFieldError("トークンを入力してください");
      return;
    }
    onLogin(value.trim());
  }

  return (
    <section className="adm" aria-labelledby="adm-title">
      <h1 id="adm-title" className="adm-title">
        管理
      </h1>
      <form className="card form adm-login" onSubmit={onSubmit} noValidate>
        <TextField
          label="管理トークン"
          type="password"
          value={value}
          onChange={(v) => {
            setValue(v);
            setFieldError(undefined);
          }}
          error={fieldError}
          autoComplete="off"
          spellCheck={false}
          hint="このタブを閉じると、入力したトークンは消えます。"
        />
        {error && (
          <p className="note err" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn primary">
          開く
        </button>
      </form>
    </section>
  );
}

// ---------- data loading ----------

type LoadState<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; data: T };

function useAdminData<T>(load: () => Promise<T>, onWrongToken: () => void) {
  const [state, setState] = useState<LoadState<T>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    load().then(
      (data) => {
        if (alive) setState({ status: "ok", data });
      },
      (err: unknown) => {
        if (!alive) return;
        if (isWrongToken(err)) onWrongToken();
        else setState({ status: "error", message: adminErrorMessage(err) });
      },
    );
    return () => {
      alive = false;
    };
  }, [load, onWrongToken, nonce]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setNonce((n) => n + 1);
  }, []);

  const update = useCallback((fn: (data: T) => T) => {
    setState((s) => (s.status === "ok" ? { status: "ok", data: fn(s.data) } : s));
  }, []);

  return { state, reload, update };
}

function Loaded<T>({ state, reload, children }: { state: LoadState<T>; reload: () => void; children: (data: T) => ReactNode }) {
  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorState message={state.message} onRetry={reload} />;
  return <>{children(state.data)}</>;
}

// ---------- console ----------

const TABS = [
  { id: "stats", label: "統計" },
  { id: "reports", label: "通報" },
  { id: "featured", label: "おすすめ" },
  { id: "contacts", label: "お問い合わせ" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function AdminConsole({ onWrongToken, onLogout }: { onWrongToken: () => void; onLogout: () => void }) {
  const [tab, setTab] = useState<TabId>("stats");

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = TABS.length - 1;
    const next =
      e.key === "ArrowRight" ? (index + 1) % TABS.length : e.key === "ArrowLeft" ? (index - 1 + TABS.length) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    const t = TABS[next]!;
    setTab(t.id);
    document.getElementById(`adm-tab-${t.id}`)?.focus();
  }

  return (
    <section className="adm" aria-labelledby="adm-title">
      <div className="adm-head">
        <h1 id="adm-title" className="adm-title">
          管理
        </h1>
        <button type="button" className="btn sm" onClick={onLogout}>
          トークンを消して閉じる
        </button>
      </div>
      <div role="tablist" aria-label="管理メニュー" className="adm-tabs">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            id={`adm-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`adm-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className="adm-tab"
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`adm-panel-${tab}`} aria-labelledby={`adm-tab-${tab}`} className="adm-panel" tabIndex={0}>
        {tab === "stats" && <StatsTab onWrongToken={onWrongToken} />}
        {tab === "reports" && <ReportsTab onWrongToken={onWrongToken} />}
        {tab === "featured" && <FeaturedTab onWrongToken={onWrongToken} />}
        {tab === "contacts" && <ContactsTab onWrongToken={onWrongToken} />}
      </div>
    </section>
  );
}

// ---------- 統計 ----------

const loadStats = () => fetchAdminStats();

const CHANNEL_LABELS: Record<string, string> = {
  link: "公開リンク",
  image: "画像を保存",
  webshare: "端末の共有",
  x: "X",
  line: "LINE",
  copy: "コピー",
};

function pct(n: number, d: number): number | null {
  return d > 0 ? n / d : null;
}

function fmtPct(r: number | null): string {
  return r === null ? "—" : `${Math.round(r * 1000) / 10}%`;
}

type Judge = "pass" | "fail" | "na";

function JudgeBadge({ judge }: { judge: Judge }) {
  const text = judge === "pass" ? "達成" : judge === "fail" ? "未達" : "判定なし";
  return <span className={`adm-judge ${judge}`}>{text}</span>;
}

/** Pilot targets from docs/validation-plan.md (fixed before the pilot). */
export function pilotRows(s: AdminStats): { label: string; value: string; target: string; judge: Judge; note?: string }[] {
  const done = pct(s.challengesDone, s.challengesStarted);
  const share = pct(s.shares, s.challengesDone);
  return [
    {
      label: "開始数",
      value: `${s.users}人`,
      target: "8人以上",
      judge: s.users >= 8 ? "pass" : "fail",
      note: `アカウント数で代用（始めたチャレンジは${s.challengesStarted}件）`,
    },
    { label: "7日継続", value: "—", target: "60%以上", judge: "na", note: "統計では出せません。1日組の30マスで確かめてください" },
    {
      label: "完走",
      value: fmtPct(done),
      target: "40%以上",
      judge: done === null ? "na" : done >= 0.4 ? "pass" : "fail",
      note: `振り返り ${s.challengesDone} ÷ 開始 ${s.challengesStarted}（チャレンジ数）`,
    },
    {
      label: "共有",
      value: fmtPct(share),
      target: "30%以上",
      judge: share === null ? "na" : share >= 0.3 ? "pass" : "fail",
      note: `公開カード ${s.shares} ÷ 振り返り ${s.challengesDone}（参考。画像保存・SNS は下の回数）`,
    },
  ];
}

function StatsTab({ onWrongToken }: { onWrongToken: () => void }) {
  const { state, reload } = useAdminData(loadStats, onWrongToken);
  return (
    <div className="adm-stack">
      <div className="adm-toolbar">
        <h2 className="adm-h">統計</h2>
        <button type="button" className="btn sm" onClick={reload} disabled={state.status === "loading"}>
          更新
        </button>
      </div>
      <Loaded state={state} reload={reload}>
        {(s) => <StatsView stats={s} />}
      </Loaded>
    </div>
  );
}

function StatsView({ stats: s }: { stats: AdminStats }) {
  const tiles: { label: string; value: string }[] = [
    { label: "利用者", value: `${s.users}` },
    { label: "始めたチャレンジ", value: `${s.challengesStarted}` },
    { label: "振り返り", value: `${s.challengesDone}` },
    { label: "完走率", value: fmtPct(pct(s.challengesDone, s.challengesStarted)) },
    { label: "みんなのレシピ", value: `${s.communityRecipes}` },
    { label: "体験談", value: `${s.stories}` },
    { label: "公開カード", value: `${s.shares}` },
    { label: "今日のひらめき提案", value: `${s.suggestionsToday}` },
    { label: "通知の登録", value: `${s.pushSubscriptions}` },
  ];
  const channels = Object.entries(s.shareActions);
  const shareTotal = channels.reduce((a, [, n]) => a + n, 0);
  return (
    <>
      <ul className="adm-tiles">
        {tiles.map((t) => (
          <li key={t.label} className="adm-tile">
            <span className="adm-tile-n">{t.value}</span>
            <span className="adm-tile-l">{t.label}</span>
          </li>
        ))}
      </ul>

      <section className="card adm-card" aria-labelledby="adm-pilot-h">
        <h3 id="adm-pilot-h" className="adm-sub">
          PILOT の合格ライン
        </h3>
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th scope="col">指標</th>
                <th scope="col">いま</th>
                <th scope="col">合格ライン</th>
                <th scope="col">判定</th>
              </tr>
            </thead>
            <tbody>
              {pilotRows(s).map((r) => (
                <tr key={r.label}>
                  <th scope="row">{r.label}</th>
                  <td>
                    <b>{r.value}</b>
                    {r.note && <small>{r.note}</small>}
                  </td>
                  <td>{r.target}</td>
                  <td>
                    <JudgeBadge judge={r.judge} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">合格ラインは docs/validation-plan.md（実施前に固定）。判定は PILOT の終わりに行います。</p>
      </section>

      <div className="adm-two">
        <section className="card adm-card" aria-labelledby="adm-verdict-h">
          <h3 id="adm-verdict-h" className="adm-sub">
            判定の内訳
          </h3>
          <dl className="adm-kv">
            {VERDICT_KEYS.map((v) => (
              <div key={v}>
                <dt>{VERDICTS[v].label}</dt>
                <dd>{s.verdicts[v] ?? 0}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="card adm-card" aria-labelledby="adm-share-h">
          <h3 id="adm-share-h" className="adm-sub">
            共有の操作（合計 {shareTotal} 回）
          </h3>
          {channels.length === 0 ? (
            <p className="note">まだありません。</p>
          ) : (
            <dl className="adm-kv">
              {channels.map(([ch, n]) => (
                <div key={ch}>
                  <dt>{CHANNEL_LABELS[ch] ?? ch}</dt>
                  <dd>{n}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      </div>
    </>
  );
}

// ---------- 通報 ----------

const loadReports = () => fetchAdminReports().then((r) => r.items);

const TYPE_LABELS: Record<ReportTargetType, string> = {
  recipe: "レシピ",
  story: "体験談",
  share: "公開カード",
  member: "1日組",
};

const STATUS_LABELS: Record<AdminReportItem["status"], string> = {
  published: "公開中",
  hidden: "非表示",
  deleted: "削除済み",
};

function TargetLink({ item }: { item: AdminReportItem }) {
  if (item.status === "deleted") return null;
  if (item.targetType === "recipe") return <Link to={`/recipes/${item.targetId}`}>開く</Link>;
  if (item.targetType === "story") return <Link to={`/recipes/${item.targetId.split(":")[0] ?? ""}`}>レシピを開く</Link>;
  if (item.targetType === "share") {
    return (
      <a href={`/s/${item.targetId}`} target="_blank" rel="noopener noreferrer">
        開く<span className="sr-only">（新しいタブ）</span>
      </a>
    );
  }
  return <Link to="/together">みんなを開く</Link>;
}

type Pending = { item: AdminReportItem; action: AdminModerate["action"] };

const ACTION_TEXT: Record<AdminModerate["action"], { title: string; message: string; confirm: string; done: string }> = {
  hide: { title: "非表示にしますか？", message: "公開をやめます。あとで復元できます。", confirm: "非表示にする", done: "非表示にしました" },
  restore: { title: "復元しますか？", message: "もう一度公開し、通報の数を0に戻します。", confirm: "復元する", done: "復元しました" },
  delete: { title: "削除しますか？", message: "完全に削除します。元に戻せません。", confirm: "削除する", done: "削除しました" },
};

function ReportsTab({ onWrongToken }: { onWrongToken: () => void }) {
  const toast = useToast();
  const { state, reload, update } = useAdminData(loadReports, onWrongToken);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    if (!pending) return;
    const { item, action } = pending;
    setBusy(true);
    try {
      await moderate({ targetType: item.targetType, targetId: item.targetId, action });
      const status: AdminReportItem["status"] = action === "hide" ? "hidden" : action === "restore" ? "published" : "deleted";
      update((items) =>
        items.map((x) =>
          x.targetType === item.targetType && x.targetId === item.targetId ? { ...x, status, count: action === "restore" ? 0 : x.count } : x,
        ),
      );
      toast(ACTION_TEXT[action].done);
      setPending(null);
    } catch (err) {
      if (isWrongToken(err)) {
        onWrongToken();
        return;
      }
      toast(adminErrorMessage(err), { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="adm-stack">
      <div className="adm-toolbar">
        <h2 className="adm-h">通報</h2>
        <button type="button" className="btn sm" onClick={reload} disabled={state.status === "loading"}>
          更新
        </button>
      </div>
      <Loaded state={state} reload={reload}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState seal="無" title="通報はありません" />
          ) : (
            <ul className="adm-list">
              {items.map((item) => (
                <li key={`${item.targetType}:${item.targetId}`} className="card adm-item" data-status={item.status}>
                  <div className="adm-item-head">
                    <span className="adm-type">{TYPE_LABELS[item.targetType] ?? item.targetType}</span>
                    <span className={`adm-status ${item.status}`}>{STATUS_LABELS[item.status] ?? item.status}</span>
                    <span className="adm-count">通報 {item.count}件</span>
                  </div>
                  <p className="adm-preview">{item.preview || "（内容を表示できません）"}</p>
                  {item.reasons.length > 0 && (
                    <ul className="adm-reasons" aria-label="通報の理由">
                      {item.reasons.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  )}
                  <p className="note">
                    最後の通報 {jpDateTime(item.lastAt)} ・ ID {item.targetId}
                  </p>
                  <div className="row gap fw adm-actions">
                    <TargetLink item={item} />
                    {item.status === "published" && (
                      <button type="button" className="btn sm" onClick={() => setPending({ item, action: "hide" })}>
                        非表示
                      </button>
                    )}
                    {item.status === "hidden" && (
                      <button type="button" className="btn sm" onClick={() => setPending({ item, action: "restore" })}>
                        復元
                      </button>
                    )}
                    {item.status !== "deleted" && (
                      <button type="button" className="btn sm danger" onClick={() => setPending({ item, action: "delete" })}>
                        削除
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
      <ConfirmDialog
        open={pending !== null}
        title={pending ? ACTION_TEXT[pending.action].title : ""}
        message={
          pending ? (
            <>
              <p>
                {TYPE_LABELS[pending.item.targetType]}「{pending.item.preview || pending.item.targetId}」
              </p>
              <p>{ACTION_TEXT[pending.action].message}</p>
            </>
          ) : undefined
        }
        confirmLabel={pending ? ACTION_TEXT[pending.action].confirm : "OK"}
        danger={pending?.action === "delete"}
        busy={busy}
        onConfirm={() => void run()}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}

// ---------- おすすめ ----------

const loadRecipes = () => fetchRecipesForAdmin().then((r) => r.recipes);

function FeaturedTab({ onWrongToken }: { onWrongToken: () => void }) {
  const toast = useToast();
  const { state, reload, update } = useAdminData(loadRecipes, onWrongToken);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const list = useMemo(() => {
    if (state.status !== "ok") return [];
    const q = query.trim().toLowerCase();
    const filtered = q ? state.data.filter((r) => r.title.toLowerCase().includes(q) || r.id.includes(q)) : state.data;
    return [...filtered].sort((a, b) => Number(b.featured) - Number(a.featured));
  }, [state, query]);

  async function toggle(r: Recipe) {
    setBusyId(r.id);
    try {
      await setRecipeFeatured(r.id, !r.featured);
      update((items) => items.map((x) => (x.id === r.id ? { ...x, featured: !r.featured } : x)));
      toast(r.featured ? `「${r.title}」をおすすめから外しました` : `「${r.title}」をおすすめにしました`);
    } catch (err) {
      if (isWrongToken(err)) {
        onWrongToken();
        return;
      }
      toast(adminErrorMessage(err), { tone: "error" });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="adm-stack">
      <div className="adm-toolbar">
        <h2 className="adm-h">おすすめ</h2>
        <button type="button" className="btn sm" onClick={reload} disabled={state.status === "loading"}>
          更新
        </button>
      </div>
      <TextField label="レシピを絞り込む" value={query} onChange={setQuery} type="search" placeholder="タイトルで探す" />
      <Loaded state={state} reload={reload}>
        {() =>
          list.length === 0 ? (
            <EmptyState seal="無" title={query ? "見つかりませんでした" : "レシピがありません"} />
          ) : (
            <ul className="adm-list">
              {list.map((r) => (
                <li key={r.id} className="card adm-recipe">
                  <Seal char={r.seal} size="md" />
                  <div className="adm-recipe-body">
                    <b>{r.title}</b>
                    <span className="note">
                      {r.source === "official" ? "公式" : `みんな（${r.authorName ?? "名無し"}）`} ・ 開始 {r.startCount} ・ 体験談 {r.storyCount}
                    </span>
                  </div>
                  <button
                    type="button"
                    className={r.featured ? "btn sm adm-feat on" : "btn sm adm-feat"}
                    aria-pressed={r.featured}
                    aria-label={`「${r.title}」をおすすめにする`}
                    onClick={() => void toggle(r)}
                    disabled={busyId === r.id}
                  >
                    {r.featured ? "おすすめ中" : "おすすめにする"}
                  </button>
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
    </div>
  );
}

// ---------- お問い合わせ ----------

const loadContacts = () => fetchAdminContacts().then((r) => r.items);

function ContactsTab({ onWrongToken }: { onWrongToken: () => void }) {
  const { state, reload } = useAdminData(loadContacts, onWrongToken);
  return (
    <div className="adm-stack">
      <div className="adm-toolbar">
        <h2 className="adm-h">お問い合わせ</h2>
        <button type="button" className="btn sm" onClick={reload} disabled={state.status === "loading"}>
          更新
        </button>
      </div>
      <p className="note">180日で自動的に消えます。連絡先は返信のためだけに使ってください。</p>
      <Loaded state={state} reload={reload}>
        {(items: AdminContactItem[]) =>
          items.length === 0 ? (
            <EmptyState seal="無" title="お問い合わせはまだありません" />
          ) : (
            <ul className="adm-list">
              {items.map((c) => (
                <li key={c.id} className="card adm-contact">
                  <p className="note">{jpDateTime(c.createdAt)}</p>
                  <p className="adm-message">{c.message}</p>
                  <p className="adm-reply">{c.replyTo ? `返信先：${c.replyTo}` : "返信先なし"}</p>
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
    </div>
  );
}
