/**
 * Low-level JSON transport for the same-origin API. No auth and no retries here: a request is
 * sent exactly once (a blind retry could duplicate a POST; the outbox decides about re-sending
 * the idempotent writes).
 */
import { ERROR_CODES, type ErrorCode } from "@thirty/shared";

export type ClientErrorCode = ErrorCode | "network" | "timeout" | "aborted";

const MESSAGES: Record<ClientErrorCode, string> = {
  bad_request: "入力内容を確認してください。",
  unauthorized: "この端末の記録をサーバーで確認できませんでした。",
  forbidden: "この操作はできません。",
  not_found: "見つかりませんでした。",
  conflict: "ほかの変更とぶつかりました。画面を更新してください。",
  rate_limited: "今日はここまでです。時間をおいてお試しください。",
  payload_too_large: "データが大きすぎます。",
  unsupported_media_type: "送信の形式が正しくありません。",
  ai_unavailable: "いまは提案を使えません。",
  internal: "サーバーで問題が起きました。時間をおいてもう一度お試しください。",
  network: "通信できませんでした。つながる場所でもう一度お試しください。",
  timeout: "応答がありませんでした。時間をおいてもう一度お試しください。",
  aborted: "中止しました。",
};

const STATUS_CODES: Record<number, ErrorCode> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  415: "unsupported_media_type",
  429: "rate_limited",
};

export class ApiClientError extends Error {
  /** HTTP status, or 0 when no response arrived (network / timeout / aborted). */
  readonly status: number;
  readonly code: ClientErrorCode;
  /** Per-field messages from a 400, keyed by the request field name. */
  readonly fields: Record<string, string> | undefined;
  /** Seconds from a Retry-After header (429), when the server sent one. */
  readonly retryAfter: number | undefined;

  constructor(status: number, code: ClientErrorCode, message?: string, fields?: Record<string, string>, retryAfter?: number) {
    super(message || MESSAGES[code]);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.retryAfter = retryAfter;
  }

  /** True when the same request may succeed later without changes (offline, 5xx, 429). */
  get retryable(): boolean {
    if (this.status === 0) return this.code !== "aborted";
    return this.status >= 500 || this.status === 429;
  }
}

export function isApiClientError(err: unknown): err is ApiClientError {
  return err instanceof ApiClientError;
}

/** A user-facing message for any thrown value. */
export function errorMessage(err: unknown, fallback = "うまくいきませんでした。もう一度お試しください。"): string {
  if (err instanceof ApiClientError) return err.message;
  return fallback;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

export type SendOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Passed to fetch. "no-cache" also makes the service worker go to the network for cached API routes. */
  cache?: RequestCache;
};

const isErrorCode = (v: unknown): v is ErrorCode => typeof v === "string" && (ERROR_CODES as readonly string[]).includes(v);

function toError(status: number, data: unknown, retryAfterHeader: string | null): ApiClientError {
  const retryAfter = retryAfterHeader && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : undefined;
  const fallbackCode: ErrorCode = STATUS_CODES[status] ?? (status >= 500 ? "internal" : "bad_request");
  const err = (data as { error?: unknown } | null)?.error as { code?: unknown; message?: unknown; fields?: unknown } | undefined;
  if (err && typeof err === "object") {
    const code = isErrorCode(err.code) ? err.code : fallbackCode;
    const message = typeof err.message === "string" && err.message ? err.message : undefined;
    let fields: Record<string, string> | undefined;
    if (err.fields && typeof err.fields === "object") {
      fields = {};
      for (const [k, v] of Object.entries(err.fields as Record<string, unknown>)) if (typeof v === "string") fields[k] = v;
    }
    return new ApiClientError(status, code, message, fields, retryAfter);
  }
  return new ApiClientError(status, fallbackCode, undefined, undefined, retryAfter);
}

export async function send<T>(method: string, path: string, opts: SendOptions = {}): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  const failure = (): ApiClientError => {
    if (timedOut) return new ApiClientError(0, "timeout");
    if (opts.signal?.aborted) return new ApiClientError(0, "aborted");
    return new ApiClientError(0, "network");
  };

  try {
    let res: Response;
    let text: string;
    try {
      res = await fetch(path, {
        method,
        headers,
        body,
        signal: controller.signal,
        credentials: "same-origin",
        ...(opts.cache ? { cache: opts.cache } : {}),
      });
      text = res.status === 204 ? "" : await res.text();
    } catch {
      throw failure();
    }

    let data: unknown;
    let parsed = false;
    if (text) {
      try {
        data = JSON.parse(text);
        parsed = true;
      } catch {
        parsed = false;
      }
    }
    if (!res.ok) throw toError(res.status, parsed ? data : null, res.headers.get("Retry-After"));
    if (text && !parsed) throw new ApiClientError(res.status, "internal", "サーバーの応答を読み取れませんでした。");
    return data as T;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
