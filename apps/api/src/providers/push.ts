import webpush from "web-push";
import type { Config, Secrets } from "../config";
import { log } from "../log";
import type { PushSender, PushTarget } from "../ports";

// ---------- endpoint allowlist (SSRF protection, SPEC: Security) ----------

const EXACT_PUSH_HOSTS = new Set(["fcm.googleapis.com", "push.services.mozilla.com", "updates.push.services.mozilla.com"]);
/** "*.<suffix>": at least one label in front of the suffix. */
const WILDCARD_PUSH_SUFFIXES = [".push.services.mozilla.com", ".push.apple.com", ".notify.windows.com"];

export function isAllowedPushHost(host: string): boolean {
  if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".") || host.includes("..")) return false;
  if (EXACT_PUSH_HOSTS.has(host)) return true;
  return WILDCARD_PUSH_SUFFIXES.some((suffix) => host.length > suffix.length && host.endsWith(suffix));
}

/**
 * Only https endpoints of the known push services. The raw string must literally start with
 * "https://<allowed host>/" — no userinfo, no port, no escapes — so every URL parser (web-push still
 * uses the legacy url.parse) sees the same host as this check.
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (typeof endpoint !== "string" || endpoint.length > 1000) return false;
  for (const ch of endpoint) {
    const code = ch.codePointAt(0)!;
    // Printable ASCII only (no spaces, controls, backslashes or non-ASCII look-alikes).
    if (code <= 0x20 || code >= 0x7f || ch === "\\") return false;
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname;
  if (!isAllowedPushHost(host)) return false;
  const prefix = `https://${host}/`;
  return endpoint.slice(0, prefix.length).toLowerCase() === prefix;
}

// ---------- senders ----------

/** Accepts every message without sending anything (tests, and when no VAPID key is configured). */
export class NoopPushSender implements PushSender {
  readonly sent: { sub: PushTarget; payload: object }[] = [];

  async send(sub: PushTarget, payload: object): Promise<{ ok: boolean; gone: boolean }> {
    this.sent.push({ sub, payload });
    return { ok: true, gone: false };
  }
}

/** Reminders older than this are useless: the push service may drop them. */
export const PUSH_TTL_SECONDS = 6 * 60 * 60;
export const PUSH_TIMEOUT_MS = 5_000;

export type WebPushLib = Pick<typeof webpush, "sendNotification" | "setVapidDetails">;

function statusOf(err: unknown): number | undefined {
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" ? status : undefined;
}

/**
 * Web Push (VAPID) through the web-push package.
 * `secrets` is the same object as Deps.secrets; on Lambda it is filled in place when the first
 * request arrives, so the private key is read at send time.
 */
export class WebPushSender implements PushSender {
  private configured: string | undefined;

  constructor(
    private readonly config: Config,
    private readonly secrets: Secrets,
    private readonly lib: WebPushLib = webpush,
  ) {}

  /** setVapidDetails once per key set. false when the keys are missing or invalid. */
  private ensureVapid(): boolean {
    const publicKey = this.config.vapidPublicKey;
    const privateKey = this.secrets.vapidPrivateKey ?? this.config.vapidPrivateKey;
    if (!publicKey || !privateKey) {
      log.warn("push: VAPID keys are not configured");
      return false;
    }
    const id = `${this.config.vapidSubject}\n${publicKey}\n${privateKey}`;
    if (this.configured === id) return true;
    try {
      this.lib.setVapidDetails(this.config.vapidSubject, publicKey, privateKey);
      this.configured = id;
      return true;
    } catch (err) {
      log.error("push: invalid VAPID details", { errName: (err as Error | undefined)?.name });
      return false;
    }
  }

  async send(sub: PushTarget, payload: object): Promise<{ ok: boolean; gone: boolean }> {
    // Defense in depth: anything stored before the allowlist (or tampered with) is dropped, not fetched.
    if (!isAllowedPushEndpoint(sub.endpoint)) return { ok: false, gone: true };
    if (!this.ensureVapid()) return { ok: false, gone: false };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), PUSH_TIMEOUT_MS);
    });
    try {
      const res = await Promise.race([
        this.lib.sendNotification(sub, JSON.stringify(payload), {
          TTL: PUSH_TTL_SECONDS,
          timeout: PUSH_TIMEOUT_MS,
          urgency: "normal",
        }),
        timedOut,
      ]);
      if (res === "timeout") {
        log.warn("push: send timed out");
        return { ok: false, gone: false };
      }
      return { ok: true, gone: false };
    } catch (err) {
      const status = statusOf(err);
      if (status === 404 || status === 410) return { ok: false, gone: true };
      // No message: it can carry the endpoint.
      log.warn("push: send failed", { status, errName: (err as Error | undefined)?.name });
      return { ok: false, gone: false };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The real Web Push sender whenever a VAPID public key is configured (Lambda: SSM parameter,
 * local.ts: generated at start-up). Without one the API cannot offer push, so nothing is sent.
 */
export function createPushSender(config: Config, secrets: Secrets): PushSender {
  if (config.vapidPublicKey) return new WebPushSender(config, secrets);
  log.debug("push: no VAPID public key, using the no-op sender");
  return new NoopPushSender();
}
