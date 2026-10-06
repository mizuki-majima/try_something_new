import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import type { ApiError, ErrorCode } from "@thirty/shared";
import { log } from "./log";

export class HttpError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ErrorCode;
  readonly fields?: Record<string, string>;
  readonly headers?: Record<string, string>;

  constructor(
    status: ContentfulStatusCode,
    code: ErrorCode,
    message: string,
    fields?: Record<string, string>,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.headers = headers;
  }
}

export const MESSAGES = {
  badJson: "リクエストの形式が正しくありません",
  unauthorized: "利用登録が見つかりません。もう一度始めるか、引き継ぎコードで復元してください",
  forbidden: "この操作は許可されていません",
  notFound: "見つかりませんでした",
  internal: "サーバーで問題が起きました。時間をおいてもう一度お試しください",
  unsupportedMediaType: "Content-Type は application/json にしてください",
  payloadTooLarge: "送信するデータが大きすぎます",
  suggestionsUnavailable: "いまは提案を作れません",
} as const;

export const badRequest = (message: string, fields?: Record<string, string>) =>
  new HttpError(400, "bad_request", message, fields);
export const unauthorized = (message: string = MESSAGES.unauthorized) => new HttpError(401, "unauthorized", message);
export const forbidden = (message: string = MESSAGES.forbidden) => new HttpError(403, "forbidden", message);
export const notFound = (message: string = MESSAGES.notFound) => new HttpError(404, "not_found", message);
export const conflict = (message: string) => new HttpError(409, "conflict", message);

export function errorBody(code: ErrorCode, message: string, fields?: Record<string, string>): ApiError {
  return { error: fields && Object.keys(fields).length > 0 ? { code, message, fields } : { code, message } };
}

export function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
  fields?: Record<string, string>,
): Response {
  return c.json(errorBody(code, message, fields), status);
}

/** path → first message for each invalid field ("" for the root object). */
export function zodFields(err: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.map(String).join(".") || "_";
    if (!(key in fields)) fields[key] = issue.message;
  }
  return fields;
}

function isZodError(err: unknown): err is ZodError {
  return err instanceof ZodError || (err instanceof Error && err.name === "ZodError" && Array.isArray((err as ZodError).issues));
}

const STATUS_CODES: Partial<Record<number, ErrorCode>> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  415: "unsupported_media_type",
  429: "rate_limited",
  503: "ai_unavailable",
};

export const onError: ErrorHandler = (err, c) => {
  if (err instanceof HttpError) {
    if (err.headers) for (const [k, v] of Object.entries(err.headers)) c.header(k, v);
    return errorResponse(c, err.status, err.code, err.message, err.fields);
  }
  if (isZodError(err)) {
    const fields = zodFields(err);
    return errorResponse(c, 400, "bad_request", err.issues[0]?.message ?? MESSAGES.badJson, fields);
  }
  if (err instanceof HTTPException && err.status < 500) {
    const code = STATUS_CODES[err.status] ?? "bad_request";
    return errorResponse(c, err.status, code, code === "bad_request" ? MESSAGES.badJson : err.message || code);
  }
  log.error("unhandled error", { method: c.req.method, path: c.req.path, err });
  return errorResponse(c, 500, "internal", MESSAGES.internal);
};

export const onNotFound: NotFoundHandler = (c) => {
  if (c.req.path.startsWith("/api/") || c.req.path === "/api") return errorResponse(c, 404, "not_found", MESSAGES.notFound);
  return c.text("Not Found", 404);
};
