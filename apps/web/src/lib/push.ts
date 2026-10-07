/**
 * Web Push reminders on this device (SPEC FR-14).
 *
 *   getPushStatus()        → what the settings screen can offer here (or why not)
 *   enablePush()           → call it DIRECTLY from a click handler (permission prompt), then it
 *                            subscribes and registers the endpoint with the API
 *   disablePush()          → unsubscribe here and forget the endpoint on the server
 *   sendTestPush()         → ask the API to send one notification now
 *   startPushResync()      → app start: re-register an existing subscription (browsers rotate
 *                            endpoints — "pushsubscriptionchange" — and the worker has no token)
 *
 * Push needs a service worker, PushManager and Notification. iOS/iPadOS (16.4+) only exposes them
 * to a web app opened from the Home Screen, so a Safari tab gets "ios-needs-install" guidance.
 */
import { API, type PushPublicKeyResponse, type PushSubscriptionInput } from "@thirty/shared";
import { ApiClientError, errorMessage, request } from "./api";
import { getToken } from "./session";

export type PushStatus =
  /** No Push API in this browser (and it is not the iOS Home Screen case). */
  | "unsupported"
  /** iPhone / iPad in a Safari tab: add to the Home Screen and open it from there. */
  | "ios-needs-install"
  /** The user (or the OS) blocked notifications for this site. */
  | "denied"
  /** Not asked yet. */
  | "default"
  | "granted";

export type PushErrorCode = "unsupported" | "ios-needs-install" | "denied" | "dismissed" | "server-unsupported" | "not-ready" | "failed";

const MESSAGES: Record<PushErrorCode, string> = {
  unsupported: "このブラウザは通知に対応していません。各チャレンジの画面から、カレンダーに毎日の予定を入れられます。",
  "ios-needs-install": "iPhone は、Safari の共有ボタン →『ホーム画面に追加』してから開くと通知を受け取れます。",
  denied: "通知がブロックされています。ブラウザ（またはスマホ）の設定で、このサイトの通知を許可してください。",
  dismissed: "通知の許可が選ばれませんでした。もう一度押すと選び直せます。",
  "server-unsupported": "いまは通知を使えません。各チャレンジの画面から、カレンダーに毎日の予定を入れられます。",
  "not-ready": "通知の準備ができませんでした。ページを再読み込みしてから、もう一度お試しください。",
  failed: "通知を登録できませんでした。時間をおいて、もう一度お試しください。",
};

export class PushError extends Error {
  readonly code: PushErrorCode;
  constructor(code: PushErrorCode, message?: string) {
    super(message ?? MESSAGES[code]);
    this.name = "PushError";
    this.code = code;
  }
}

/** A user-facing message for anything enablePush / disablePush / sendTestPush throws. */
export function pushErrorMessage(err: unknown): string {
  if (err instanceof PushError) return err.message;
  if (err instanceof ApiClientError && err.status === 429) return "テスト通知は1日5回までです。また明日お試しください。";
  return errorMessage(err, MESSAGES.failed);
}

// ---------- environment ----------

type Nav = Navigator & { standalone?: boolean };

function nav(): Nav | undefined {
  return typeof navigator === "undefined" ? undefined : (navigator as Nav);
}

/** Service worker + PushManager + Notification are all there. */
export function isPushSupported(): boolean {
  const n = nav();
  return !!n && "serviceWorker" in n && !!n.serviceWorker && "PushManager" in globalThis && "Notification" in globalThis;
}

/** iPhone / iPod / iPad (iPadOS reports itself as a Mac, but with a touch screen). */
export function isIos(): boolean {
  const n = nav();
  if (!n) return false;
  const ua = n.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return /Macintosh/i.test(ua) && (n.maxTouchPoints ?? 0) > 1;
}

/** Opened as an installed app (Home Screen / standalone window). */
export function isStandalone(): boolean {
  if (nav()?.standalone === true) return true;
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    return false;
  }
}

function permission(): NotificationPermission {
  try {
    return (globalThis as { Notification?: { permission?: NotificationPermission } }).Notification?.permission ?? "default";
  } catch {
    return "default";
  }
}

/** What this device can do about push right now. */
export function getPushStatus(): PushStatus {
  if (isIos() && !isStandalone()) return "ios-needs-install";
  if (!isPushSupported()) return "unsupported";
  const p = permission();
  return p === "granted" ? "granted" : p === "denied" ? "denied" : "default";
}

// ---------- keys ----------

/** VAPID public key (base64url) → bytes for pushManager.subscribe. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const clean = base64.trim();
  const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameBytes(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  if (x.length !== b.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== b[i]) return false;
  return true;
}

let publicKey: Promise<string | null> | null = null;

/** The server's VAPID public key; null when the server has push turned off. Cached per page load. */
export function getPublicKey(): Promise<string | null> {
  publicKey ??= request<PushPublicKeyResponse>("GET", API.pushPublicKey, { auth: "none" }).then(
    (res) => (typeof res?.publicKey === "string" && res.publicKey ? res.publicKey : null),
    (err: unknown) => {
      publicKey = null; // let a later call try again
      throw err;
    },
  );
  return publicKey;
}

// ---------- subscription ----------

const READY_TIMEOUT_MS = 10_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** The existing subscription on this device, without waiting for a worker to install. */
export async function getCurrentSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return (await reg?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

/** PushSubscription → the API's body. */
export function toSubscriptionInput(sub: PushSubscription): PushSubscriptionInput {
  const json = sub.toJSON();
  const endpoint = json.endpoint ?? sub.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!endpoint || !p256dh || !auth) throw new PushError("failed");
  return { endpoint, keys: { p256dh, auth } };
}

/**
 * Ask for permission, subscribe and register with the API (creates the account if needed).
 * Call it straight from a click handler: Safari only shows the prompt for a user gesture, so the
 * permission request is the first thing that happens here.
 */
export async function enablePush(): Promise<PushSubscriptionInput> {
  const status = getPushStatus();
  if (status === "ios-needs-install" || status === "unsupported" || status === "denied") throw new PushError(status);

  const result = status === "granted" ? "granted" : await Notification.requestPermission();
  if (result === "denied") throw new PushError("denied");
  if (result !== "granted") throw new PushError("dismissed");

  const key = await getPublicKey();
  if (!key) throw new PushError("server-unsupported");
  const keyBytes = urlBase64ToUint8Array(key);

  const reg = await withTimeout(navigator.serviceWorker.ready, READY_TIMEOUT_MS);
  if (!reg) throw new PushError("not-ready");

  let sub: PushSubscription | null;
  try {
    sub = await reg.pushManager.getSubscription();
    // Subscribed with another key (the server's key changed): start over with the current one.
    if (sub && !sameBytes(sub.options.applicationServerKey, keyBytes)) {
      await sub.unsubscribe().catch(() => false);
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes });
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotAllowedError") throw new PushError("denied");
    throw new PushError("failed");
  }

  const input = toSubscriptionInput(sub);
  await request("POST", API.pushSubscriptions, { body: input, auth: "required" });
  return input;
}

/**
 * Stop notifications on this device: unsubscribe and forget the endpoint on the server.
 * notifyServer=false skips the API (e.g. right after the account was deleted).
 */
export async function disablePush(opts: { notifyServer?: boolean } = {}): Promise<void> {
  const sub = await getCurrentSubscription();
  if (!sub) return;
  const { endpoint } = sub;
  if (opts.notifyServer !== false && getToken()) {
    try {
      await request("DELETE", API.pushSubscriptions, { body: { endpoint }, auth: "optional" });
    } catch {
      // The browser endpoint dies below; the server drops it when the push service answers 404/410.
    }
  }
  try {
    await sub.unsubscribe();
  } catch {
    throw new PushError("failed", "通知を止められませんでした。ブラウザの設定から、このサイトの通知をオフにしてください。");
  }
}

/** One notification now (to check that reminders arrive). */
export async function sendTestPush(): Promise<void> {
  // No body needed: lib/http.ts sends "{}" as JSON for every POST.
  await request("POST", API.pushTest, { auth: "required" });
}

/**
 * Re-register this device's subscription. Runs on app start: only when notifications are allowed,
 * a subscription exists and the account exists (it never creates one). Never throws.
 */
export async function syncPushSubscription(): Promise<boolean> {
  try {
    if (getPushStatus() !== "granted" || !getToken()) return false;
    const sub = await getCurrentSubscription();
    if (!sub) return false;
    await request("POST", API.pushSubscriptions, { body: toSubscriptionInput(sub), auth: "optional" });
    return true;
  } catch {
    return false;
  }
}

/** main.tsx: re-sync once, a little after start-up so it never competes with the first render. */
export function startPushResync(delayMs = 4_000): void {
  if (typeof window === "undefined") return;
  setTimeout(() => void syncPushSubscription(), delayMs);
}
