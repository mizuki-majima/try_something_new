/**
 * App state outside React: the signed-in user and their challenges, cached on the device and kept
 * in sync with the API through the outbox.
 *
 * What the UI sees is always derived: view = applyPending(base, outbox), where `base` is the
 * last state confirmed by the server. Confirmed sends move into `base`; a dropped (4xx) op simply
 * disappears from the queue, which rolls the view back immediately, and a refetch follows.
 */
import {
  API,
  ChallengeCreateSchema,
  ChallengePatchSchema,
  LIMITS,
  MePatchSchema,
  NicknameSchema,
  QUOTAS,
  ReflectSchema,
  StampPutSchema,
  TOTAL_DAYS,
  isValidTimeZone,
  newId,
  nextFirst,
  todayIn,
  type BackupFile,
  type Challenge,
  type ChallengeListResponse,
  type ChallengeResponse,
  type MeResponse,
  type NoteVisibility,
  type User,
  type Verdict,
} from "@thirty/shared";
import { ApiClientError, errorMessage, isQuotaLimit, request } from "./api";
import { isOpen, viewChallenge } from "./challenge";
import {
  applyOp,
  applyPending,
  drain,
  enqueue,
  hasPendingFor,
  hasPendingMe,
  isLongRateLimit,
  opRequest,
  retryDelayMs,
  targetOf,
  type DrainResult,
  type LocalState,
  type MePatchBody,
  type OutboxItem,
  type OutboxOp,
} from "./outbox";
import { NOTE_SHOW_ERRORS, noteShowErrorMessage, notShowableReason } from "./noteShare";
import { clearAllPhotos } from "./photos";
import { invalidateRecipes } from "./recipes";
import {
  clearSession,
  deviceTimeZone,
  ensureSession,
  getToken,
  isSessionInvalid,
  redeemTransfer,
  subscribeSession,
  subscribeSessionCreated,
} from "./session";
import { KEYS, readJson, writeJson } from "./storage";
import { clearRecipeCaches } from "./swCaches";
import { fail, ok, parseWith, type ActionResult, type Failure } from "./validation";

/** SPEC "Error Handling" 429: shown when a queued write is refused until the quota resets. */
export const RATE_LIMIT_NOTICE = "今日はここまで（あすの0時にリセット）";

/**
 * Shown when the profile quota refused a change (toast, Settings, and updateMe's own refusal).
 * PATCH /api/me is limited per JST day for a rename or turning 「みんなに表示」 on, because each
 * rewrites the user's public records (QUOTAS.profileChangesPerUserPerDay, R1). Turning it off is a
 * privacy action the API never counts or refuses (R13).
 */
export const PROFILE_LIMIT_MESSAGE = `ニックネームの変更と「みんなに表示」をオンにするのは1日${QUOTAS.profileChangesPerUserPerDay}回までです。あすの0時（日本時間）を過ぎると、また変えられます。オフにするのはいつでもできます。`;

/** Band reason when the server asked us to wait without saying why in its own words. */
export const BUSY_REASON = "混み合っています。";

/**
 * - waiting: online, the server asked us to wait (a 429 that clears soon); writes stay queued and
 *   are sent automatically (Layout shows when, SPEC "Error Handling" 429)
 */
export type SyncStatus = "synced" | "pending" | "waiting" | "offline" | "error";

/** The server asked us to wait: when sending resumes (ms) and what to tell the user. */
export type Throttle = { until: number; reason: string };

export type AppSnapshot = {
  /** null until the anonymous account exists (it is created by the first write). */
  user: User | null;
  /** Nickname typed before the account existed; sent when the account is created. */
  pendingNickname: string | null;
  challenges: Challenge[];
  /** The user's time zone (server profile, else the device). */
  tz: string;
  /** Today's date in `tz` (YYYY-MM-DD). Updates after midnight. */
  today: string;
  /** True once this page load has fetched from the server, or when there is nothing to fetch. */
  ready: boolean;
  refreshing: boolean;
  online: boolean;
  hasSession: boolean;
  /** The server rejected the token (401). The UI should offer restore-by-code or start-over. */
  sessionInvalid: boolean;
  /** Writes waiting in the outbox. */
  pending: number;
  /**
   * Day notes (`<challengeId>#<day>`) the server still shows in 「みんな」 although this device has
   * already made them private (#17): the edit, cleared note, undone stamp or 「みんなに表示」 turned off
   * that does it is still queued (offline, or waiting to retry). Also a note the server will show on
   * the way: 「みんなに表示」 turned on is queued before the edit. The screen must not say they are
   * private yet.
   */
  stillShown: readonly string[];
  syncStatus: SyncStatus;
  lastSyncError: string | null;
  lastSyncedAt: number | null;
  /** The most recent stamp pressed in this tab, for the stamp animation. */
  lastStamped: { challengeId: string; day: number; at: number } | null;
  /** Set while syncStatus is "waiting" (a 429 on the queue or on creating the account). */
  throttle: Throttle | null;
  /**
   * Until when (ms) the API refuses nickname / 「みんなに表示」 changes (the daily profile quota).
   * Null when not limited; it goes back to null by itself when the quota resets.
   */
  profileLimitedUntil: number | null;
};

export type StartChallengeInput = {
  title: string;
  seal: string;
  startDate: string;
  recipeId?: string | null;
  /** Nickname from the start sheet (CUF-1); applied to the account. */
  nickname?: string;
};

export type AppActions = {
  startChallenge(input: StartChallengeInput): ActionResult<Challenge>;
  stamp(challengeId: string, day: number, note?: string): ActionResult;
  unstamp(challengeId: string, day: number): ActionResult;
  setNote(challengeId: string, day: number, note: string): ActionResult;
  reflect(challengeId: string, verdict: Verdict, reflection?: string): ActionResult;
  updateChallenge(challengeId: string, patch: { title?: string; seal?: string; startDate?: string }): ActionResult;
  deleteChallenge(challengeId: string): ActionResult;
  updateMe(patch: MePatchBody): ActionResult;
  /**
   * Show the day's note in 「みんな」, or make it private again (#17). Online only and never optimistic:
   * to show, queued writes for the challenge are sent first (making it private never waits for them),
   * and the view changes when the server confirms.
   * `seen` is the text the owner confirmed: showing is refused when the saved note is another one.
   * Works on reflected challenges too.
   */
  setNoteShown(challengeId: string, day: number, show: boolean, seen?: string): Promise<ActionResult>;
  /**
   * After a write that makes a shown note private (#17): setNote saved another text, or unstamp. Send
   * the queue now, then say where the note stands. "private": nothing shows the old text any more;
   * "queued": the write still waits to be sent (offline, or a retry) and the server still shows the
   * old text (AppSnapshot.stillShown); "kept": the write was refused and the note is shown as before
   * (the queue's own notice says why).
   * `withdraw` (an undone stamp: the owner chose to remove the note): while the server still shows it
   * and the device is online, also make it private at once (setNoteShown, beside the queue), so a
   * write stuck in a retry does not keep it public.
   */
  afterShownNoteEdit(challengeId: string, day: number, opts?: { withdraw?: boolean }): Promise<"private" | "queued" | "kept">;
  /** Refetch user + challenges from the server (no-op without a session or offline). */
  refresh(): Promise<void>;
  /** Send queued writes now. Await this before calls that need them on the server (e.g. creating a share link). */
  flush(): Promise<void>;
  /** Restore the account on this device with a transfer code (FR-2). */
  restoreWithCode(code: string): Promise<ActionResult<User>>;
  /**
   * Forget everything on this device: token, cached state, queued writes, day photos and cached
   * recipe responses (after "delete all data", or 「新しく始める」 after a 401).
   */
  resetLocal(): void;
  /** Local data as a backup file (works offline and after a 401). */
  localBackup(): BackupFile;
};

export type Notice = { kind: "info" | "error"; message: string };

export type AppStore = {
  getSnapshot(): AppSnapshot;
  subscribe(listener: () => void): () => void;
  onNotice(listener: (n: Notice) => void): () => void;
  actions: AppActions;
  /** Attach browser listeners and timers and do the first sync. Returns a cleanup. */
  start(): () => void;
};

type Persisted = { v: 1; base: LocalState; pendingNickname: string | null };

const EMPTY: LocalState = { user: null, challenges: [] };
const NONE: readonly string[] = [];
const REFRESH_STALE_MS = 60_000;
const TODAY_TICK_MS = 30_000;
const LOCK_NAME = "thirty-days-outbox";

function isChallengeLike(c: unknown): c is Challenge {
  const o = c as Challenge | null;
  return !!o && typeof o.id === "string" && typeof o.startDate === "string" && !!o.stamps && typeof o.stamps === "object";
}

function loadPersisted(): Persisted {
  const raw = readJson<Partial<Persisted>>(KEYS.state);
  if (!raw || raw.v !== 1 || !raw.base || !Array.isArray(raw.base.challenges)) {
    return { v: 1, base: EMPTY, pendingNickname: null };
  }
  return {
    v: 1,
    base: { user: raw.base.user ?? null, challenges: raw.base.challenges.filter(isChallengeLike) },
    pendingNickname: typeof raw.pendingNickname === "string" ? raw.pendingNickname : null,
  };
}

function loadOutbox(): OutboxItem[] {
  const raw = readJson<OutboxItem[]>(KEYS.outbox);
  if (!Array.isArray(raw)) return [];
  return raw.filter((i) => i && typeof i.key === "string" && i.op && typeof i.op.kind === "string");
}

function hasResponseChallenge(r: unknown): r is { challenge: Challenge } {
  return !!r && typeof r === "object" && isChallengeLike((r as { challenge?: unknown }).challenge);
}

function hasResponseUser(r: unknown): r is { user: User } {
  const u = (r as { user?: User } | null)?.user;
  return !!u && typeof u === "object" && typeof u.id === "string";
}

function browserOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/**
 * A me.patch the profile quota counts and may refuse: a rename or turning 「みんなに表示」 on. One that
 * turns it off is never refused, even with a rename merged in by the queue (R13).
 */
function isProfileChange(op: OutboxOp | undefined): boolean {
  if (op?.kind !== "me.patch" || op.body.shareProgress === false) return false;
  return op.body.nickname !== undefined || op.body.shareProgress === true;
}

function withPeriod(text: string): string {
  return /[。．.!！?？]$/.test(text) ? text : `${text}。`;
}

/** What the band says while we wait after a 429 (see Throttle). */
function throttleReason(err: unknown, creatingAccount: boolean): string {
  // The API's own words for this write's quota (e.g. 「今日はここまでです。日本時間の0時を過ぎると…」).
  if (!creatingAccount && isQuotaLimit(err)) return withPeriod((err as ApiClientError).message);
  // New accounts are limited per network and overall, and the edge throttles everyone: both clear soon.
  return BUSY_REASON;
}

/** The toast for a write dropped by a lasting 429 (isLongRateLimit). */
function limitNotice(op: OutboxOp, err: unknown): string {
  if (!isQuotaLimit(err)) return `保存できませんでした。${errorMessage(err)}`;
  if (op.kind === "challenge.create") return `${RATE_LIMIT_NOTICE}。新しく始められるのは1日${QUOTAS.challengesPerUserPerDay}件までです。`;
  if (isProfileChange(op)) return `${RATE_LIMIT_NOTICE}。${PROFILE_LIMIT_MESSAGE}`;
  return `${RATE_LIMIT_NOTICE}。この変更は保存できませんでした。`;
}

export function createAppStore(): AppStore {
  const persisted = loadPersisted();
  let base: LocalState = persisted.base;
  let pendingNickname: string | null = persisted.pendingNickname;
  let view: LocalState = applyPending(base, loadOutbox());
  let pending = loadOutbox().length;

  let online = browserOnline();
  let ready = !getToken();
  let refreshing: Promise<void> | null = null;
  let lastRefreshAt = 0;
  let lastDrain: DrainResult["status"] = "empty";
  // The last retry was a 429 that clears soon: the device is online, the server asked us to wait.
  let throttle: Throttle | null = null;
  // Set while the profile quota refuses changes; cleared by a timer when it resets.
  let profileLimitedUntil: number | null = null;
  let profileLimitTimer: ReturnType<typeof setTimeout> | undefined;
  // Failed attempts to create the account, for its backoff.
  let sessionAttempts = 0;
  let lastSyncError: string | null = null;
  let lastSyncedAt: number | null = null;
  let lastStamped: AppSnapshot["lastStamped"] = null;
  // Ids (or "@me") confirmed by the server while a refresh was in flight: keep our newer copy.
  let touched: Set<string> | null = null;

  let draining: Promise<void> | null = null;
  let drainAgain = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const listeners = new Set<() => void>();
  const noticeListeners = new Set<(n: Notice) => void>();

  const tz = () => (view.user?.tz && isValidTimeZone(view.user.tz) ? view.user.tz : deviceTimeZone());
  let today = todayIn(tz());

  /**
   * AppSnapshot.stillShown: seen in 「みんな」 in the server's copy (base) or on the way while the queue
   * is sent in order (「みんなに表示」 turned on goes out before an edit queued after it), and no longer
   * in the view.
   */
  function stillShown(): readonly string[] {
    // No write adds `shown`: only a note shown in base can be seen on the way.
    if (pending === 0 || !base.challenges.some((c) => Object.values(c.stamps).some((s) => s.shown === true))) return NONE;
    const seen = (s: LocalState) =>
      s.user?.shareProgress === false
        ? []
        : s.challenges.flatMap((c) => Object.entries(c.stamps).flatMap(([day, st]) => (st.shown === true ? [`${c.id}#${day}`] : [])));
    const keys = new Set<string>();
    let s = base;
    for (const item of loadOutbox()) {
      for (const key of seen(s)) keys.add(key);
      s = applyOp(s, item.op, item.at);
    }
    for (const key of seen(view)) keys.delete(key);
    return keys.size > 0 ? [...keys] : NONE;
  }

  function syncStatus(): SyncStatus {
    if (isSessionInvalid()) return "error";
    if (!online) return "offline";
    if (pending === 0) return "synced";
    if (throttle) return "waiting";
    return lastDrain === "retry" ? "offline" : "pending";
  }

  function build(): AppSnapshot {
    return {
      user: view.user,
      pendingNickname,
      challenges: view.challenges,
      tz: tz(),
      today,
      ready,
      refreshing: refreshing !== null,
      online,
      hasSession: getToken() !== null,
      sessionInvalid: isSessionInvalid(),
      pending,
      stillShown: stillShown(),
      syncStatus: syncStatus(),
      lastSyncError,
      lastSyncedAt,
      lastStamped,
      throttle: pending > 0 ? throttle : null,
      profileLimitedUntil,
    };
  }

  let snapshot = build();

  function emit(): void {
    today = todayIn(tz());
    snapshot = build();
    for (const l of [...listeners]) l();
  }

  function notice(n: Notice): void {
    for (const l of [...noticeListeners]) l(n);
  }

  function persist(): void {
    writeJson(KEYS.state, { v: 1, base, pendingNickname } satisfies Persisted);
  }

  function saveOutbox(items: OutboxItem[]): void {
    writeJson(KEYS.outbox, items);
    pending = items.length;
  }

  /** Recompute the view from base + queue and notify. */
  function recompute(): void {
    const items = loadOutbox();
    pending = items.length;
    view = applyPending(base, items);
    emit();
  }

  function mutate(op: OutboxOp): void {
    saveOutbox(enqueue(loadOutbox(), op, Date.now(), newId()));
    recompute();
    scheduleFlush();
  }

  function findOpen(challengeId: string): Challenge | Failure {
    const c = view.challenges.find((x) => x.id === challengeId);
    if (!c) return fail("チャレンジが見つかりませんでした。");
    if (c.status === "done") return fail("振り返り済みのチャレンジは変更できません。");
    return c;
  }

  // ---------- syncing ----------

  function scheduleFlush(): void {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => void flush(), 0);
  }

  function scheduleRetry(ms: number): void {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => void flush(), ms);
  }

  async function withLock<T>(fn: () => Promise<T>): Promise<T | null> {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!locks?.request) return fn();
    // Another tab draining the same queue → let it; we look again shortly.
    return locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => (lock ? fn() : null));
  }

  /**
   * The anonymous account now exists: take its user and queue what waited for it (the nickname
   * typed before). Runs for the store's own POST /api/session and for one made by any other
   * request (session.ts subscribeSessionCreated), so it is safe to call twice.
   */
  function onSessionCreated(user: User): void {
    sessionAttempts = 0;
    base = { ...base, user: base.user?.id === user.id ? { ...base.user, ...user } : user };
    const nick = pendingNickname;
    pendingNickname = null;
    if (nick && user.nickname !== nick) {
      saveOutbox(enqueue(loadOutbox(), { kind: "me.patch", body: { nickname: nick } }, Date.now(), newId()));
    }
    ready = true;
    persist();
    recompute();
  }

  function clearProfileLimit(): void {
    clearTimeout(profileLimitTimer);
    profileLimitedUntil = null;
  }

  /** The profile quota refused a nickname / 「みんなに表示」 change: remember until when (R1). */
  function noteProfileLimit(op: OutboxOp | undefined, err: unknown): void {
    if (!isProfileChange(op) || !isQuotaLimit(err)) return;
    // The API sends the seconds until 0:00 JST; setTimeout cannot wait longer than ~24.8 days.
    const ms = Math.min(((err as ApiClientError).retryAfter ?? 60) * 1000, 2 ** 31 - 1);
    clearTimeout(profileLimitTimer);
    profileLimitedUntil = Date.now() + ms;
    profileLimitTimer = setTimeout(() => {
      profileLimitedUntil = null;
      emit();
    }, ms);
  }

  /**
   * Take the server's copy of a challenge into base: the response to a sent write. A refresh in
   * flight keeps it (`touched`) instead of an older list.
   */
  function acceptServerChallenge(c: Challenge): void {
    if (touched) touched.add(c.id);
    const exists = base.challenges.some((x) => x.id === c.id);
    base = { ...base, challenges: exists ? base.challenges.map((x) => (x.id === c.id ? c : x)) : [...base.challenges, c] };
  }

  /**
   * Take the answer to a note visibility change into base: only that day's `shown`. The rest of the
   * server's copy can be older than base's (a stamp PUT sent beside it may be answered first), and
   * taking all of it would bring an old note back. Shown only for the text base has: a newer text
   * there was made private by the server.
   */
  function acceptShown(c: Challenge, day: number): void {
    const mine = base.challenges.find((x) => x.id === c.id);
    if (!mine) {
      acceptServerChallenge(c);
      return;
    }
    if (touched) touched.add(c.id);
    const key = String(day);
    const prev = mine.stamps[key];
    if (!prev) return;
    const server = c.stamps[key];
    const shown = server?.shown === true && server.note === prev.note;
    const stamp = { at: prev.at, ...(prev.note ? { note: prev.note } : {}), ...(shown ? { shown: true } : {}) };
    base = { ...base, challenges: base.challenges.map((x) => (x === mine ? { ...x, stamps: { ...x.stamps, [key]: stamp } } : x)) };
  }

  function onSent(item: OutboxItem, response: unknown): void {
    if (touched) touched.add(targetOf(item.op) ?? "@me");
    if (isProfileChange(item.op)) clearProfileLimit();
    base = applyOp(base, item.op, item.at);
    if (hasResponseChallenge(response)) acceptServerChallenge(response.challenge);
    if (item.op.kind === "me.patch" && hasResponseUser(response)) base = { ...base, user: response.user };
    persist();
  }

  function onDropped(item: OutboxItem, error: unknown): void {
    if (isLongRateLimit(error)) {
      noteProfileLimit(item.op, error);
      notice({ kind: "error", message: limitNotice(item.op, error) });
      return;
    }
    notice({ kind: "error", message: `保存できませんでした。${errorMessage(error)}` });
  }

  async function drainOnce(): Promise<void> {
    clearTimeout(retryTimer);
    online = browserOnline();
    if (!online || isSessionInvalid() || loadOutbox().length === 0) {
      if (loadOutbox().length === 0) {
        lastDrain = "empty";
        throttle = null;
      }
      return;
    }
    if (!getToken()) {
      try {
        const s = await ensureSession(pendingNickname ?? undefined);
        if (s.user) onSessionCreated(s.user);
      } catch (err) {
        lastSyncError = errorMessage(err);
        if (err instanceof ApiClientError && err.status === 401) {
          lastDrain = "auth";
        } else {
          // Growing backoff, and the server's Retry-After on a 429: new accounts are limited per
          // network per hour and overall. The writes stay queued; the band says when we resume.
          sessionAttempts++;
          lastDrain = "retry";
          const delay = retryDelayMs(sessionAttempts + 1, err);
          throttle = err instanceof ApiClientError && err.status === 429 ? { until: Date.now() + delay, reason: throttleReason(err, true) } : null;
          scheduleRetry(delay);
        }
        return;
      }
    }
    const result = await withLock(() =>
      drain({
        load: loadOutbox,
        save: saveOutbox,
        send: (item) => {
          const { method, path, body } = opRequest(item.op);
          return request(method, path, { body, auth: "required" });
        },
        onSent,
        onDropped,
      }),
    );
    if (!result) {
      scheduleRetry(3_000);
      return;
    }
    lastDrain = result.status;
    throttle = null;
    if (result.status === "empty") {
      lastSyncError = null;
      lastSyncedAt = Date.now();
    } else {
      lastSyncError = errorMessage(result.error);
      if (result.status === "retry") {
        const delay = retryDelayMs(result.attempts, result.error);
        if (result.error instanceof ApiClientError && result.error.status === 429) {
          throttle = { until: Date.now() + delay, reason: throttleReason(result.error, false) };
          noteProfileLimit(loadOutbox()[0]?.op, result.error);
        }
        scheduleRetry(delay);
      }
    }
    if (result.dropped > 0) void refresh();
  }

  function flush(): Promise<void> {
    if (draining) {
      drainAgain = true;
      return draining;
    }
    const run = (async () => {
      try {
        do {
          drainAgain = false;
          await drainOnce();
          recompute();
        } while (drainAgain);
      } finally {
        draining = null;
        emit();
      }
    })();
    draining = run;
    return run;
  }

  function refresh(): Promise<void> {
    if (refreshing) return refreshing;
    if (!getToken() || !browserOnline()) {
      ready = true;
      emit();
      return Promise.resolve();
    }
    touched = new Set();
    const run = (async () => {
      try {
        const [me, list] = await Promise.all([
          request<MeResponse>("GET", API.me),
          request<ChallengeListResponse>("GET", API.challenges),
        ]);
        const keep = touched ?? new Set<string>();
        const fromServer = list.challenges.filter((c) => !keep.has(c.id));
        const kept = base.challenges.filter((c) => keep.has(c.id));
        base = {
          user: keep.has("@me") && base.user ? base.user : me.user,
          challenges: [...fromServer, ...kept],
        };
        lastRefreshAt = Date.now();
        lastSyncedAt = lastRefreshAt;
        persist();
      } catch (err) {
        // Cached data stays on screen; a 401 has already flagged the session.
        if (!(err instanceof ApiClientError && err.status === 401)) lastSyncError = errorMessage(err);
      } finally {
        touched = null;
        refreshing = null;
        ready = true;
        recompute();
      }
    })();
    refreshing = run;
    emit();
    return run;
  }

  // ---------- actions ----------

  const actions: AppActions = {
    startChallenge(input) {
      if (view.challenges.filter(isOpen).length >= LIMITS.openChallenges) {
        return fail(`同時に進められるのは${LIMITS.openChallenges}件までです。どれかを振り返るか、削除してから始めてください。`);
      }
      if (input.startDate !== today && input.startDate !== nextFirst(today)) {
        return fail("開始日は「今日」か「次の1日」から選んでください。", { startDate: "開始日を選んでください" });
      }
      const parsed = parseWith(ChallengeCreateSchema, {
        id: newId(),
        recipeId: input.recipeId ?? null,
        title: input.title,
        seal: input.seal,
        startDate: input.startDate,
      });
      if (!parsed.ok) return parsed;

      const nickInput = input.nickname?.trim();
      if (nickInput) {
        const nick = parseWith(NicknameSchema, nickInput);
        if (!nick.ok) return fail(nick.message, { nickname: nick.message });
        if (!getToken()) {
          pendingNickname = nick.data;
          persist();
        } else if (view.user?.nickname !== nick.data) {
          saveOutbox(enqueue(loadOutbox(), { kind: "me.patch", body: { nickname: nick.data } }, Date.now(), newId()));
        }
      }
      mutate({ kind: "challenge.create", body: parsed.data });
      const created = view.challenges.find((c) => c.id === parsed.data.id);
      return created ? ok(created) : fail("開始できませんでした。");
    },

    stamp(challengeId, day, note) {
      const c = findOpen(challengeId);
      if ("ok" in c) return c;
      const v = viewChallenge(c, today);
      if (v.phase === "waiting") return fail("まだ始まっていません。");
      if (!Number.isInteger(day) || day < 1 || day > TOTAL_DAYS) return fail("日付が正しくありません。");
      if (day > v.maxDay) return fail("まだ先の日です。");
      let body: { note?: string } = {};
      if (note !== undefined) {
        const parsed = parseWith(StampPutSchema, { note });
        if (!parsed.ok) return parsed;
        body = parsed.data;
      }
      if (!c.stamps[String(day)]) lastStamped = { challengeId, day, at: Date.now() };
      mutate({ kind: "stamp.put", id: challengeId, day, body });
      return ok();
    },

    unstamp(challengeId, day) {
      const c = findOpen(challengeId);
      if ("ok" in c) return c;
      if (!c.stamps[String(day)]) return ok();
      if (lastStamped?.challengeId === challengeId && lastStamped.day === day) lastStamped = null;
      mutate({ kind: "stamp.delete", id: challengeId, day });
      return ok();
    },

    setNote(challengeId, day, note) {
      const c = findOpen(challengeId);
      if ("ok" in c) return c;
      if (!c.stamps[String(day)]) return fail("印を押した日にだけ、ひとことを残せます。");
      const parsed = parseWith(StampPutSchema, { note });
      if (!parsed.ok) return parsed;
      if ((c.stamps[String(day)]?.note ?? "") === (parsed.data.note ?? "")) return ok();
      mutate({ kind: "stamp.put", id: challengeId, day, body: { note: parsed.data.note ?? "" } });
      return ok();
    },

    reflect(challengeId, verdict, reflection) {
      // A finished challenge may change its verdict / ひとこと later (the API keeps the record closed).
      const done = view.challenges.find((x) => x.id === challengeId && x.status === "done");
      const c = done ?? findOpen(challengeId);
      if ("ok" in c) return c;
      const v = viewChallenge(c, today);
      if (!done && !v.canReflect) return fail("振り返りは7日目からできます。");
      const parsed = parseWith(ReflectSchema, reflection === undefined ? { verdict } : { verdict, reflection });
      if (!parsed.ok) return parsed;
      const finishedDay = done ? (done.finishedDay ?? TOTAL_DAYS) : Math.max(1, Math.min(v.day, TOTAL_DAYS));
      mutate({ kind: "challenge.reflect", id: challengeId, body: parsed.data, finishedDay });
      return ok();
    },

    updateChallenge(challengeId, patch) {
      const c = findOpen(challengeId);
      if ("ok" in c) return c;
      const parsed = parseWith(ChallengePatchSchema, patch);
      if (!parsed.ok) return parsed;
      if (parsed.data.startDate !== undefined) {
        if (viewChallenge(c, today).phase !== "waiting") return fail("始まったチャレンジの開始日は変えられません。");
        if (parsed.data.startDate < today) return fail("開始日は今日以降にしてください。", { startDate: "今日以降の日付にしてください" });
      }
      mutate({ kind: "challenge.patch", id: challengeId, body: parsed.data });
      return ok();
    },

    deleteChallenge(challengeId) {
      if (!view.challenges.some((c) => c.id === challengeId)) return fail("チャレンジが見つかりませんでした。");
      if (lastStamped?.challengeId === challengeId) lastStamped = null;
      mutate({ kind: "challenge.delete", id: challengeId });
      return ok();
    },

    updateMe(patch) {
      const parsed = parseWith(MePatchSchema, patch);
      if (!parsed.ok) return parsed;
      if (profileLimitedUntil !== null && isProfileChange({ kind: "me.patch", body: parsed.data })) {
        // The API would refuse it until the quota resets: say so now instead of rolling back later.
        return fail(PROFILE_LIMIT_MESSAGE, parsed.data.nickname !== undefined ? { nickname: PROFILE_LIMIT_MESSAGE } : {});
      }
      if (!getToken() && parsed.data.nickname !== undefined) {
        pendingNickname = parsed.data.nickname;
        persist();
      }
      mutate({ kind: "me.patch", body: parsed.data });
      return ok();
    },

    async setNoteShown(challengeId, day, show, seen) {
      // From the view, not findOpen: a reflected challenge can still show or hide its notes.
      const find = () => view.challenges.find((x) => x.id === challengeId);
      const c = find();
      if (!c) return fail("チャレンジが見つかりませんでした。");
      if (show) {
        const reason = notShowableReason(c.stamps[String(day)]?.note ?? "");
        if (reason) return fail(reason);
        if (view.user?.shareProgress === false) return fail(NOTE_SHOW_ERRORS.progressOff);
      }
      if (!browserOnline()) return fail(NOTE_SHOW_ERRORS.offline);
      // To show, the server must already hold what the owner sees: the challenge, a note saved a
      // moment ago and 「みんなに表示」 turned on. Stopping waits for nothing (a write stuck in the queue
      // must not keep a note public): a queued write sent after it cannot show the note again (the API
      // checks), so the order does not matter.
      const waiting = () => {
        const items = loadOutbox();
        return hasPendingFor(items, challengeId) || hasPendingMe(items);
      };
      if (show && waiting()) {
        await flush();
        if (waiting()) return fail(NOTE_SHOW_ERRORS.pending);
      }
      let body: NoteVisibility = { show: false };
      if (show) {
        // The server's copy now (nothing is queued for it): the API refuses any other text.
        const note = find()?.stamps[String(day)]?.note ?? "";
        if (!note) return fail(NOTE_SHOW_ERRORS.noteMissing);
        if (seen !== undefined && note !== seen) return fail(NOTE_SHOW_ERRORS.noteChanged);
        body = { show: true, note };
      }
      try {
        const res = await request<ChallengeResponse>("PUT", API.noteVisibility(challengeId, day), { body, auth: "required" });
        if (!hasResponseChallenge(res) || res.challenge.id !== challengeId) return fail(NOTE_SHOW_ERRORS.unavailable);
        acceptShown(res.challenge, day);
        persist();
        recompute();
        return ok();
      } catch (err) {
        // This device may be behind (the note changed elsewhere, progress turned off): catch up.
        if (err instanceof ApiClientError && [400, 404, 409].includes(err.status)) void refresh();
        return fail(noteShowErrorMessage(err));
      }
    },

    async afterShownNoteEdit(challengeId, day, { withdraw = false } = {}) {
      const key = `${challengeId}#${day}`;
      // Taking it back skips the queue; the API answers even when the undone stamp arrives first.
      const hide = withdraw && browserOnline() && stillShown().includes(key) ? actions.setNoteShown(challengeId, day, false) : null;
      await Promise.all([flush(), hide]);
      if (stillShown().includes(key)) return "queued";
      return view.challenges.find((x) => x.id === challengeId)?.stamps[String(day)]?.shown === true ? "kept" : "private";
    },

    refresh,
    flush,

    async restoreWithCode(code) {
      try {
        const res = await redeemTransfer(code);
        const sameAccount = !base.user || base.user.id === res.user.id;
        if (!sameAccount) {
          // The queue, cache and day photos belonged to another account on this device.
          saveOutbox([]);
          base = { user: res.user, challenges: [] };
          lastStamped = null;
          void clearAllPhotos().catch(() => undefined); // best effort, in the background
        } else {
          base = { ...base, user: res.user };
        }
        pendingNickname = null;
        sessionAttempts = 0;
        throttle = null;
        clearProfileLimit();
        persist();
        recompute();
        // Cached recipe responses carry the previous token's isMine.
        await clearRecipeCaches();
        invalidateRecipes();
        await refresh();
        void flush();
        return ok(res.user);
      } catch (err) {
        const fields = err instanceof ApiClientError && err.fields ? err.fields : {};
        return fail(errorMessage(err), fields);
      }
    },

    resetLocal() {
      clearTimeout(retryTimer);
      clearSession();
      saveOutbox([]);
      base = EMPTY;
      pendingNickname = null;
      lastStamped = null;
      lastSyncError = null;
      lastDrain = "empty";
      throttle = null;
      clearProfileLimit();
      sessionAttempts = 0;
      ready = true;
      persist();
      recompute();
      // Nothing of the previous account may stay on the device: its day photos (IndexedDB) and the
      // recipe responses the service worker cached for its token. Best effort, in the background.
      void clearAllPhotos().catch(() => undefined);
      void clearRecipeCaches().then(invalidateRecipes);
    },

    localBackup() {
      const u = view.user;
      return {
        format: "thirty-days-backup",
        version: 1,
        exportedAt: Date.now(),
        user: {
          nickname: u?.nickname ?? pendingNickname ?? "",
          shareProgress: u?.shareProgress ?? true,
          reminder: u?.reminder ?? { enabled: false, time: "21:00" },
        },
        challenges: view.challenges,
      };
    },
  };

  // ---------- lifecycle ----------

  function start(): () => void {
    if (typeof window === "undefined") return () => {};
    const onOnline = () => {
      online = true;
      emit();
      void flush();
      if (Date.now() - lastRefreshAt > REFRESH_STALE_MS) void refresh();
    };
    const onOffline = () => {
      online = false;
      emit();
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      emit(); // re-evaluates today
      void flush();
      if (Date.now() - lastRefreshAt > REFRESH_STALE_MS) void refresh();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEYS.state || e.key === null) {
        const p = loadPersisted();
        base = p.base;
        pendingNickname = p.pendingNickname;
      }
      if (e.key === KEYS.token && e.newValue) void refresh();
      recompute();
    };
    const tick = setInterval(() => {
      const t = todayIn(tz());
      if (t !== today) emit();
    }, TODAY_TICK_MS);
    const unsubSession = subscribeSession(emit);
    // The account may be created by any request (a cheer, a report, a post), not only by our
    // queue: take the user and send what waited for it (the nickname, queued writes).
    const unsubCreated = subscribeSessionCreated(({ user }) => {
      onSessionCreated(user);
      void flush();
    });

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    void refresh().then(() => flush());

    return () => {
      clearInterval(tick);
      clearTimeout(retryTimer);
      clearTimeout(flushTimer);
      clearTimeout(profileLimitTimer);
      unsubSession();
      unsubCreated();
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onNotice(listener) {
      noticeListeners.add(listener);
      return () => noticeListeners.delete(listener);
    },
    actions,
    start,
  };
}
