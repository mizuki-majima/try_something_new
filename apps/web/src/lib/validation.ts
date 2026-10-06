/**
 * Form validation with the shared zod schemas (the API re-validates with the same ones).
 * Typed structurally so the web app does not depend on zod directly.
 */
type Issue = { path: readonly PropertyKey[]; message: string };
type SafeParser<T> = {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: readonly Issue[] } };
};

export type Failure = { ok: false; message: string; fields: Record<string, string> };
export type ActionResult<T = void> = { ok: true; value: T } | Failure;

export function ok(): ActionResult<void>;
export function ok<T>(value: T): ActionResult<T>;
export function ok<T>(value?: T): ActionResult<T | undefined> {
  return { ok: true, value };
}

export function fail(message: string, fields: Record<string, string> = {}): Failure {
  return { ok: false, message, fields };
}

/** First message per field ("how.1" for array items, "_" for form-level issues). */
export function fieldErrors(issues: readonly Issue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join(".") || "_";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

export function parseWith<T>(schema: SafeParser<T>, input: unknown): { ok: true; data: T } | Failure {
  const r = schema.safeParse(input);
  if (r.success) return { ok: true, data: r.data };
  return fail(r.error.issues[0]?.message ?? "入力内容を確認してください。", fieldErrors(r.error.issues));
}
