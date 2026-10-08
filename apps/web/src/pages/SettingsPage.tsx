/**
 * 設定 (SPEC UI "/settings"; FR-1, FR-2, FR-14, FR-16, FR-17, FR-21). Sections have ids so other screens
 * can link to them: #profile #reminder #transfer #backup #display #danger.
 * 表示 (the theme) comes first so it is easy to find at night (#20); the jump links follow the same order.
 * Without an account only what makes sense is shown (redeem a code, theme, links).
 */
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  API,
  BackupFileSchema,
  LIMITS,
  QUOTAS,
  REMINDER_STEP_MINUTES,
  TRANSFER_CODE_TTL_MINUTES,
  TransferRedeemSchema,
  type BackupFile,
  type Challenge,
  type ImportResponse,
  type Reminder,
  type TransferCodeResponse,
  type User,
} from "@thirty/shared";
import { version as packageVersion } from "../../package.json";
import { ChipGroup } from "../components/Chip";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { SelectField, TextField } from "../components/Field";
import { Seal } from "../components/Seal";
import { ErrorState, Loading } from "../components/States";
import { useToast } from "../components/Toast";
import { ApiClientError, errorMessage, isQuotaLimit, request } from "../lib/api";
import { isOpen } from "../lib/challenge";
import { usePageTitle } from "../lib/hooks";
import { clearAllPhotos } from "../lib/photos";
import {
  disablePush,
  enablePush,
  getCurrentSubscription,
  getPublicKey,
  getPushStatus,
  pushErrorMessage,
  sendTestPush,
  type PushStatus,
} from "../lib/push";
import { PROFILE_LIMIT_MESSAGE } from "../lib/appStore";
import { getToken } from "../lib/session";
import { useApp, type AppContextValue } from "../lib/store";
import { useThemePref, type ThemePref } from "../lib/theme";
import { parseWith } from "../lib/validation";
import "./SettingsPage.css";

const APP_VERSION: string = (import.meta.env.VITE_APP_VERSION as string | undefined) || packageVersion;

/** 05:00 … 23:45 on the scheduler's grid. */
export const REMINDER_TIMES: readonly string[] = (() => {
  const out: string[] = [];
  for (let m = 5 * 60; m <= 23 * 60 + 45; m += REMINDER_STEP_MINUTES) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  }
  return out;
})();

/** The server answers with a body of up to 1MB; a backup file bigger than that cannot be imported. */
const MAX_BACKUP_BYTES = 1_000_000;

type Accent = "pink" | "yellow" | "blue" | "mint" | "lilac" | "shu" | "plain";

function Section({ id, title, accent, children }: { id: string; title: string; accent: Accent; children: ReactNode }) {
  return (
    <section id={id} className="card set-sec" data-accent={accent} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="set-h">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function SettingsPage() {
  usePageTitle("設定");
  const app = useApp();
  const { hash } = useLocation();
  const signedIn = app.hasSession;
  const hasLocalData = app.challenges.length > 0 || app.user !== null;

  // Deep links (/settings#transfer) on a fresh load: the sections exist after the first render.
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView();
  }, [hash]);

  const jumps: { id: string; label: string }[] = signedIn
    ? [
        { id: "display", label: "表示" },
        { id: "profile", label: "プロフィール" },
        { id: "reminder", label: "リマインド" },
        { id: "transfer", label: "引き継ぎ" },
        { id: "backup", label: "バックアップ" },
        { id: "danger", label: "データ削除" },
      ]
    : [
        { id: "display", label: "表示" },
        { id: "transfer", label: "引き継ぎ" },
      ];

  return (
    <div className="set-page">
      <header className="set-top">
        <h1 className="h2 set-title">設定</h1>
        <nav aria-label="設定の項目">
          <ul className="set-jump">
            {jumps.map((j) => (
              <li key={j.id}>
                <a href={`#${j.id}`}>{j.label}</a>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      {!signedIn && !app.sessionInvalid && (
        <section className="card set-sec set-intro" data-accent="yellow" aria-labelledby="intro-title">
          <h2 id="intro-title" className="set-h">
            まだアカウントはありません
          </h2>
          <p>
            {"最初のチャレンジを始めると、匿名のアカウントが自動でできます。メールアドレスや電話番号はいりません。"}
            {"プロフィールやリマインドは、そのあとで設定できます。"}
          </p>
          <p className="row gap fw">
            <Link to="/recipes" className="btn primary">
              レシピから選ぶ
            </Link>
            <Link to="/gacha" className="btn">
              ガチャで決める
            </Link>
          </p>
        </section>
      )}

      <DisplaySection />
      {signedIn && <AccountSections app={app} />}

      <TransferSection app={app} signedIn={signedIn} hasLocalData={hasLocalData} />
      {signedIn && <BackupSection app={app} />}
      {(signedIn || app.sessionInvalid || app.challenges.length > 0) && <DangerSection app={app} signedIn={signedIn} />}
      <LinksSection />
    </div>
  );
}

// ---------- profile & reminder (need the account) ----------

function AccountSections({ app }: { app: AppContextValue }) {
  const { user, ready, refreshing, refresh } = app;
  if (!user) {
    const body =
      !ready || refreshing ? (
        <Loading label="プロフィールを読み込んでいます…" />
      ) : (
        <ErrorState message="プロフィールを読み込めませんでした。通信できる場所で、もう一度お試しください。" onRetry={() => void refresh()} />
      );
    return (
      <>
        <Section id="profile" title="プロフィール" accent="pink">
          {body}
        </Section>
        <Section id="reminder" title="リマインド" accent="yellow">
          {!ready || refreshing ? <Loading inline /> : <p className="note">プロフィールを読み込むと設定できます。</p>}
        </Section>
      </>
    );
  }
  return (
    <>
      <ProfileSection user={user} updateMe={app.updateMe} limitedUntil={app.profileLimitedUntil} />
      <ReminderSection user={user} challenges={app.challenges} updateMe={app.updateMe} />
    </>
  );
}

type ProfileProps = {
  user: User;
  updateMe: AppContextValue["updateMe"];
  /** The daily profile quota refuses changes until then (ms); null when it does not. */
  limitedUntil: number | null;
};

function ProfileSection({ user, updateMe, limitedUntil }: ProfileProps) {
  const toast = useToast();
  // Renaming and turning 「みんなに表示」 on are limited per day (each rewrites the public records).
  // Turning it off is a privacy action the quota never blocks (R13).
  const limited = limitedUntil !== null;
  const onShare = (e: ChangeEvent<HTMLInputElement>) => {
    const next = e.target.checked;
    const res = updateMe({ shareProgress: next });
    if (!res.ok) toast(res.message, { tone: "error" });
    else toast(next ? "進捗を「みんな」に表示します" : "進捗を「みんな」に表示しないようにしました");
  };
  return (
    <Section id="profile" title="プロフィール" accent="pink">
      {limited && (
        <p className="note err" role="status" data-testid="profile-limit">
          {PROFILE_LIMIT_MESSAGE}
        </p>
      )}
      {/* Remount when the saved nickname changes (another tab, a refresh) so the field shows it. */}
      <NicknameForm key={user.nickname} initial={user.nickname} updateMe={updateMe} locked={limited} />
      <div className="set-row">
        <label className="set-switch">
          <input
            type="checkbox"
            className="set-toggle"
            checked={user.shareProgress}
            onChange={onShare}
            disabled={limited && !user.shareProgress}
            aria-describedby="share-explain"
          />
          <span>
            <b>みんなに進捗を表示する</b>
          </span>
        </label>
        <div id="share-explain" className="set-explain">
          <p>
            <b>表示されるもの：</b>ニックネーム、チャレンジのタイトルと印、印を押した日（30マス）、振り返りの判定、応援の数、「みんなに見せる」を選んだひとことメモ
          </p>
          <p>
            <b>表示されないもの：</b>選んでいないひとことメモ、写真、振り返りのひとこと
          </p>
          <p className="note">
            オフにすると、「みんな」の1日組の一覧から消えます（見せていたひとことも表示されなくなります）。オンに戻すと、「みんなに見せる」を選んだひとことも、また表示されます。
          </p>
        </div>
      </div>
    </Section>
  );
}

function NicknameForm({ initial, updateMe, locked }: { initial: string; updateMe: AppContextValue["updateMe"]; locked: boolean }) {
  const toast = useToast();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | undefined>();
  const dirty = value.trim() !== initial;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const res = updateMe({ nickname: value });
    if (!res.ok) {
      setError(res.fields.nickname ?? res.message);
      return;
    }
    setError(undefined);
    toast("ニックネームを保存しました");
  }

  return (
    <form className="set-inline-form" onSubmit={onSubmit} noValidate>
      <TextField
        label="ニックネーム"
        value={value}
        onChange={(v) => {
          setValue(v);
          if (error) setError(undefined);
        }}
        max={LIMITS.nickname}
        error={error}
        hint="「みんな」やレシピの投稿に表示されます。本名は入れないでください。"
        autoComplete="nickname"
        enterKeyHint="done"
      />
      <button type="submit" className="btn" disabled={!dirty || locked}>
        保存
      </button>
    </form>
  );
}

function ReminderSection({ user, challenges, updateMe }: { user: User; challenges: Challenge[]; updateMe: AppContextValue["updateMe"] }) {
  const toast = useToast();
  const reminder = user.reminder;
  const times = REMINDER_TIMES.includes(reminder.time) ? REMINDER_TIMES : [reminder.time, ...REMINDER_TIMES];

  function save(next: Reminder): boolean {
    const res = updateMe({ reminder: next });
    if (!res.ok) toast(res.message, { tone: "error" });
    return res.ok;
  }

  return (
    <Section id="reminder" title="リマインド" accent="yellow">
      <p className="note">決めた時刻に、その日の印をまだ押していないチャレンジがあれば、通知でお知らせします。</p>
      <label className="set-switch">
        <input
          type="checkbox"
          className="set-toggle"
          checked={reminder.enabled}
          onChange={(e) => {
            if (save({ enabled: e.target.checked, time: reminder.time })) {
              toast(e.target.checked ? `毎日 ${reminder.time} にお知らせします` : "リマインドをオフにしました");
            }
          }}
        />
        <span>
          <b>毎日リマインドする</b>
        </span>
      </label>
      <SelectField
        label="時刻"
        className="set-time"
        value={reminder.time}
        options={times.map((t) => ({ value: t, label: t }))}
        onChange={(time) => {
          if (time !== reminder.time) save({ enabled: reminder.enabled, time });
        }}
        hint="15分ごとに選べます"
      />
      <PushControls reminder={reminder} updateMe={updateMe} />
      <CalendarPointer challenges={challenges} />
    </Section>
  );
}

type Busy = null | "enable" | "disable" | "test";

function PushControls({ reminder, updateMe }: { reminder: Reminder; updateMe: AppContextValue["updateMe"] }) {
  const [status, setStatus] = useState<PushStatus>(getPushStatus);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [serverKey, setServerKey] = useState<"loading" | "ok" | "none" | "error">("loading");
  const [busy, setBusy] = useState<Busy>(null);
  const [msg, setMsg] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const usable = status === "default" || status === "granted";

  useEffect(() => {
    if (!usable) return;
    let alive = true;
    getPublicKey().then(
      (k) => alive && setServerKey(k ? "ok" : "none"),
      () => alive && setServerKey("error"),
    );
    void getCurrentSubscription().then((s) => alive && setSubscribed(s !== null));
    return () => {
      alive = false;
    };
  }, [usable]);

  // The permission can change in the browser's settings while the page is in the background.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") setStatus(getPushStatus());
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Must stay synchronous up to enablePush(): the permission prompt needs the click's user gesture.
  function onEnable() {
    setBusy("enable");
    setMsg(null);
    enablePush()
      .then(() => {
        setSubscribed(true);
        if (!reminder.enabled) updateMe({ reminder: { enabled: true, time: reminder.time } });
        setMsg({ tone: "info", text: `この端末に通知が届くようになりました。毎日 ${reminder.time} にお知らせします。` });
      })
      .catch((err: unknown) => setMsg({ tone: "error", text: pushErrorMessage(err) }))
      .finally(() => {
        setStatus(getPushStatus());
        setBusy(null);
      });
  }

  async function onTest() {
    setBusy("test");
    setMsg(null);
    try {
      await sendTestPush();
      setMsg({ tone: "info", text: "テスト通知を送りました。1分ほどたっても届かないときは、端末の通知設定を確認してください。" });
    } catch (err) {
      setMsg({ tone: "error", text: pushErrorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  async function onDisable() {
    setBusy("disable");
    setMsg(null);
    try {
      await disablePush();
      setSubscribed(false);
      setMsg({ tone: "info", text: "この端末への通知を止めました。時刻の設定はそのまま残っています。" });
    } catch (err) {
      setMsg({ tone: "error", text: pushErrorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  let body: ReactNode;
  if (status === "ios-needs-install") {
    body = <p className="set-callout">iPhone は、Safari の共有ボタン →『ホーム画面に追加』してから開くと通知を受け取れます。</p>;
  } else if (status === "unsupported") {
    body = <p className="set-callout">このブラウザでは通知を使えません。下のカレンダーで代わりに思い出せます。</p>;
  } else if (status === "denied") {
    body = (
      <p className="set-callout">
        通知がブロックされています。ブラウザ（またはスマホ）の設定でこのサイトの通知を許可してから、この画面を開き直してください。下のカレンダーで代わりに思い出すこともできます。
      </p>
    );
  } else if (serverKey === "none") {
    body = <p className="set-callout">いまは通知を使えません。下のカレンダーで代わりに思い出せます。</p>;
  } else if (status === "granted" && subscribed === null) {
    body = <Loading inline label="この端末の通知を確認しています…" />;
  } else if (status === "granted" && subscribed) {
    body = (
      <>
        <p className="set-state">
          <span className="set-dot on" aria-hidden="true" />
          この端末に通知が届きます
        </p>
        <div className="row gap fw">
          <button type="button" className="btn" onClick={() => void onTest()} disabled={busy !== null} aria-busy={busy === "test"}>
            {busy === "test" ? "送っています…" : "テスト通知"}
          </button>
          <button type="button" className="linkbtn" onClick={() => void onDisable()} disabled={busy !== null}>
            この端末では通知を止める
          </button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <p className="set-state">
          <span className="set-dot" aria-hidden="true" />
          {status === "granted" ? "この端末の通知：オフ" : "この端末の通知：まだ許可していません"}
        </p>
        <button type="button" className="btn primary" onClick={onEnable} disabled={busy !== null} aria-busy={busy === "enable"}>
          {busy === "enable" ? "準備しています…" : status === "granted" ? "この端末で通知を受け取る" : "通知を許可する"}
        </button>
      </>
    );
  }

  return (
    <div className="set-push">
      <h3 className="set-sub">この端末の通知</h3>
      {body}
      <div aria-live="polite" className="set-live">
        {msg && <p className={msg.tone === "error" ? "note err" : "note set-ok"}>{msg.text}</p>}
      </div>
    </div>
  );
}

function CalendarPointer({ challenges }: { challenges: Challenge[] }) {
  const open = challenges.filter(isOpen);
  return (
    <div className="set-cal">
      <h3 className="set-sub">カレンダーで思い出す</h3>
      <p className="note">
        通知が使えないときは、各チャレンジの画面から Google カレンダーに毎日の予定を入れたり、.ics ファイルを保存したりできます。
      </p>
      {open.length > 0 && (
        <ul className="set-cal-list">
          {open.map((c) => (
            <li key={c.id}>
              <Link to={`/c/${c.id}`}>
                <Seal char={c.seal} size="sm" />
                <span>{c.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- transfer ----------

function TransferSection({ app, signedIn, hasLocalData }: { app: AppContextValue; signedIn: boolean; hasLocalData: boolean }) {
  return (
    <Section id="transfer" title="引き継ぎ" accent="blue">
      {app.sessionInvalid && <SessionRecovery app={app} />}
      {signedIn && <IssueCode />}
      <RedeemCode app={app} signedIn={signedIn} hasLocalData={hasLocalData} />
    </Section>
  );
}

function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  return false;
}

function IssueCode() {
  const toast = useToast();
  const [issued, setIssued] = useState<{ code: string; deadline: number } | null>(null);
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remaining = issued ? issued.deadline - now : 0;
  const expired = issued !== null && remaining <= 0;

  useEffect(() => {
    if (!issued) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [issued]);

  async function onIssue() {
    setBusy(true);
    setError(null);
    try {
      const res = await request<TransferCodeResponse>("POST", API.meTransferCode, { auth: "required" });
      const at = Date.now();
      const ttl = TRANSFER_CODE_TTL_MINUTES * 60_000;
      // Trust the server's expiry unless the device clock is clearly off.
      const left = res.expiresAt - at;
      setNow(at);
      setIssued({ code: res.code, deadline: at + (left > 0 && left <= ttl ? left : ttl) });
      toast("引き継ぎコードを発行しました");
    } catch (err) {
      setError(isQuotaLimit(err) ? "コードの発行は1時間に5回までです。しばらくしてからお試しください。" : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onCopy() {
    if (!issued) return;
    toast((await copyText(issued.code)) ? "コードをコピーしました" : "コピーできませんでした。コードを書き写してください", {
      tone: "info",
    });
  }

  return (
    <div className="set-block">
      <h3 className="set-sub">別の端末で使う</h3>
      <p className="note">
        この端末でコードを発行し、新しい端末の設定で入力すると、同じ記録を使えます。コードは{TRANSFER_CODE_TTL_MINUTES}
        分間、1回だけ有効です。写真は引き継がれません。
      </p>
      {issued && !expired && (
        <div className="set-codebox">
          <p className="set-code" translate="no" aria-label={`引き継ぎコード ${issued.code.split("").join(" ")}`}>
            <span>{issued.code.slice(0, 4)}</span>
            <span>{issued.code.slice(4)}</span>
          </p>
          <p className="set-countdown">
            あと <b>{mmss(remaining)}</b> 有効
          </p>
          <p className="note">このコードがあれば、誰でもあなたの記録を使えます。人に見せたり、SNS に載せたりしないでください。</p>
          <button type="button" className="btn" onClick={() => void onCopy()}>
            コピー
          </button>
        </div>
      )}
      {issued && expired && <p className="note err">コードの期限が切れました。もう一度発行してください。</p>}
      {error && (
        <p className="note err" role="alert">
          {error}
        </p>
      )}
      <button type="button" className={issued ? "btn" : "btn primary"} onClick={() => void onIssue()} disabled={busy} aria-busy={busy}>
        {busy ? "発行しています…" : issued ? "コードを発行し直す" : "引き継ぎコードを発行"}
      </button>
    </div>
  );
}

function RedeemCode({ app, signedIn, hasLocalData }: { app: AppContextValue; signedIn: boolean; hasLocalData: boolean }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function restore() {
    setBusy(true);
    const res = await app.restoreWithCode(code);
    setBusy(false);
    setConfirming(false);
    if (!res.ok) {
      setError(res.fields.code ?? res.message);
      return;
    }
    setCode("");
    toast(res.value.nickname ? `引き継ぎました。${res.value.nickname}さんの記録です` : "引き継ぎました");
    navigate("/");
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = parseWith(TransferRedeemSchema, { code });
    if (!parsed.ok) {
      setError(parsed.fields.code ?? parsed.message);
      return;
    }
    setError(undefined);
    if (hasLocalData || signedIn) setConfirming(true);
    else void restore();
  }

  return (
    <div className="set-block">
      <h3 className="set-sub">コードを入力して引き継ぐ</h3>
      <div className="set-warn">
        <p>
          <b>この端末にいまある記録は、コードを発行したアカウントの記録に置き換わります。</b>
        </p>
        {signedIn && (
          <p>
            いまのアカウントの記録はサーバーに残りますが、この端末からは見られなくなります。残したい場合は、先にバックアップを書き出すか、この端末でも引き継ぎコードを控えておいてください。
          </p>
        )}
      </div>
      <form className="set-inline-form" onSubmit={onSubmit} noValidate>
        <TextField
          label="引き継ぎコード（8文字）"
          value={code}
          onChange={(v) => {
            setCode(v);
            if (error) setError(undefined);
          }}
          error={error}
          maxLength={32}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          placeholder="例: AB12CD34"
          className="set-codefield"
        />
        <button type="submit" className="btn" disabled={busy || code.trim() === ""} aria-busy={busy}>
          {busy ? "確認しています…" : "引き継ぐ"}
        </button>
      </form>
      <ConfirmDialog
        open={confirming}
        title="この端末の記録を置き換えますか？"
        message="この端末の記録は、コードを発行したアカウントの記録に置き換わります。この操作は取り消せません。"
        confirmLabel="置き換えて引き継ぐ"
        danger
        busy={busy}
        onConfirm={() => void restore()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}

function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** After a 401: point to recovery, offer to save what is on this device, or start over. */
function SessionRecovery({ app }: { app: AppContextValue }) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="set-warn set-block" role="note">
      <p>
        <b>この端末の記録を、サーバーで確認できませんでした。</b>
      </p>
      <p>別の端末で引き継ぎコードを発行して下に入力すると、元のアカウントに戻せます。念のため、この端末の記録を書き出しておけます。</p>
      <div className="row gap fw">
        <button
          type="button"
          className="btn"
          onClick={() => {
            try {
              downloadJson(app.localBackup(), `30days-backup-${app.today}.json`);
            } catch {
              toast("書き出せませんでした。", { tone: "error" });
            }
          }}
        >
          この端末の記録を書き出す
        </button>
        <button type="button" className="btn danger" onClick={() => setConfirming(true)}>
          新しく始める
        </button>
      </div>
      <ConfirmDialog
        open={confirming}
        title="新しく始めますか？"
        message="この端末に残っている記録と送信待ちのデータを消して、最初からにします。元に戻せません。"
        confirmLabel="新しく始める"
        danger
        onConfirm={() => {
          app.resetLocal();
          setConfirming(false);
          toast("新しく始められるようにしました");
        }}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}

// ---------- backup ----------

/** The server's copy plus anything this device has that the server has not seen yet (newest wins). */
export function mergeBackups(server: BackupFile, local: BackupFile): BackupFile {
  const byId = new Map<string, Challenge>();
  for (const c of server.challenges) byId.set(c.id, c);
  for (const c of local.challenges) {
    const s = byId.get(c.id);
    if (!s || c.updatedAt > s.updatedAt) byId.set(c.id, c);
  }
  return { ...server, challenges: [...byId.values()] };
}

async function readFileText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsText(file);
  });
}

/** Parse and validate a backup file. Returns the file or a user-facing message. */
export async function readBackupFile(file: File): Promise<{ ok: true; data: BackupFile } | { ok: false; message: string }> {
  if (file.size > MAX_BACKUP_BYTES) return { ok: false, message: "ファイルが大きすぎます（1MBまで）。" };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFileText(file));
  } catch {
    return { ok: false, message: "バックアップファイル（.json）として読めませんでした。" };
  }
  if ((raw as { format?: unknown } | null)?.format !== "thirty-days-backup") {
    return { ok: false, message: "「30日だけ」のバックアップファイルではないようです。" };
  }
  const parsed = BackupFileSchema.safeParse(raw);
  if (!parsed.success) {
    const tooMany = parsed.error.issues.some((i) => i.path[0] === "challenges" && i.path.length === 1);
    return {
      ok: false,
      message: tooMany
        ? `一度に読み込めるのは${LIMITS.importChallenges}件までです。`
        : "ファイルの中身が正しくありません。書き出したときのファイルをそのまま選んでください。",
    };
  }
  return { ok: true, data: parsed.data };
}

/** Why POST /api/me/import failed, in the words the settings screen shows. */
export function importErrorMessage(err: unknown): string {
  // Imports are serialised per account: another import (another tab, a retried tap) is running.
  if (err instanceof ApiClientError && err.status === 409) return "読み込み中です。少し待ってから、もう一度お試しください。";
  if (isQuotaLimit(err)) {
    return `バックアップの読み込みは1日${QUOTAS.importsPerUserPerDay}回までです。あすの0時（日本時間）を過ぎると、また読み込めます。`;
  }
  return `読み込めませんでした。${errorMessage(err)}`;
}

/** The toast after an import: what was read, what was left as it was, and notes left out (R14). */
export function importResultMessage(res: ImportResponse): string {
  const extra = [
    res.skipped > 0 ? `${res.skipped}件はそのままにしました` : "",
    res.notesDropped ? `長すぎるひとこと${res.notesDropped}件は読み込みませんでした` : "",
  ].filter(Boolean);
  return `${res.imported}件を読み込みました${extra.length > 0 ? `（${extra.join("。")}）` : ""}`;
}

function BackupSection({ app }: { app: AppContextValue }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pending, setPending] = useState<BackupFile | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  async function onExport() {
    setExporting(true);
    const name = `30days-backup-${app.today}.json`;
    try {
      let file: BackupFile;
      try {
        await app.flush();
        const server = await request<BackupFile>("GET", API.meExport, { auth: "optional", cache: "no-store" });
        file = mergeBackups(server, app.localBackup());
      } catch {
        file = app.localBackup();
        toast("サーバーにつながらないため、この端末にある記録を書き出しました");
      }
      downloadJson(file, name);
    } catch {
      toast("書き出せませんでした。もう一度お試しください。", { tone: "error" });
    } finally {
      setExporting(false);
    }
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // the same file can be chosen again
    if (!file) return;
    setImportError(null);
    const res = await readBackupFile(file);
    if (!res.ok) {
      setImportError(res.message);
      return;
    }
    if (res.data.challenges.length === 0) {
      setImportError("このファイルにはチャレンジが入っていません。");
      return;
    }
    setPending(res.data);
  }

  async function onImport() {
    if (!pending) return;
    setImporting(true);
    try {
      const res = await request<ImportResponse>("POST", API.meImport, { body: pending, auth: "required" });
      setPending(null);
      toast(importResultMessage(res));
      await app.refresh();
    } catch (err) {
      setPending(null);
      setImportError(importErrorMessage(err));
    } finally {
      setImporting(false);
    }
  }

  return (
    <Section id="backup" title="バックアップ" accent="mint">
      <div className="set-block">
        <h3 className="set-sub">書き出し</h3>
        <p className="note">チャレンジ・印・ひとことメモを JSON ファイルに保存します。写真は入りません。</p>
        <button type="button" className="btn" onClick={() => void onExport()} disabled={exporting} aria-busy={exporting}>
          {exporting ? "準備しています…" : "バックアップを書き出す"}
        </button>
      </div>
      <div className="set-block">
        <h3 className="set-sub">読み込み</h3>
        <p className="note">
          書き出したファイルを、いまのアカウントに追加します。同じチャレンジは、新しいほうの記録を残します。読み込んだひとことメモは、すべて「自分だけ」に戻ります。
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="sr-only"
          tabIndex={-1}
          aria-label="バックアップファイル"
          onChange={(e) => void onFile(e)}
        />
        <button type="button" className="btn" onClick={() => fileRef.current?.click()} disabled={importing}>
          ファイルを選んで読み込む
        </button>
        {importError && (
          <p className="note err" role="alert">
            {importError}
          </p>
        )}
      </div>
      <ConfirmDialog
        open={pending !== null}
        title="バックアップを読み込みますか？"
        message={`チャレンジ${pending?.challenges.length ?? 0}件を、いまのアカウントに追加します。同じチャレンジがある場合は、新しいほうの記録を残します。`}
        confirmLabel="読み込む"
        busy={importing}
        onConfirm={() => void onImport()}
        onCancel={() => setPending(null)}
      />
    </Section>
  );
}

// ---------- display ----------

const THEME_OPTIONS = [
  { value: "system", label: "端末に合わせる" },
  { value: "light", label: "ライト" },
  { value: "dark", label: "ダーク" },
] as const satisfies readonly { value: ThemePref; label: string }[];

function DisplaySection() {
  const [pref, setPref] = useThemePref();
  return (
    <Section id="display" title="表示" accent="lilac">
      <p id="theme-label" className="set-sub">
        テーマ
      </p>
      <ChipGroup labelledBy="theme-label" value={pref} options={THEME_OPTIONS} onChange={setPref} />
      <p className="note">ダークは、暗い部屋でもまぶしくない落ち着いた色です。</p>
    </Section>
  );
}

// ---------- delete everything ----------

const DELETE_WORD = "削除";

function DangerSection({ app, signedIn }: { app: AppContextValue; signedIn: boolean }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [typedError, setTypedError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setOpen(false);
    setTyped("");
    setTypedError(undefined);
    setError(null);
  }

  async function onConfirm() {
    if (typed.trim() !== DELETE_WORD) {
      setTypedError(`「${DELETE_WORD}」と入力すると削除できます`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (getToken()) {
        try {
          await request("DELETE", API.me, { auth: "optional" });
        } catch (err) {
          // 401/404: the account is already gone on the server; finish the local part.
          if (!(err instanceof ApiClientError && (err.status === 401 || err.status === 404))) throw err;
        }
      }
      await disablePush({ notifyServer: false }).catch(() => undefined);
      let photosLeft = false;
      try {
        await clearAllPhotos();
      } catch {
        photosLeft = true;
      }
      setBusy(false);
      close();
      app.resetLocal();
      navigate("/");
      toast(
        photosLeft
          ? "データを削除しました。写真の一部が残っているかもしれません。ブラウザの設定からサイトのデータを消してください。"
          : "すべてのデータを削除しました",
      );
    } catch (err) {
      setBusy(false);
      setError(`削除できませんでした。${errorMessage(err)}`);
    }
  }

  return (
    <Section id="danger" title="データ削除" accent="shu">
      <p>
        アカウント、チャレンジと印、ひとことメモ、投稿したレシピと体験談、公開リンク、通知の登録をサーバーから削除し、この端末の記録と写真も消します。
        <b>元に戻せません。</b>
      </p>
      {!signedIn && app.sessionInvalid && (
        <p className="note">サーバーの記録は、この端末からは消せません。引き継ぎコードで元に戻してから削除してください。</p>
      )}
      <button type="button" className="btn danger" onClick={() => setOpen(true)}>
        すべてのデータを削除
      </button>
      <ConfirmDialog
        open={open}
        title="すべてのデータを削除しますか？"
        message={
          <>
            <p>削除すると元に戻せません。必要なら、先にバックアップを書き出してください。</p>
            <TextField
              label={`確認のため「${DELETE_WORD}」と入力してください`}
              value={typed}
              onChange={(v) => {
                setTyped(v);
                if (typedError) setTypedError(undefined);
              }}
              error={typedError}
              autoComplete="off"
              disabled={busy}
            />
            {error && (
              <p className="note err" role="alert">
                {error}
              </p>
            )}
          </>
        }
        confirmLabel={busy ? "削除しています…" : "削除する"}
        danger
        busy={busy}
        onConfirm={() => void onConfirm()}
        onCancel={close}
      />
    </Section>
  );
}

// ---------- links ----------

function LinksSection() {
  return (
    <section className="set-links-wrap" aria-labelledby="links-title">
      <h2 id="links-title" className="sr-only">
        このサービスについて
      </h2>
      <ul className="set-links">
        <li>
          <Link to="/about">このサービスについて</Link>
        </li>
        <li>
          <Link to="/terms">利用規約</Link>
        </li>
        <li>
          <Link to="/privacy">プライバシーポリシー</Link>
        </li>
        <li>
          <Link to="/contact">お問い合わせ</Link>
        </li>
      </ul>
      <p className="note set-version">30日だけ バージョン {APP_VERSION}</p>
    </section>
  );
}
