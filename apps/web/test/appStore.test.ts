import { API, LIMITS, type Challenge, type User } from "@thirty/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../src/lib/api";
import { PROFILE_LIMIT_MESSAGE, createAppStore, type AppStore, type Notice } from "../src/lib/appStore";
import { clearSession, getToken } from "../src/lib/session";
import { RECIPE_CACHES } from "../src/lib/swCaches";

const photos = vi.hoisted(() => ({ clearAllPhotos: vi.fn(async () => {}) }));
vi.mock("../src/lib/photos", () => photos);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Just enough of the API for the store's routes. */
function fakeApi() {
  const challenges = new Map<string, Challenge>();
  let user: User = { id: "u0000000000001", nickname: "", tz: "UTC", shareProgress: true, reminder: { enabled: false, time: "21:00" }, createdAt: 1 };
  /** The account a transfer code belongs to (POST /api/session/transfer). */
  let transferUser: User = user;
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
    if (url === API.sessionTransfer && method === "POST") {
      user = transferUser;
      return json(200, { token: "tok-transfer", user });
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
    setTransferUser(u: User) {
      transferUser = u;
    },
    get user() {
      return user;
    },
  };
}

let api: ReturnType<typeof fakeApi>;
let store: AppStore;
let stop: () => void;
let notices: Notice[];
let cacheDelete: ReturnType<typeof vi.fn<(name: string) => Promise<boolean>>>;

beforeEach(() => {
  clearSession();
  api = fakeApi();
  vi.stubGlobal("fetch", api.fetchMock);
  cacheDelete = vi.fn(async () => true);
  vi.stubGlobal("caches", { delete: cacheDelete });
  photos.clearAllPhotos.mockClear();
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

  it("a create refused by the daily quota (429) is rolled back with 「今日はここまで」 and does not block later writes", async () => {
    const kept = start("残すもの");
    await store.actions.flush();

    api.fail((method, url) =>
      method === "POST" && url === API.challenges
        ? new Response(JSON.stringify({ error: { code: "rate_limited", message: "今日はここまでです。日本時間の0時を過ぎると、また使えます" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "51365" },
          })
        : null,
    );
    const eleventh = start("11件目");
    expect(store.actions.stamp(kept.id, 1).ok).toBe(true);
    expect(store.getSnapshot().challenges.map((c) => c.id)).toContain(eleventh.id);

    await store.actions.flush();
    const snap = store.getSnapshot();
    expect(snap.challenges.map((c) => c.id)).not.toContain(eleventh.id); // rolled back
    expect(snap.pending).toBe(0);
    expect(snap.syncStatus).toBe("synced");
    expect(api.challenges.get(kept.id)!.stamps["1"]).toBeTruthy(); // the stamp behind it was sent
    expect(notices).toEqual([{ kind: "error", message: `今日はここまで（あすの0時にリセット）。新しく始められるのは1日10件までです。` }]);
    expect(api.calls.filter((c) => c === `POST ${API.challenges}`)).toHaveLength(2); // never retried
  });

  it("a short 429 is retried later and is not shown as offline", async () => {
    const ch = start();
    await store.actions.flush();
    api.fail((method, url) =>
      method === "PUT" && url.includes("/stamps/")
        ? new Response(JSON.stringify({ error: { code: "rate_limited", message: "少し待ってください" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "30" },
          })
        : null,
    );
    store.actions.stamp(ch.id, 1);
    const before = Date.now();
    await store.actions.flush();
    let snap = store.getSnapshot();
    expect(snap.pending).toBe(1);
    expect(snap.challenges[0]!.stamps["1"]).toBeTruthy();
    // Visible "waiting", with the server's reason and when it resumes (Retry-After: 30 s).
    expect(snap.syncStatus).toBe("waiting");
    expect(snap.throttle?.reason).toBe("少し待ってください。");
    expect(snap.throttle!.until).toBeGreaterThanOrEqual(before + 30_000);
    expect(notices).toEqual([]);

    api.fail(null);
    await store.actions.flush();
    snap = store.getSnapshot();
    expect(snap.pending).toBe(0);
    expect(api.challenges.get(ch.id)!.stamps["1"]).toBeTruthy();
  });

  it("R9: a throttle 429 on a create (API Gateway: no Retry-After, no app body) keeps the challenge and its stamp and sends them later", async () => {
    api.fail((method, url) =>
      method === "POST" && url === API.challenges
        ? new Response('{"message":"Too Many Requests"}', { status: 429, headers: { "Content-Type": "application/json" } })
        : null,
    );
    const ch = start("止めないもの");
    expect(store.actions.stamp(ch.id, 1).ok).toBe(true);
    await store.actions.flush();
    let snap = store.getSnapshot();
    expect(snap.challenges.map((c) => c.id)).toEqual([ch.id]); // not rolled back
    expect(snap.challenges[0]!.stamps["1"]).toBeTruthy();
    expect(snap.pending).toBe(2);
    expect(snap.syncStatus).toBe("waiting");
    expect(snap.throttle?.reason).toBe("混み合っています。"); // not 「今日はここまで」
    expect(notices).toEqual([]);

    api.fail(null);
    await store.actions.flush();
    snap = store.getSnapshot();
    expect(snap.pending).toBe(0);
    expect(snap.syncStatus).toBe("synced");
    expect(snap.throttle).toBeNull();
    expect(api.challenges.get(ch.id)!.stamps["1"]).toBeTruthy();
  });

  it("r2-web-6: a 429 on creating the account shows a visible wait (reason + when), keeps the writes and backs off", async () => {
    api.fail((method, url) =>
      method === "POST" && url === API.session
        ? new Response(JSON.stringify({ error: { code: "rate_limited", message: "短い時間に操作が集中しています。しばらくしてからもう一度お試しください" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "1200" },
          })
        : null,
    );
    const ch = start();
    const before = Date.now();
    await store.actions.flush();
    let snap = store.getSnapshot();
    expect(snap.syncStatus).toBe("waiting");
    expect(snap.throttle?.reason).toBe("混み合っています。");
    expect(snap.throttle!.until).toBeGreaterThanOrEqual(before + 1_200_000);
    expect(snap.challenges.map((c) => c.id)).toEqual([ch.id]);
    expect(snap.pending).toBe(1);
    expect(notices).toEqual([]);

    api.fail(null);
    await store.actions.flush();
    snap = store.getSnapshot();
    expect(snap.syncStatus).toBe("synced");
    expect(snap.throttle).toBeNull();
    expect(api.challenges.has(ch.id)).toBe(true);
  });

  it("R1: a profile change refused by the daily quota is rolled back, explained, and further profile changes wait until the reset", async () => {
    start();
    await store.actions.flush();
    const before = store.getSnapshot().user?.nickname;
    api.fail((method, url) =>
      method === "PATCH" && url === API.me
        ? new Response(JSON.stringify({ error: { code: "rate_limited", message: "今日はここまでです。日本時間の0時を過ぎると、また使えます" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "40000" },
          })
        : null,
    );
    expect(store.actions.updateMe({ nickname: "あたらしい" }).ok).toBe(true);
    expect(store.getSnapshot().user?.nickname).toBe("あたらしい"); // optimistic
    await store.actions.flush();
    const snap = store.getSnapshot();
    expect(snap.user?.nickname).toBe(before); // rolled back
    expect(snap.pending).toBe(0);
    expect(notices).toEqual([{ kind: "error", message: `今日はここまで（あすの0時にリセット）。${PROFILE_LIMIT_MESSAGE}` }]);
    expect(snap.profileLimitedUntil).toBeGreaterThan(Date.now() + 39_000_000);

    // Refused locally now (no doomed request), but other settings still go through.
    const calls = api.calls.length;
    const again = store.actions.updateMe({ nickname: "みず" });
    expect(again).toMatchObject({ ok: false, message: PROFILE_LIMIT_MESSAGE, fields: { nickname: PROFILE_LIMIT_MESSAGE } });
    api.fail(null);
    expect(store.actions.updateMe({ reminder: { enabled: true, time: "21:00" } }).ok).toBe(true);
    await store.actions.flush();
    expect(api.calls.slice(calls).filter((c) => c === `PATCH ${API.me}`)).toHaveLength(1);
    expect(api.bodies[api.calls.lastIndexOf(`PATCH ${API.me}`)]).toEqual({ reminder: { enabled: true, time: "21:00" } });
  });

  it("R13: while the profile quota refuses changes, turning 「みんなに表示」 off still goes out; turning it on waits", async () => {
    start();
    await store.actions.flush();
    api.fail((method, url) =>
      method === "PATCH" && url === API.me
        ? new Response(JSON.stringify({ error: { code: "rate_limited", message: "今日はここまでです" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "40000" },
          })
        : null,
    );
    store.actions.updateMe({ nickname: "みず" });
    await store.actions.flush();
    expect(store.getSnapshot().profileLimitedUntil).not.toBeNull();
    api.fail(null);

    const calls = api.calls.length;
    // A privacy action: the API never refuses it (R13), so neither does the device (before: refused here).
    expect(store.actions.updateMe({ shareProgress: false })).toMatchObject({ ok: true });
    await store.actions.flush();
    expect(api.bodies[api.calls.lastIndexOf(`PATCH ${API.me}`)]).toEqual({ shareProgress: false });
    expect(api.calls.length).toBeGreaterThan(calls);
    expect(store.getSnapshot().user?.shareProgress).toBe(false);
    // Turning it back on publishes again, so it waits for the reset like a rename.
    expect(store.actions.updateMe({ shareProgress: true })).toMatchObject({ ok: false, message: PROFILE_LIMIT_MESSAGE });
  });

  it("R1: the profile limit clears by itself when the quota resets", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      start();
      await store.actions.flush();
      api.fail((method, url) =>
        method === "PATCH" && url === API.me
          ? new Response(JSON.stringify({ error: { code: "rate_limited", message: "今日はここまでです" } }), {
              status: 429,
              headers: { "Content-Type": "application/json", "Retry-After": "7200" },
            })
          : null,
      );
      store.actions.updateMe({ nickname: "みず" });
      await store.actions.flush();
      expect(store.getSnapshot().profileLimitedUntil).not.toBeNull();
      vi.advanceTimersByTime(7_200_000);
      expect(store.getSnapshot().profileLimitedUntil).toBeNull();
      expect(store.actions.updateMe({ nickname: "みず" }).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("adopts an account created outside its queue (a cheer, a report) at once", async () => {
    expect(store.getSnapshot().user).toBeNull();
    await request("GET", API.me, { auth: "required" });
    expect(getToken()).toBe("tok");
    const snap = store.getSnapshot();
    expect(snap.user?.id).toBe("u0000000000001");
    expect(snap.hasSession).toBe(true);
  });

  it("sends the start sheet's nickname when another request created the account", async () => {
    api.fail(() => new TypeError("Failed to fetch"));
    const ch = start(undefined, "はなこ");
    await store.actions.flush(); // POST /api/session fails: still no account
    expect(getToken()).toBeNull();
    expect(store.getSnapshot().pendingNickname).toBe("はなこ");

    api.fail(null);
    await request("GET", API.me, { auth: "required" }); // e.g. a cheer: creates the account without the nickname
    await store.actions.flush();
    const snap = store.getSnapshot();
    expect(api.calls).toContain(`PATCH ${API.me}`);
    expect(api.user.nickname).toBe("はなこ");
    expect(snap.pendingNickname).toBeNull();
    expect(snap.user?.nickname).toBe("はなこ");
    expect(snap.pending).toBe(0);
    expect(api.challenges.has(ch.id)).toBe(true);
  });

  it("resetLocal also forgets this device's day photos and the cached recipe responses", async () => {
    start();
    await store.actions.flush();
    store.actions.resetLocal();
    expect(store.getSnapshot().challenges).toEqual([]);
    await vi.waitFor(() => expect(photos.clearAllPhotos).toHaveBeenCalledTimes(1));
    expect(cacheDelete.mock.calls.map(([name]) => name).sort()).toEqual([...RECIPE_CACHES].sort());
  });

  it("restoring another account clears the previous one's photos; any restore clears the recipe caches", async () => {
    start();
    await store.actions.flush();

    api.setTransferUser({ ...api.user }); // same account
    expect((await store.actions.restoreWithCode("ABCD2345")).ok).toBe(true);
    expect(photos.clearAllPhotos).not.toHaveBeenCalled();
    expect(cacheDelete).toHaveBeenCalledTimes(RECIPE_CACHES.length);

    api.setTransferUser({ ...api.user, id: "u0000000000002", nickname: "べつ" });
    expect((await store.actions.restoreWithCode("ABCD2345")).ok).toBe(true);
    expect(photos.clearAllPhotos).toHaveBeenCalledTimes(1);
    expect(cacheDelete).toHaveBeenCalledTimes(RECIPE_CACHES.length * 2);
    expect(store.getSnapshot().user?.id).toBe("u0000000000002");
  });
});
