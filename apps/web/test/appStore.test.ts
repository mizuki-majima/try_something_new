import { API, LIMITS, type Challenge, type User } from "@thirty/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../src/lib/api";
import { PROFILE_LIMIT_MESSAGE, createAppStore, type AppStore, type Notice } from "../src/lib/appStore";
import { NOTE_SHOW_ERRORS } from "../src/lib/noteShare";
import { clearSession, getToken } from "../src/lib/session";
import { KEYS, readJson } from "../src/lib/storage";
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
    // PUT .../visibility (#17): the API's checks that matter here; it leaves updatedAt alone.
    const v = /^\/api\/challenges\/([0-9a-z]+)\/stamps\/(\d+)\/visibility$/.exec(url);
    if (v && method === "PUT") {
      const c = challenges.get(v[1]!);
      const s = c?.stamps[v[2]!];
      if (!c) return json(404, { error: { code: "not_found", message: "見つかりません" } });
      if (body?.show === true) {
        if (!s?.note) return json(400, { error: { code: "bad_request", message: "ひとことがある日だけ、みんなに見せられます。", fields: { note: "ひとことがある日だけ、みんなに見せられます。" } } });
        if (body.note !== s.note) return json(409, { error: { code: "conflict", message: "ひとことが変わっていたため、見せませんでした。" } });
        if (!user.shareProgress) return json(409, { error: { code: "conflict", message: "進捗の表示がオフのため、見せられません。" } });
      }
      if (!s) return json(200, { challenge: c });
      const next = { ...c, stamps: { ...c.stamps, [v[2]!]: body?.show === true ? { ...s, shown: true } : { at: s.at, ...(s.note ? { note: s.note } : {}) } } };
      challenges.set(c.id, next);
      return json(200, { challenge: next });
    }
    const m = /^\/api\/challenges\/([0-9a-z]+)\/stamps\/(\d+)$/.exec(url);
    if (m) {
      const c = challenges.get(m[1]!);
      if (!c) return json(404, { error: { code: "not_found", message: "見つかりません" } });
      const stamps = { ...c.stamps };
      if (method === "PUT") {
        // The API's rule (#17): a shown note stays shown only for a re-stamp or the same text.
        const prev = c.stamps[m[2]!];
        const note = typeof body?.note === "string" ? body.note : prev?.note;
        const keep = !!note && prev?.shown === true && note === prev.note;
        stamps[m[2]!] = { at: 7, ...(note ? { note } : {}), ...(keep ? { shown: true } : {}) };
      } else delete stamps[m[2]!];
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

describe("app store: a day note shown in 「みんな」 (#17)", () => {
  const visibility = (id: string, day: number) => `PUT ${API.noteVisibility(id, day)}`;
  const queued = () => readJson<unknown[]>(KEYS.outbox) ?? [];

  /** fetch that waits for `release()` before answering the requests `hold` picks. */
  function gate(hold: (method: string, url: string) => boolean) {
    let release!: () => void;
    const open = new Promise<void>((r) => (release = r));
    const held: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (!hold(method, String(input))) return api.fetchMock(input, init);
      held.push(`${method} ${String(input)}`);
      // The answer is what the server had when the request arrived.
      const res = await api.fetchMock(input, init);
      await open;
      return res;
    });
    return { release, held };
  }

  async function withNote(note = "朝の光") {
    const ch = start();
    expect(store.actions.stamp(ch.id, 1, note).ok).toBe(true);
    await store.actions.flush();
    return ch;
  }

  it("is not optimistic: the view changes when the server confirms, and nothing is queued", async () => {
    const ch = await withNote();
    const g = gate((method, url) => method === "PUT" && url.endsWith("/visibility"));
    const pending = store.actions.setNoteShown(ch.id, 1, true, "朝の光");
    await vi.waitFor(() => expect(g.held).toEqual([visibility(ch.id, 1)]));
    expect(store.getSnapshot().challenges[0]!.stamps["1"]).toEqual({ at: 7, note: "朝の光" });
    expect(store.getSnapshot().pending).toBe(0);
    expect(queued()).toEqual([]);

    g.release();
    expect(await pending).toEqual({ ok: true, value: undefined });
    expect(api.bodies[api.calls.lastIndexOf(visibility(ch.id, 1))]).toEqual({ show: true, note: "朝の光" });
    expect(store.getSnapshot().challenges[0]!.stamps["1"]).toEqual({ at: 7, note: "朝の光", shown: true });
    expect(queued()).toEqual([]);

    // Back to private: no question, the same way.
    expect((await store.actions.setNoteShown(ch.id, 1, false)).ok).toBe(true);
    expect(api.bodies[api.calls.lastIndexOf(visibility(ch.id, 1))]).toEqual({ show: false });
    expect(store.getSnapshot().challenges[0]!.stamps["1"]).toEqual({ at: 7, note: "朝の光" });
  });

  it("works on a reflected challenge, both ways", async () => {
    const ch = await withNote();
    const done = { ...api.challenges.get(ch.id)!, status: "done" as const, verdict: "continue" as const, finishedAt: 9, finishedDay: 7 };
    api.challenges.set(ch.id, done);
    await store.actions.refresh();
    expect(store.actions.setNote(ch.id, 1, "書き換え").ok).toBe(false); // the note itself stays as it is
    expect((await store.actions.setNoteShown(ch.id, 1, true, "朝の光")).ok).toBe(true);
    expect(api.challenges.get(ch.id)!.stamps["1"]?.shown).toBe(true);
    expect((await store.actions.setNoteShown(ch.id, 1, false)).ok).toBe(true);
    expect(store.getSnapshot().challenges[0]!.stamps["1"]?.shown).toBeUndefined();
  });

  it("sends a note saved a moment ago first, then shows exactly that text", async () => {
    const ch = await withNote();
    expect(store.actions.setNote(ch.id, 1, "  夕焼け   きれい ").ok).toBe(true);
    expect(store.getSnapshot().pending).toBe(1);
    const before = api.calls.length;
    expect((await store.actions.setNoteShown(ch.id, 1, true, "夕焼け きれい")).ok).toBe(true);
    expect(api.calls.slice(before)).toEqual([`PUT ${API.stamp(ch.id, 1)}`, visibility(ch.id, 1)]);
    expect(api.bodies[api.calls.lastIndexOf(visibility(ch.id, 1))]).toEqual({ show: true, note: "夕焼け きれい" });
    expect(store.getSnapshot().challenges[0]!.stamps["1"]).toMatchObject({ note: "夕焼け きれい", shown: true });
  });

  it("refuses while the note is still waiting to be sent, and refuses a text the owner did not see", async () => {
    const ch = await withNote();
    api.fail((method, url) => (method === "PUT" && url === API.stamp(ch.id, 1) ? new TypeError("Failed to fetch") : null));
    store.actions.setNote(ch.id, 1, "まだ送れていない");
    const before = api.calls.length;
    expect(await store.actions.setNoteShown(ch.id, 1, true, "まだ送れていない")).toMatchObject({ ok: false, message: NOTE_SHOW_ERRORS.pending });
    expect(api.calls.slice(before).some((c) => c.endsWith("/visibility"))).toBe(false);

    api.fail(null);
    await store.actions.flush();
    // The sheet asked about another text (e.g. synced from another device meanwhile).
    expect(await store.actions.setNoteShown(ch.id, 1, true, "朝の光")).toMatchObject({ ok: false, message: NOTE_SHOW_ERRORS.noteChanged });
    expect(api.calls.some((c) => c.endsWith("/visibility"))).toBe(false);
  });

  it("makes a note private at once, even while a write for the challenge is stuck in the queue", async () => {
    const ch = await withNote();
    expect((await store.actions.setNoteShown(ch.id, 1, true, "朝の光")).ok).toBe(true);
    api.fail((method, url) =>
      method === "PATCH" && url === API.challenge(ch.id) ? json(500, { error: { code: "internal", message: "うまくいきませんでした" } }) : null,
    );
    expect(store.actions.updateChallenge(ch.id, { title: "夕方に1枚、写真を撮る" }).ok).toBe(true);
    await store.actions.flush();
    expect(queued()).toHaveLength(1); // retried later, still in the queue

    expect((await store.actions.setNoteShown(ch.id, 1, false)).ok).toBe(true);
    expect(api.bodies[api.calls.lastIndexOf(visibility(ch.id, 1))]).toEqual({ show: false });
    expect(api.challenges.get(ch.id)!.stamps["1"]).toEqual({ at: 7, note: "朝の光" });
    expect(store.getSnapshot().challenges[0]).toMatchObject({ title: "夕方に1枚、写真を撮る", stamps: { "1": { at: 7, note: "朝の光" } } });
    expect(store.getSnapshot().challenges[0]!.stamps["1"]?.shown).toBeUndefined();
    expect(queued()).toHaveLength(1);
    // Showing it again waits for that write, and says so while it cannot be sent.
    expect(await store.actions.setNoteShown(ch.id, 1, true, "朝の光")).toMatchObject({ ok: false, message: NOTE_SHOW_ERRORS.pending });
  });

  it("sends 「みんなに表示」 turned on (still queued) before showing, and refuses while it cannot be sent", async () => {
    const ch = await withNote();
    expect(store.actions.updateMe({ shareProgress: false }).ok).toBe(true);
    await store.actions.flush();
    expect(api.user.shareProgress).toBe(false);
    api.fail((method, url) => (method === "PATCH" && url === API.me ? json(500, { error: { code: "internal", message: "うまくいきませんでした" } }) : null));
    expect(store.actions.updateMe({ shareProgress: true }).ok).toBe(true);
    await store.actions.flush();
    expect(queued()).toHaveLength(1);

    let before = api.calls.length;
    expect(await store.actions.setNoteShown(ch.id, 1, true, "朝の光")).toMatchObject({ ok: false, message: NOTE_SHOW_ERRORS.pending });
    expect(api.calls.slice(before).some((c) => c.endsWith("/visibility"))).toBe(false);

    api.fail(null);
    before = api.calls.length;
    expect((await store.actions.setNoteShown(ch.id, 1, true, "朝の光")).ok).toBe(true);
    expect(api.calls.slice(before)).toEqual([`PATCH ${API.me}`, visibility(ch.id, 1)]);
  });

  it("an edit and an edit back made offline still make a shown note private: the server gets both", async () => {
    const ch = await withNote();
    expect((await store.actions.setNoteShown(ch.id, 1, true, "朝の光")).ok).toBe(true);
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    try {
      expect(store.actions.setNote(ch.id, 1, "夕方の光").ok).toBe(true);
      expect(store.actions.setNote(ch.id, 1, "朝の光").ok).toBe(true);
      await store.actions.flush();
      expect(queued()).toHaveLength(2);
      // Private here, and the screen knows the server still shows it until the queue is sent.
      expect(store.getSnapshot().challenges[0]!.stamps["1"]).toEqual({ at: 7, note: "朝の光" });
      expect(store.getSnapshot().stillShown).toEqual([`${ch.id}#1`]);
    } finally {
      delete (navigator as { onLine?: boolean }).onLine;
    }
    const before = api.calls.length;
    await store.actions.flush();
    expect(api.calls.slice(before)).toEqual([`PUT ${API.stamp(ch.id, 1)}`, `PUT ${API.stamp(ch.id, 1)}`]);
    expect(api.challenges.get(ch.id)!.stamps["1"]).toEqual({ at: 7, note: "朝の光" });
    expect(store.getSnapshot().challenges[0]!.stamps["1"]).toEqual({ at: 7, note: "朝の光" });
    expect(store.getSnapshot().stillShown).toEqual([]);
  });

  it("after an edit of a shown note, says whether the server has it: private, still queued, or kept (refused)", async () => {
    const ch = await withNote();
    expect((await store.actions.setNoteShown(ch.id, 1, true, "朝の光")).ok).toBe(true);
    store.actions.setNote(ch.id, 1, "夕方の光");
    expect(await store.actions.afterShownNoteEdit(ch.id, 1)).toBe("private");
    expect(api.challenges.get(ch.id)!.stamps["1"]).toEqual({ at: 7, note: "夕方の光" });

    expect((await store.actions.setNoteShown(ch.id, 1, true, "夕方の光")).ok).toBe(true);
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    try {
      store.actions.setNote(ch.id, 1, "夜の光");
      expect(await store.actions.afterShownNoteEdit(ch.id, 1)).toBe("queued");
      expect(api.challenges.get(ch.id)!.stamps["1"]).toMatchObject({ note: "夕方の光", shown: true });
    } finally {
      delete (navigator as { onLine?: boolean }).onLine;
    }
    await store.actions.flush();
    expect(store.getSnapshot().stillShown).toEqual([]);

    // Turning 「みんなに表示」 off while offline: the shown note is still seen until it is sent.
    expect((await store.actions.setNoteShown(ch.id, 1, true, "夜の光")).ok).toBe(true);
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    try {
      store.actions.updateMe({ shareProgress: false });
      await store.actions.flush();
      expect(store.getSnapshot().challenges[0]!.stamps["1"]?.shown).toBe(true);
      expect(store.getSnapshot().stillShown).toEqual([`${ch.id}#1`]);
    } finally {
      delete (navigator as { onLine?: boolean }).onLine;
    }
    await store.actions.flush();
    expect(api.user.shareProgress).toBe(false);
    expect(store.getSnapshot().stillShown).toEqual([]);

    // Refused by the server (here a 409): the note is shown as before, and nothing says otherwise.
    api.fail((method, url) => (method === "PUT" && url === API.stamp(ch.id, 1) ? json(409, { error: { code: "conflict", message: "変えられません" } }) : null));
    store.actions.setNote(ch.id, 1, "朝の光");
    expect(await store.actions.afterShownNoteEdit(ch.id, 1)).toBe("kept");
    expect(store.getSnapshot().challenges[0]!.stamps["1"]).toMatchObject({ note: "夜の光", shown: true });
  });

  it("counts 「みんなに表示」 turned on in the queue: sent before a later edit, it shows the old text on the way", async () => {
    const ch = await withNote();
    expect((await store.actions.setNoteShown(ch.id, 1, true, "朝の光")).ok).toBe(true);
    store.actions.updateMe({ shareProgress: false });
    await store.actions.flush();
    expect(api.user.shareProgress).toBe(false); // still chosen, seen by nobody

    // Progress on first, then the edit: the server shows 「朝の光」 between the two sends.
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    try {
      store.actions.updateMe({ shareProgress: true });
      expect(store.getSnapshot().stillShown).toEqual([]); // still shown in the view
      store.actions.setNote(ch.id, 1, "夕方の光");
      expect(await store.actions.afterShownNoteEdit(ch.id, 1)).toBe("queued");
      expect(store.getSnapshot().stillShown).toEqual([`${ch.id}#1`]);
    } finally {
      delete (navigator as { onLine?: boolean }).onLine;
    }
    let before = api.calls.length;
    await store.actions.flush();
    expect(api.calls.slice(before)).toEqual([`PATCH ${API.me}`, `PUT ${API.stamp(ch.id, 1)}`]);
    expect(store.getSnapshot().stillShown).toEqual([]);

    // The other order: the edit goes first, so the old text is never seen again.
    expect((await store.actions.setNoteShown(ch.id, 1, true, "夕方の光")).ok).toBe(true);
    store.actions.updateMe({ shareProgress: false });
    await store.actions.flush();
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    try {
      store.actions.setNote(ch.id, 1, "夜の光");
      store.actions.updateMe({ shareProgress: true });
      expect(await store.actions.afterShownNoteEdit(ch.id, 1)).toBe("private");
      expect(store.getSnapshot().stillShown).toEqual([]);
    } finally {
      delete (navigator as { onLine?: boolean }).onLine;
    }
    before = api.calls.length;
    await store.actions.flush();
    expect(api.calls.slice(before)).toEqual([`PUT ${API.stamp(ch.id, 1)}`, `PATCH ${API.me}`]);
    expect(api.challenges.get(ch.id)!.stamps["1"]).toEqual({ at: 7, note: "夜の光" });
  });

  it("checks on the device first: no note, a URL, progress off, offline", async () => {
    const ch = start();
    store.actions.stamp(ch.id, 1);
    store.actions.stamp(ch.id, 1, "https://example.com を見た");
    await store.actions.flush();
    expect(await store.actions.setNoteShown(ch.id, 2, true)).toMatchObject({ ok: false, message: NOTE_SHOW_ERRORS.noteMissing });
    expect(await store.actions.setNoteShown(ch.id, 1, true)).toMatchObject({ ok: false, message: NOTE_SHOW_ERRORS.url });
    store.actions.setNote(ch.id, 1, "朝の光");
    store.actions.updateMe({ shareProgress: false });
    expect(await store.actions.setNoteShown(ch.id, 1, true)).toMatchObject({ ok: false, message: NOTE_SHOW_ERRORS.progressOff });
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    try {
      expect(await store.actions.setNoteShown(ch.id, 1, false)).toMatchObject({ ok: false, message: NOTE_SHOW_ERRORS.offline });
    } finally {
      delete (navigator as { onLine?: boolean }).onLine;
    }
    expect(api.calls.some((c) => c.endsWith("/visibility"))).toBe(false);
  });

  it("explains the server's refusals: 400, 409, the daily limit (429), no connection, 404", async () => {
    const ch = await withNote();
    const answer = (res: Response | Error) => api.fail((method, url) => (method === "PUT" && url.endsWith("/visibility") ? res : null));
    const tryShow = () => store.actions.setNoteShown(ch.id, 1, true, "朝の光");

    answer(json(400, { error: { code: "bad_request", message: "入力内容を確認してください。", fields: { note: "ひとことにURLは入れられません" } } }));
    expect(await tryShow()).toMatchObject({ ok: false, message: "ひとことにURLは入れられません" });
    answer(json(409, { error: { code: "conflict", message: "この記録は「みんな」に表示されていないため、見せられません。" } }));
    expect(await tryShow()).toMatchObject({ ok: false, message: "この記録は「みんな」に表示されていないため、見せられません。" });
    answer(
      new Response(JSON.stringify({ error: { code: "rate_limited", message: "今日はここまでです" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "40000" },
      }),
    );
    expect(await tryShow()).toMatchObject({ ok: false, message: NOTE_SHOW_ERRORS.limit });
    answer(new TypeError("Failed to fetch"));
    expect(await tryShow()).toMatchObject({ ok: false, message: NOTE_SHOW_ERRORS.offline });
    // An API without the route yet (during a deploy).
    answer(json(404, { error: { code: "not_found", message: "no route" } }));
    expect(await tryShow()).toMatchObject({ ok: false, message: NOTE_SHOW_ERRORS.unavailable });
    expect(store.getSnapshot().challenges[0]!.stamps["1"]?.shown).toBeUndefined();
    expect(queued()).toEqual([]);
  });

  it("takes only the day's choice from a visibility answer: one made before an edit that is answered first never brings the old note back", async () => {
    const ch = await withNote();
    expect((await store.actions.setNoteShown(ch.id, 1, true, "朝の光")).ok).toBe(true);
    const stamp = () => store.getSnapshot().challenges[0]!.stamps["1"];
    const saved = () => readJson<{ base: { challenges: Challenge[] } }>(KEYS.state)?.base.challenges[0]?.stamps["1"];

    // Hiding: the server takes 「朝の光」 back, then gets the edit, and the edit is answered first.
    let g = gate((method, url) => method === "PUT" && url.endsWith("/visibility"));
    const hiding = store.actions.setNoteShown(ch.id, 1, false);
    await vi.waitFor(() => expect(g.held).toEqual([visibility(ch.id, 1)]));
    expect(store.actions.setNote(ch.id, 1, "夕方の光").ok).toBe(true);
    await store.actions.flush();
    g.release();
    expect((await hiding).ok).toBe(true);
    expect(stamp()).toEqual({ at: 7, note: "夕方の光" });
    expect(saved()).toEqual({ at: 7, note: "夕方の光" });

    // Showing: the server shows 「夕方の光」, then gets another edit (private again), answered first.
    g = gate((method, url) => method === "PUT" && url.endsWith("/visibility"));
    const showing = store.actions.setNoteShown(ch.id, 1, true, "夕方の光");
    await vi.waitFor(() => expect(g.held).toEqual([visibility(ch.id, 1)]));
    expect(store.actions.setNote(ch.id, 1, "夜の光").ok).toBe(true);
    await store.actions.flush();
    g.release();
    expect((await showing).ok).toBe(true);
    expect(api.challenges.get(ch.id)!.stamps["1"]).toEqual({ at: 7, note: "夜の光" });
    expect(stamp()).toEqual({ at: 7, note: "夜の光" });
    expect(store.getSnapshot().stillShown).toEqual([]);
  });

  it("keeps the confirmed choice when a refresh that started earlier answers later", async () => {
    const ch = await withNote();
    const g = gate((method, url) => method === "GET" && url === API.challenges);
    const refreshing = store.actions.refresh();
    await vi.waitFor(() => expect(g.held).toEqual([`GET ${API.challenges}`])); // answered with the note still private
    expect((await store.actions.setNoteShown(ch.id, 1, true, "朝の光")).ok).toBe(true);
    g.release();
    await refreshing;
    expect(store.getSnapshot().challenges[0]!.stamps["1"]).toEqual({ at: 7, note: "朝の光", shown: true });
  });
});
