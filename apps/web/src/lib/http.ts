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

/**
 * A 429 without the API's JSON error: the edge (API Gateway's stage throttle, shared by everyone)
 * refused the request. It clears in seconds, so it is not 「今日はここまで」.
 */
export const THROTTLED_MESSAGE = "混み合っています。少し時間をおいてから、もう一度お試しください。";

export type ApiClientErrorMeta = {
  /** The response carried the API's own JSON error ({ error: { code, message } }). */
  fromApi?: boolean;
  /** The request failed while creating the anonymous account (POST /api/session), not the action itself. */
  session?: boolean;
};

export class ApiClientError extends Error {
  /** HTTP status, or 0 when no response arrived (network / timeout / aborted). */
  readonly status: number;
  readonly code: ClientErrorCode;
  /** Per-field messages from a 400, keyed by the request field name. */
  readonly fields: Record<string, string> | undefined;
  /** Seconds from a Retry-After header (429), when the server sent one. */
  readonly retryAfter: number | undefined;
  /** The API itself answered with its JSON error (false for the edge, a proxy or no response). */
  readonly fromApi: boolean;
  /** Raised while creating the anonymous account that the action needed (see isQuotaLimit). */
  readonly session: boolean;

  constructor(
    status: number,
    code: ClientErrorCode,
    message?: string,
    fields?: Record<string, string>,
    retryAfter?: number,
    meta: ApiClientErrorMeta = {},
  ) {
    super(message || MESSAGES[code]);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.retryAfter = retryAfter;
    this.fromApi = meta.fromApi ?? false;
    this.session = meta.session ?? false;
  }

  /** The same error, marked as raised by POST /api/session on the way to another request. */
  inSession(): ApiClientError {
    return new ApiClientError(this.status, this.code, this.message, this.fields, this.retryAfter, { fromApi: this.fromApi, session: true });
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

/**
 * The action's own quota refused it: a 429 from the API (its JSON error) for this request. Not the
 * account creation in front of it (new accounts are limited per network and overall), and not the
 * edge throttle — those clear soon and must not be shown as 「今日の〇〇はここまで」.
 */
export function isQuotaLimit(err: unknown): boolean {
  return err instanceof ApiClientError && err.status === 429 && err.fromApi && !err.session;
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
    return new ApiClientError(status, code, message, fields, retryAfter, { fromApi: true });
  }
  return new ApiClientError(status, fallbackCode, status === 429 ? THROTTLED_MESSAGE : undefined, undefined, retryAfter);
}

/** Methods the API only accepts as JSON (415 otherwise), even when there is nothing to say. */
const JSON_METHODS = new Set(["POST", "PUT", "PATCH"]);

/**
 * The wire body: JSON for a given body (any method, so a DELETE with a body works too), "{}" for
 * POST / PUT / PATCH without one, nothing otherwise. Content-Type is application/json whenever
 * there is a body.
 */
export function requestBody(method: string, body: unknown): string | undefined {
  if (body !== undefined) return JSON.stringify(body);
  return JSON_METHODS.has(method.toUpperCase()) ? "{}" : undefined;
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
  const body = requestBody(method, opts.body);
  if (body !== undefined) headers["Content-Type"] = "application/json";

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
