/**
 * Offline-first writes (SPEC: Error Handling). Every mutation is applied to local state right away
 * and queued here; the queue is sent strictly in order because later operations can depend on
 * earlier ones (a stamp needs its challenge). The API is idempotent for these routes, so
 * re-sending after a lost response is safe.
 *
 * - 5xx / network / timeout / a short 429 → keep the item, stop, retry later with backoff
 * - 429 that lasts (a create over the daily quota, or Retry-After beyond an hour) → drop it like a
 *   4xx: waiting at the head of the queue would hold every later write until tomorrow
 * - 401 → keep everything, stop (the session must be restored first)
 * - 404 to a challenge delete → it is already gone: counts as sent (no rollback, no message)
 * - other 4xx → drop the item (it will never succeed); the caller refetches to roll back
 *
 * Everything here is pure except drain(), which takes its I/O as arguments.
 */
import { API, type Challenge, type User, type Verdict } from "@thirty/shared";

export type CreateBody = { id: string; recipeId?: string | null; title: string; seal: string; startDate: string };
export type ChallengePatchBody = { title?: string; seal?: string; startDate?: string };
export type ReflectBody = { verdict: Verdict; reflection?: string };
export type MePatchBody = {
  nickname?: string;
  tz?: string;
  shareProgress?: boolean;
  reminder?: { enabled: boolean; time: string };
};

export type OutboxOp =
  | { kind: "challenge.create"; body: CreateBody }
  | { kind: "challenge.patch"; id: string; body: ChallengePatchBody }
  | { kind: "challenge.delete"; id: string }
  | { kind: "stamp.put"; id: string; day: number; body: { note?: string } }
  | { kind: "stamp.delete"; id: string; day: number }
  /** finishedDay is local-only (the server computes its own); body is what is sent. */
  | { kind: "challenge.reflect"; id: string; body: ReflectBody; finishedDay: number }
  | { kind: "me.patch"; body: MePatchBody };

export type OutboxItem = {
  key: string;
  op: OutboxOp;
  /** When the user did it (ms). Used as the timestamp when the op is applied locally. */
  at: number;
  attempts: number;
  /** A send was started at least once, so the server may have seen it. */
  sent: boolean;
};

/** Challenge id an op touches, or null for account-level ops. */
export function targetOf(op: OutboxOp): string | null {
  if (op.kind === "me.patch") return null;
  if (op.kind === "challenge.create") return op.body.id;
  return op.id;
}

export function hasPendingFor(items: readonly OutboxItem[], challengeId: string): boolean {
  return items.some((i) => targetOf(i.op) === challengeId);
}

export function hasPendingMe(items: readonly OutboxItem[]): boolean {
  return items.some((i) => i.op.kind === "me.patch");
}

// ---------- enqueue ----------

function merge(prev: OutboxOp, next: OutboxOp): OutboxOp | null {
  if (prev.kind === "stamp.put" && next.kind === "stamp.put" && prev.id === next.id && prev.day === next.day) {
    return { ...next, body: { ...prev.body, ...next.body } };
  }
  if (prev.kind === "challenge.patch" && next.kind === "challenge.patch" && prev.id === next.id) {
    return { ...next, body: { ...prev.body, ...next.body } };
  }
  if (prev.kind === "me.patch" && next.kind === "me.patch") {
    return { ...next, body: { ...prev.body, ...next.body } };
  }
  return null;
}

/**
 * Add an op. Repeated edits of the same thing merge into the last item; a merged item always gets
 * a fresh key, so a copy that is already on the wire is not mistaken for it and the merged
 * version is still sent. Deleting a challenge the server has never seen just cancels its queue.
 */
export function enqueue(items: readonly OutboxItem[], op: OutboxOp, at: number, key: string): OutboxItem[] {
  if (op.kind === "challenge.delete") {
    const mine = items.filter((i) => targetOf(i.op) === op.id);
    const unsentCreate = mine.some((i) => i.op.kind === "challenge.create" && !i.sent);
    const rest = items.filter((i) => targetOf(i.op) !== op.id || i.sent);
    if (unsentCreate && !rest.some((i) => targetOf(i.op) === op.id)) return rest;
    return [...rest, { key, op, at, attempts: 0, sent: false }];
  }
  const last = items[items.length - 1];
  if (last) {
    const merged = merge(last.op, op);
    if (merged) return [...items.slice(0, -1), { key, op: merged, at, attempts: 0, sent: false }];
  }
  return [...items, { key, op, at, attempts: 0, sent: false }];
}

// ---------- local (optimistic) application ----------

export type LocalState = { user: User | null; challenges: Challenge[] };

function updateChallenge(list: Challenge[], id: string, fn: (c: Challenge) => Challenge): Challenge[] {
  return list.map((c) => (c.id === id ? fn(c) : c));
}

export function applyOp(state: LocalState, op: OutboxOp, at: number): LocalState {
  switch (op.kind) {
    case "challenge.create": {
      if (state.challenges.some((c) => c.id === op.body.id)) return state;
      const b = op.body;
      const created: Challenge = {
        id: b.id,
        recipeId: b.recipeId ?? null,
        title: b.title,
        seal: b.seal,
        startDate: b.startDate,
        status: "active",
        stamps: {},
        verdict: null,
        reflection: null,
        finishedAt: null,
        finishedDay: null,
        cheers: 0,
        shareId: null,
        createdAt: at,
        updatedAt: at,
      };
      return { ...state, challenges: [...state.challenges, created] };
    }
    case "challenge.patch":
      return {
        ...state,
        challenges: updateChallenge(state.challenges, op.id, (c) => ({ ...c, ...op.body, updatedAt: at })),
      };
    case "challenge.delete":
      return { ...state, challenges: state.challenges.filter((c) => c.id !== op.id) };
    case "stamp.put":
      return {
        ...state,
        challenges: updateChallenge(state.challenges, op.id, (c) => {
          const prev = c.stamps[String(op.day)];
          const note = op.body.note !== undefined ? op.body.note : prev?.note;
          const stamp = note ? { at: prev?.at ?? at, note } : { at: prev?.at ?? at };
          return { ...c, stamps: { ...c.stamps, [String(op.day)]: stamp }, updatedAt: at };
        }),
      };
    case "stamp.delete":
      return {
        ...state,
        challenges: updateChallenge(state.challenges, op.id, (c) => {
          if (!c.stamps[String(op.day)]) return c;
          const stamps = { ...c.stamps };
          delete stamps[String(op.day)];
          return { ...c, stamps, updatedAt: at };
        }),
      };
    case "challenge.reflect":
      return {
        ...state,
        challenges: updateChallenge(state.challenges, op.id, (c) => ({
          ...c,
          status: "done",
          verdict: op.body.verdict,
          reflection: op.body.reflection ? op.body.reflection : null,
          finishedAt: c.status === "done" && c.finishedAt !== null ? c.finishedAt : at,
          finishedDay: op.finishedDay,
          updatedAt: at,
        })),
      };
    case "me.patch":
      return state.user ? { ...state, user: { ...state.user, ...op.body } } : state;
  }
}

/** Server state with the not-yet-confirmed local changes re-applied on top. */
export function applyPending(base: LocalState, items: readonly OutboxItem[]): LocalState {
  return items.reduce((s, i) => applyOp(s, i.op, i.at), base);
}

// ---------- sending ----------

export type OpRequest = { method: "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body?: unknown };

export function opRequest(op: OutboxOp): OpRequest {
  switch (op.kind) {
    case "challenge.create":
      return { method: "POST", path: API.challenges, body: op.body };
    case "challenge.patch":
      return { method: "PATCH", path: API.challenge(op.id), body: op.body };
    case "challenge.delete":
      return { method: "DELETE", path: API.challenge(op.id) };
    case "stamp.put":
      return { method: "PUT", path: API.stamp(op.id, op.day), body: op.body };
    case "stamp.delete":
      return { method: "DELETE", path: API.stamp(op.id, op.day) };
    case "challenge.reflect":
      return { method: "POST", path: API.reflect(op.id), body: op.body };
    case "me.patch":
      return { method: "PATCH", path: API.me, body: op.body };
  }
}

export type FailureKind = "retry" | "drop" | "auth";

/** A 429 whose Retry-After is longer than this is not worth waiting for at the head of the queue. */
export const LONG_RATE_LIMIT_SECONDS = 60 * 60;

function statusOf(err: unknown): number | null {
  return typeof (err as { status?: unknown } | null)?.status === "number" ? (err as { status: number }).status : null;
}

/**
 * A 429 that will not clear soon. The create quota (QUOTAS.challengesPerUserPerDay) resets at
 * midnight JST, so a create is never retried; any other write is dropped when the server asks to
 * wait more than an hour. The SPEC ("Error Handling", 429) wants 「今日はここまで」 for these.
 */
export function isLongRateLimit(op: OutboxOp | undefined, err: unknown): boolean {
  if (statusOf(err) !== 429) return false;
  if (op?.kind === "challenge.create") return true;
  const retryAfter = (err as { retryAfter?: unknown }).retryAfter;
  return typeof retryAfter === "number" && retryAfter > LONG_RATE_LIMIT_SECONDS;
}

/**
 * How to treat a failed send of `op`. Errors without an HTTP status (bugs) are dropped, never
 * looped. A short 429 is retried; a lasting one is dropped (isLongRateLimit).
 */
export function classifyError(err: unknown, op?: OutboxOp): FailureKind {
  const status = statusOf(err);
  if (status === null) return "drop";
  if (status === 0) return (err as { code?: unknown }).code === "aborted" ? "drop" : "retry";
  if (status === 401) return "auth";
  if (status === 429) return isLongRateLimit(op, err) ? "drop" : "retry";
  if (status >= 500) return "retry";
  return "drop";
}

/**
 * A failure that means the op already took effect: deleting a challenge that the server no longer
 * has (404: deleted on another device, or an earlier send whose response was lost). Treated as sent
 * — no rollback, no error message.
 */
export function isAlreadyDone(op: OutboxOp, err: unknown): boolean {
  return op.kind === "challenge.delete" && statusOf(err) === 404;
}

/** 2s, 4s, 8s … capped at 5 minutes. */
export function backoffMs(attempts: number): number {
  return Math.min(5 * 60_000, 2_000 * 2 ** Math.max(0, attempts - 1));
}

/** When to try again after a retryable failure: the backoff, or longer when a 429 says so (up to an hour). */
export function retryDelayMs(attempts: number, err: unknown): number {
  const base = backoffMs(attempts);
  if (statusOf(err) !== 429) return base;
  const retryAfter = (err as { retryAfter?: unknown }).retryAfter;
  if (typeof retryAfter !== "number" || !(retryAfter > 0)) return base;
  return Math.max(base, Math.min(retryAfter, LONG_RATE_LIMIT_SECONDS) * 1000);
}

/** Remove a dropped item. If it was a create, later ops for that challenge would only 404, so drop them too. */
export function dropItem(items: readonly OutboxItem[], item: OutboxItem): OutboxItem[] {
  const id = item.op.kind === "challenge.create" ? item.op.body.id : null;
  const idx = items.findIndex((i) => i.key === item.key);
  return items.filter((i, n) => {
    if (i.key === item.key) return false;
    return !(id && n > idx && targetOf(i.op) === id);
  });
}

export type DrainDeps = {
  load(): OutboxItem[];
  save(items: OutboxItem[]): void;
  send(item: OutboxItem): Promise<unknown>;
  onSent?(item: OutboxItem, response: unknown): void;
  onDropped?(item: OutboxItem, error: unknown): void;
};

export type DrainResult =
  | { status: "empty"; sent: number; dropped: number }
  | { status: "retry"; sent: number; dropped: number; error: unknown; attempts: number }
  | { status: "auth"; sent: number; dropped: number; error: unknown };

/** Send queued items one by one, in order, until the queue is empty or something must wait. */
export async function drain(deps: DrainDeps): Promise<DrainResult> {
  let sent = 0;
  let dropped = 0;
  for (;;) {
    const head = deps.load()[0];
    if (!head) return { status: "empty", sent, dropped };
    // Persist "sent" before the request so a delete can tell whether the server may know this create.
    const item: OutboxItem = { ...head, sent: true };
    deps.save(deps.load().map((i) => (i.key === item.key ? item : i)));

    let response: unknown;
    try {
      response = await deps.send(item);
    } catch (error) {
      if (isAlreadyDone(item.op, error)) {
        deps.save(deps.load().filter((i) => i.key !== item.key));
        sent++;
        deps.onSent?.(item, undefined);
        continue;
      }
      const kind = classifyError(error, item.op);
      const current = deps.load();
      if (kind === "drop") {
        deps.save(dropItem(current, item));
        dropped++;
        deps.onDropped?.(item, error);
        continue;
      }
      const attempts = item.attempts + 1;
      deps.save(current.map((i) => (i.key === item.key ? { ...i, attempts } : i)));
      if (kind === "auth") return { status: "auth", sent, dropped, error };
      return { status: "retry", sent, dropped, error, attempts };
    }
    deps.save(deps.load().filter((i) => i.key !== item.key));
    sent++;
    deps.onSent?.(item, response);
  }
}
