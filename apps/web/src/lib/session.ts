/**
 * Anonymous session (FR-1, FR-2). The bearer token lives in localStorage; the account is created
 * lazily by the first write. After a 401 the token is discarded and the device is flagged so we
 * do not silently create a second, empty account — the user restores with a transfer code
 * or chooses to start over (SPEC: Error Handling).
 */
import {
  API,
  DEFAULT_TIMEZONE,
  NicknameSchema,
  TransferRedeemSchema,
  isValidTimeZone,
  type SessionCreate,
  type SessionResponse,
  type User,
} from "@thirty/shared";
import { ApiClientError, send } from "./http";
import { KEYS, readString, removeKey, writeString } from "./storage";

export function deviceTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && isValidTimeZone(tz)) return tz;
  } catch {
    // fall through
  }
  return DEFAULT_TIMEZONE;
}

export function getToken(): string | null {
  return readString(KEYS.token);
}

export function isSessionInvalid(): boolean {
  return readString(KEYS.sessionInvalid) === "1";
}

const listeners = new Set<() => void>();

/** Called whenever the token appears, disappears or the session is marked invalid. */
export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  for (const l of [...listeners]) l();
}

export type CreatedSession = { token: string; user: User };
const createdListeners = new Set<(s: CreatedSession) => void>();

/**
 * Called when this device creates the anonymous account, whoever asked for it: the store's queue,
 * or any `request(..., { auth: "required" })` (a cheer, a report, a post). The store adopts the new
 * user and sends what waited for the account (e.g. the nickname from the start sheet).
 */
export function subscribeSessionCreated(listener: (s: CreatedSession) => void): () => void {
  createdListeners.add(listener);
  return () => createdListeners.delete(listener);
}

function storeToken(token: string): void {
  writeString(KEYS.token, token);
  removeKey(KEYS.sessionInvalid);
  emit();
}

export type EnsuredSession = {
  token: string;
  /** Present only when this call created the account. */
  user: User | null;
  created: boolean;
};

let inflight: Promise<EnsuredSession> | null = null;
// Bumped by clearSession so a create that resolves afterwards does not resurrect the token.
let generation = 0;

/**
 * Resolve a usable token, creating the anonymous account on first use. Concurrent callers share
 * one request. Rejects with a 401 ApiClientError while the session is flagged invalid.
 */
export function ensureSession(nickname?: string): Promise<EnsuredSession> {
  const token = getToken();
  if (token) return Promise.resolve({ token, user: null, created: false });
  if (isSessionInvalid()) {
    return Promise.reject(new ApiClientError(401, "unauthorized", "この端末の記録をサーバーで確認できませんでした。引き継ぎコードで復元できます。"));
  }
  if (!inflight) {
    const gen = generation;
    const body: SessionCreate = { tz: deviceTimeZone() };
    const nick = nickname === undefined ? undefined : NicknameSchema.safeParse(nickname);
    if (nick?.success) body.nickname = nick.data;
    const p = send<SessionResponse>("POST", API.session, { body })
      .then((res): EnsuredSession => {
        if (gen === generation) {
          storeToken(res.token);
          for (const l of [...createdListeners]) {
            try {
              l({ token: res.token, user: res.user });
            } catch (err) {
              // A listener's bug must not fail the caller's request: the account exists either way.
              console.error("session listener failed", err);
            }
          }
        }
        return { token: res.token, user: res.user, created: true };
      })
      .finally(() => {
        if (inflight === p) inflight = null;
      });
    inflight = p;
  }
  return inflight;
}

/** Use an 8-character transfer code from another device (same account, new token). */
export async function redeemTransfer(code: string): Promise<SessionResponse> {
  const parsed = TransferRedeemSchema.safeParse({ code });
  if (!parsed.success) {
    throw new ApiClientError(400, "bad_request", parsed.error.issues[0]?.message ?? "引き継ぎコードを確認してください。");
  }
  const res = await send<SessionResponse>("POST", API.sessionTransfer, { body: parsed.data });
  generation++;
  inflight = null;
  storeToken(res.token);
  return res;
}

/** Forget the token on this device (after "delete all data", or to start over). */
export function clearSession(): void {
  generation++;
  inflight = null;
  removeKey(KEYS.token);
  removeKey(KEYS.sessionInvalid);
  emit();
}

/** The server rejected our token: drop it and remember why, so the UI can guide recovery. */
export function markSessionInvalid(): void {
  removeKey(KEYS.token);
  writeString(KEYS.sessionInvalid, "1");
  emit();
}
