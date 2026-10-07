/**
 * localStorage wrappers. Storage can be missing or throw (private windows, blocked site data,
 * quota), so every access is guarded and an in-memory copy keeps the session working.
 */
const memory = new Map<string, string>();

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readString(key: string): string | null {
  try {
    const v = store()?.getItem(key);
    if (v != null) return v;
  } catch {
    // fall through to memory
  }
  return memory.get(key) ?? null;
}

export function writeString(key: string, value: string): void {
  try {
    const s = store();
    if (s) {
      s.setItem(key, value);
      memory.delete(key);
      return;
    }
  } catch {
    // Quota or blocked: drop the stale stored copy so reads see the in-memory value.
    try {
      store()?.removeItem(key);
    } catch {
      // ignore
    }
  }
  memory.set(key, value);
}

export function removeKey(key: string): void {
  memory.delete(key);
  try {
    store()?.removeItem(key);
  } catch {
    // ignore
  }
}

export function readJson<T>(key: string): T | null {
  const raw = readString(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown): void {
  writeString(key, JSON.stringify(value));
}

/** Storage keys used by the app (one place, so "delete all data" can find them). */
export const KEYS = {
  token: "thirty-days.token",
  sessionInvalid: "thirty-days.session-invalid",
  state: "thirty-days.state.v1",
  outbox: "thirty-days.outbox.v1",
  theme: "thirty-days.theme",
} as const;
