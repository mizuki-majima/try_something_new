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
  type MeResponse,
  type User,
  type Verdict,
} from "@thirty/shared";
import { ApiClientError, errorMessage, request } from "./api";
import { isOpen, viewChallenge } from "./challenge";
import {
  applyOp,
  applyPending,
  backoffMs,
  drain,
  enqueue,
  opRequest,
  targetOf,
  type DrainResult,
  type LocalState,
  type MePatchBody,
  type OutboxItem,
  type OutboxOp,
} from "./outbox";
import { clearSession, deviceTimeZone, ensureSession, getToken, isSessionInvalid, redeemTransfer, subscribeSession } from "./session";
import { KEYS, readJson, writeJson } from "./storage";
import { fail, ok, parseWith, type ActionResult, type Failure } from "./validation";

export type SyncStatus = "synced" | "pending" | "offline" | "error";

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
  syncStatus: SyncStatus;
  lastSyncError: string | null;
  lastSyncedAt: number | null;
  /** The most recent stamp pressed in this tab, for the stamp animation. */
  lastStamped: { challengeId: string; day: number; at: number } | null;
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
  /** Refetch user + challenges from the server (no-op without a session or offline). */
  refresh(): Promise<void>;
  /** Send queued writes now. Await this before calls that need them on the server (e.g. creating a share link). */
  flush(): Promise<void>;
  /** Restore the account on this device with a transfer code (FR-2). */
  restoreWithCode(code: string): Promise<ActionResult<User>>;
  /** Forget everything on this device: token, cached state and queued writes (after "delete all data"). */
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

  function syncStatus(): SyncStatus {
    if (isSessionInvalid()) return "error";
    if (!online) return "offline";
    if (pending === 0) return "synced";
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
      syncStatus: syncStatus(),
      lastSyncError,
      lastSyncedAt,
      lastStamped,
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

  function onSessionCreated(user: User): void {
    base = { ...base, user };
    const nick = pendingNickname;
    pendingNickname = null;
    if (nick && user.nickname !== nick) {
      saveOutbox(enqueue(loadOutbox(), { kind: "me.patch", body: { nickname: nick } }, Date.now(), newId()));
    }
    ready = true;
    persist();
    recompute();
  }

  function onSent(item: OutboxItem, response: unknown): void {
    if (touched) touched.add(targetOf(item.op) ?? "@me");
    let next = applyOp(base, item.op, item.at);
    if (hasResponseChallenge(response)) {
      const c = response.challenge;
      const exists = next.challenges.some((x) => x.id === c.id);
      next = { ...next, challenges: exists ? next.challenges.map((x) => (x.id === c.id ? c : x)) : [...next.challenges, c] };
    }
    if (item.op.kind === "me.patch" && hasResponseUser(response)) next = { ...next, user: response.user };
    base = next;
    persist();
  }

  function onDropped(_item: OutboxItem, error: unknown): void {
    notice({ kind: "error", message: `保存できませんでした。${errorMessage(error)}` });
  }

  async function drainOnce(): Promise<void> {
    clearTimeout(retryTimer);
    online = browserOnline();
    if (!online || isSessionInvalid() || loadOutbox().length === 0) {
      if (loadOutbox().length === 0) lastDrain = "empty";
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
          lastDrain = "retry";
          scheduleRetry(backoffMs(2));
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
    if (result.status === "empty") {
      lastSyncError = null;
      lastSyncedAt = Date.now();
    } else {
      lastSyncError = errorMessage(result.error);
      if (result.status === "retry") scheduleRetry(backoffMs(result.attempts));
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
      const c = findOpen(challengeId);
      if ("ok" in c) return c;
      const v = viewChallenge(c, today);
      if (!v.canReflect) return fail("振り返りは7日目からできます。");
      const parsed = parseWith(ReflectSchema, reflection === undefined ? { verdict } : { verdict, reflection });
      if (!parsed.ok) return parsed;
      const finishedDay = Math.max(1, Math.min(v.day, TOTAL_DAYS));
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
      if (!getToken() && parsed.data.nickname !== undefined) {
        pendingNickname = parsed.data.nickname;
        persist();
      }
      mutate({ kind: "me.patch", body: parsed.data });
      return ok();
    },

    refresh,
    flush,

    async restoreWithCode(code) {
      try {
        const res = await redeemTransfer(code);
        const sameAccount = !base.user || base.user.id === res.user.id;
        if (!sameAccount) {
          // The queue and cache belonged to another account on this device.
          saveOutbox([]);
          base = { user: res.user, challenges: [] };
        } else {
          base = { ...base, user: res.user };
        }
        pendingNickname = null;
        persist();
        recompute();
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
      ready = true;
      persist();
      recompute();
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
      unsubSession();
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
