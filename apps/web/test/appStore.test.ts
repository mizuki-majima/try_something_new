import { API, LIMITS, type Challenge, type User } from "@thirty/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppStore, type AppStore, type Notice } from "../src/lib/appStore";
import { clearSession } from "../src/lib/session";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Just enough of the API for the store's routes. */
function fakeApi() {
  const challenges = new Map<string, Challenge>();
  let user: User = { id: "u0000000000001", nickname: "", tz: "UTC", shareProgress: true, reminder: { enabled: false, time: "21:00" }, createdAt: 1 };
  const calls: string[] = [];
  const bodies: unknown[] = [];
  let failWith: ((method: string, url: string) => Response | Error | null) | null = null;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    bodies.push(body);
    const f = failWith?.(method, url);
    if (f instanceof Error) throw f;
    if (f) return f;

    if (url === API.session && method === "POST") {
      user = { ...user, nickname: typeof body?.nickname === "string" ? body.nickname : "" };
      return json(201, { token: "tok", user });
    }
    if (url === API.me && method === "GET") return json(200, { user, today: "2026-10-06" });
    if (url === API.me && method === "PATCH") {
      user = { ...user, ...(body as Partial<User>) };
      return json(200, { user, today: "2026-10-06" });
    }
    if (url === API.challenges && method === "GET") return json(200, { challenges: [...challenges.values()], today: "2026-10-06" });
    if (url === API.challenges && method === "POST") {
      const b = body as { id: string; title: string; seal: string; startDate: string; recipeId?: string | null };
      const c: Challenge = {
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
        createdAt: 5,
        updatedAt: 5,
      };
      challenges.set(c.id, challenges.get(c.id) ?? c);
      return json(201, { challenge: challenges.get(c.id) });
    }
    const m = /^\/api\/challenges\/([0-9a-z]+)\/stamps\/(\d+)$/.exec(url);
    if (m) {
      const c = challenges.get(m[1]!);
      if (!c) return json(404, { error: { code: "not_found", message: "見つかりません" } });
      const stamps = { ...c.stamps };
      if (method === "PUT") stamps[m[2]!] = { at: 7, ...(typeof body?.note === "string" && body.note ? { note: body.note } : {}) };
      else delete stamps[m[2]!];
      const next = { ...c, stamps, updatedAt: 8 };
      challenges.set(c.id, next);
      return json(200, { challenge: next });
    }
    return json(404, { error: { code: "not_found", message: "no route" } });
  });

  return {
    fetchMock,
    calls,
    bodies,
    challenges,
    fail(fn: typeof failWith) {
      failWith = fn;
    },
  };
}

let api: ReturnType<typeof fakeApi>;
let store: AppStore;
let stop: () => void;
let notices: Notice[];

beforeEach(() => {
  clearSession();
  api = fakeApi();
  vi.stubGlobal("fetch", api.fetchMock);
  store = createAppStore();
  stop = store.start();
  notices = [];
  store.onNotice((n) => notices.push(n));
});

afterEach(() => {
  stop();
  vi.unstubAllGlobals();
});

const today = () => store.getSnapshot().today;

function start(title = "毎日1枚、写真を撮る", nickname?: string) {
  const r = store.actions.startChallenge({ title, seal: "写", startDate: today(), recipeId: "photo", nickname });
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

describe("app store", () => {
  it("shows a new challenge at once and syncs it, creating the account with the nickname", async () => {
    const ch = start(undefined, "みず");
    let snap = store.getSnapshot();
    expect(snap.challenges.map((c) => c.id)).toEqual([ch.id]);
    expect(snap.pending).toBe(1);
    expect(snap.hasSession).toBe(false);
    expect(snap.pendingNickname).toBe("みず");

    await store.actions.flush();
    snap = store.getSnapshot();
    expect(api.calls).toEqual([`POST ${API.session}`, `POST ${API.challenges}`]);
    expect(api.bodies[0]).toMatchObject({ nickname: "みず" });
    expect(snap.pending).toBe(0);
    expect(snap.syncStatus).toBe("synced");
    expect(snap.user?.nickname).toBe("みず");
    expect(snap.challenges[0]).toMatchObject({ id: ch.id, createdAt: 5 }); // server copy
  });

  it("keeps a stamp on screen while the API is down and sends it after recovery", async () => {
    const ch = start();
    await store.actions.flush();

    api.fail(() => new TypeError("Failed to fetch"));
    expect(store.actions.stamp(ch.id, 1).ok).toBe(true);
    await store.actions.flush();
    let snap = store.getSnapshot();
    expect(snap.challenges[0]!.stamps["1"]).toBeTruthy();
    expect(snap.syncStatus).toBe("offline");
    expect(snap.pending).toBe(1);
    expect(snap.lastStamped).toMatchObject({ challengeId: ch.id, day: 1 });

    api.fail(null);
    await store.actions.flush();
    snap = store.getSnapshot();
    expect(snap.pending).toBe(0);
    expect(snap.syncStatus).toBe("synced");
    expect(api.challenges.get(ch.id)!.stamps["1"]).toBeTruthy();
  });

  it("rolls a rejected write back and tells the user", async () => {
    const ch = start();
    await store.actions.flush();

    api.fail((method, url) =>
      method === "PUT" && url.includes("/stamps/") ? json(409, { error: { code: "conflict", message: "この日はもう押せません" } }) : null,
    );
    store.actions.stamp(ch.id, 1);
    expect(store.getSnapshot().challenges[0]!.stamps["1"]).toBeTruthy();
    await store.actions.flush();
    expect(store.getSnapshot().challenges[0]!.stamps["1"]).toBeUndefined();
    expect(store.getSnapshot().pending).toBe(0);
    expect(notices).toEqual([{ kind: "error", message: "保存できませんでした。この日はもう押せません" }]);
  });

  it("flags the session on 401 and keeps writes queued", async () => {
    const ch = start();
    await store.actions.flush();

    api.fail(() => json(401, { error: { code: "unauthorized", message: "無効なトークン" } }));
    store.actions.stamp(ch.id, 1);
    await store.actions.flush();
    const snap = store.getSnapshot();
    expect(snap.sessionInvalid).toBe(true);
    expect(snap.syncStatus).toBe("error");
    expect(snap.pending).toBe(1);
    expect(snap.challenges[0]!.stamps["1"]).toBeTruthy();
  });

  it("validates locally: future days, notes on unstamped days, the open-challenge limit", () => {
    const ch = start();
    expect(store.actions.stamp(ch.id, 2)).toMatchObject({ ok: false, message: "まだ先の日です。" });
    expect(store.actions.setNote(ch.id, 1, "メモ").ok).toBe(false);
    expect(store.actions.reflect(ch.id, "stop").ok).toBe(false); // day 1 < 7

    for (let i = 1; i < LIMITS.openChallenges; i++) start(`チャレンジ${i}`);
    const sixth = store.actions.startChallenge({ title: "もうひとつ", seal: "他", startDate: today() });
    expect(sixth.ok).toBe(false);
  });

  it("deleting an unsynced challenge never touches the network", async () => {
    api.fail(() => new TypeError("offline"));
    const ch = start();
    store.actions.stamp(ch.id, 1);
    store.actions.deleteChallenge(ch.id);
    const snap = store.getSnapshot();
    expect(snap.challenges).toEqual([]);
    expect(snap.pending).toBe(0);
    api.fail(null);
    await store.actions.flush();
    expect(api.calls.some((c) => c.startsWith("POST /api/challenges") || c.startsWith("DELETE"))).toBe(false);
  });

  it("a delete answered 404 (already gone, e.g. deleted on another device) stays deleted without an error", async () => {
    const ch = start();
    await store.actions.flush();
    api.challenges.delete(ch.id); // gone on the server
    api.fail((method, url) =>
      method === "DELETE" && url === API.challenge(ch.id) ? json(404, { error: { code: "not_found", message: "見つかりません" } }) : null,
    );
    expect(store.actions.deleteChallenge(ch.id).ok).toBe(true);
    await store.actions.flush();
    const snap = store.getSnapshot();
    expect(api.calls).toContain(`DELETE ${API.challenge(ch.id)}`);
    expect(snap.challenges).toEqual([]);
    expect(snap.pending).toBe(0);
    expect(snap.syncStatus).toBe("synced");
    expect(notices).toEqual([]);
  });
});
