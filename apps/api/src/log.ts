/**
 * Structured JSON logs (one line per event). Personal data stays out of the logs:
 * fields with sensitive names are dropped and user ids are shortened to 6 characters.
 */
import type { LogLevel } from "./config";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Field names that must never reach a log line (SPEC: Logging). */
const DROP = new Set([
  "token",
  "authorization",
  "note",
  "notes",
  "shownNote",
  "body",
  "story",
  "reflection",
  "hint",
  "endpoint",
  "keys",
  "p256dh",
  "auth",
  "ip",
  "replyTo",
]);
const USER_ID_FIELDS = new Set(["uid", "userId", "user"]);

let threshold = RANK.info;

export function setLogLevel(level: LogLevel): void {
  threshold = RANK[level];
}

export function shortId(uid: string | undefined | null): string | undefined {
  return uid ? uid.slice(0, 6) : undefined;
}

export type LogFields = Record<string, unknown>;

function serialiseError(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack?.split("\n").slice(0, 8).join("\n") };
  }
  return String(err);
}

function clean(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || DROP.has(k)) continue;
    if (USER_ID_FIELDS.has(k) && typeof v === "string") out[k] = shortId(v);
    else if (k === "err" || k === "error") out[k] = serialiseError(v);
    else out[k] = v;
  }
  return out;
}

function write(level: Exclude<LogLevel, "silent">, msg: string, fields?: LogFields): void {
  if (RANK[level] < threshold) return;
  const line = JSON.stringify({ level, msg, time: new Date().toISOString(), ...(fields ? clean(fields) : {}) });
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

export const log = {
  debug: (msg: string, fields?: LogFields) => write("debug", msg, fields),
  info: (msg: string, fields?: LogFields) => write("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => write("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => write("error", msg, fields),
};
