import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newId, type ApiError, type MeResponse, type PushPublicKeyResponse, type SessionResponse } from "@thirty/shared";
import type { Config } from "../src/config";
import { MAX_PUSH_SUBSCRIPTIONS, listPushItems, pushHash } from "../src/db/push";
import { getStats } from "../src/db/stats";
import type { PushSender, PushTarget } from "../src/ports";
import {
  NoopPushSender,
  PUSH_TIMEOUT_MS,
  PUSH_TTL_SECONDS,
  WebPushSender,
  createPushSender,
  isAllowedPushEndpoint,
  type WebPushLib,
} from "../src/providers/push";
import { TEST_PUSH_PAYLOAD } from "../src/routes/push";
import { json, setupApi } from "./helpers";

// ---------- allowlist ----------

describe("isAllowedPushEndpoint (SSRF protection)", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/dXk1:APA91bH-abc_DEF",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk",
    "https://push.services.mozilla.com/wpush/v1/abc",
    "https://web.push.apple.com/QGx1c2gtdG9rZW4",
    "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB%2bAbc",
    "HTTPS://FCM.GOOGLEAPIS.COM/fcm/send/abc",
  ])("accepts %s", (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(true);
  });

  it.each([
    ["plain http", "http://fcm.googleapis.com/fcm/send/abc"],
    ["suffix attack", "https://fcm.googleapis.com.evil.com/fcm/send/abc"],
    ["allowed host in the path", "https://evil.com/fcm.googleapis.com/abc"],
    ["allowed host as userinfo", "https://fcm.googleapis.com@evil.com/abc"],
    ["userinfo in front of an allowed host", "https://user:pass@fcm.googleapis.com/abc"],
    ["empty userinfo", "https://@fcm.googleapis.com/abc"],
    ["explicit port", "https://fcm.googleapis.com:8443/abc"],
    ["explicit default port", "https://fcm.googleapis.com:443/abc"],
    ["bare wildcard parent", "https://push.apple.com/abc"],
    ["look-alike without a dot", "https://evilpush.apple.com/abc"],
    ["wildcard suffix attack", "https://web.push.apple.com.evil.com/abc"],
    ["trailing dot", "https://fcm.googleapis.com./abc"],
    ["backslash trick", "https://evil.com\\@fcm.googleapis.com/abc"],
    ["fragment trick", "https://evil.com#@fcm.googleapis.com/abc"],
    ["percent-encoded host", "https://fcm%2egoogleapis.com/abc"],
    ["ip literal", "https://127.0.0.1/abc"],
    ["ipv6 literal", "https://[::1]/abc"],
    ["no path", "https://fcm.googleapis.com"],
    ["whitespace", "https://fcm.googleapis.com/abc def"],
    ["leading whitespace", " https://fcm.googleapis.com/abc"],
    ["newline", "https://fcm.googleapis.com/abc\n"],
    ["unicode look-alike", "https://fcm.googleapis.cοm/abc"],
    ["other scheme", "javascript:alert(1)//fcm.googleapis.com/"],
    ["not a url", "fcm.googleapis.com/abc"],
    ["unknown service", "https://push.example.com/abc"],
    ["too long", `https://fcm.googleapis.com/${"a".repeat(1000)}`],
  ])("rejects %s", (_label, endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });
});

// ---------- the Web Push sender ----------

const VAPID_PUBLIC = "BPublicKeyForTests";
const CONFIG = { vapidPublicKey: VAPID_PUBLIC, vapidSubject: "https://example.test/thirty" } as Config;
const TARGET: PushTarget = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) } };

function fakeLib(behaviour: () => Promise<unknown>) {
  const lib = {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(behaviour),
  };
  return lib as typeof lib & WebPushLib;
}

const httpError = (statusCode: number) => Object.assign(new Error("Received unexpected response code"), { name: "WebPushError", statusCode });

describe("WebPushSender", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("configures VAPID once (private key read at send time) and sends JSON with a 6h TTL and 5s timeout", async () => {
    const secrets: { vapidPrivateKey?: string } = {};
    const lib = fakeLib(async () => ({ statusCode: 201, body: "", headers: {} }));
    const sender = new WebPushSender(CONFIG, secrets, lib);
    secrets.vapidPrivateKey = "private-key"; // filled after construction, like lambda.ts does
    expect(await sender.send(TARGET, { title: "t" })).toEqual({ ok: true, gone: false });
    expect(await sender.send(TARGET, { title: "u" })).toEqual({ ok: true, gone: false });
    expect(lib.setVapidDetails).toHaveBeenCalledTimes(1);
    expect(lib.setVapidDetails).toHaveBeenCalledWith(CONFIG.vapidSubject, VAPID_PUBLIC, "private-key");
    expect(lib.sendNotification).toHaveBeenCalledWith(TARGET, JSON.stringify({ title: "t" }), {
      TTL: PUSH_TTL_SECONDS,
      timeout: PUSH_TIMEOUT_MS,
      urgency: "normal",
    });
    expect(PUSH_TTL_SECONDS).toBe(6 * 3600);
    expect(PUSH_TIMEOUT_MS).toBe(5000);
  });

  it("reports 404 and 410 as gone, other failures as not ok", async () => {
    for (const [status, expected] of [
      [404, { ok: false, gone: true }],
      [410, { ok: false, gone: true }],
      [429, { ok: false, gone: false }],
      [500, { ok: false, gone: false }],
    ] as const) {
      const sender = new WebPushSender(CONFIG, { vapidPrivateKey: "k" }, fakeLib(async () => Promise.reject(httpError(status))));
      expect(await sender.send(TARGET, {}), String(status)).toEqual(expected);
    }
    const network = new WebPushSender(CONFIG, { vapidPrivateKey: "k" }, fakeLib(async () => Promise.reject(new Error("ECONNRESET"))));
    expect(await network.send(TARGET, {})).toEqual({ ok: false, gone: false });
  });

  it("gives up after 5 seconds", async () => {
    vi.useFakeTimers();
    const sender = new WebPushSender(CONFIG, { vapidPrivateKey: "k" }, fakeLib(() => new Promise(() => {})));
    const pending = sender.send(TARGET, {});
    await vi.advanceTimersByTimeAsync(PUSH_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: false, gone: false });
  });

  it("sends nothing without keys, with invalid keys, or to a non-allowlisted endpoint", async () => {
    const lib = fakeLib(async () => ({ statusCode: 201 }));
    expect(await new WebPushSender(CONFIG, {}, lib).send(TARGET, {})).toEqual({ ok: false, gone: false });
    const invalid = fakeLib(async () => ({ statusCode: 201 }));
    invalid.setVapidDetails.mockImplementation(() => {
      throw new Error("Vapid public key should be 65 bytes long when decoded.");
    });
    expect(await new WebPushSender(CONFIG, { vapidPrivateKey: "k" }, invalid).send(TARGET, {})).toEqual({ ok: false, gone: false });
    // A stored endpoint outside the allowlist is never fetched; "gone" makes the caller delete it.
    const evil = { ...TARGET, endpoint: "https://169.254.169.254/latest/meta-data" };
    expect(await new WebPushSender(CONFIG, { vapidPrivateKey: "k" }, lib).send(evil, {})).toEqual({ ok: false, gone: true });
    expect(lib.sendNotification).not.toHaveBeenCalled();
    expect(invalid.sendNotification).not.toHaveBeenCalled();
  });

  it("createPushSender uses Web Push when a VAPID public key is configured, otherwise the no-op sender", () => {
    expect(createPushSender(CONFIG, {})).toBeInstanceOf(WebPushSender);
    expect(createPushSender({ ...CONFIG, vapidPublicKey: undefined }, {})).toBeInstanceOf(NoopPushSender);
  });
});

// ---------- routes ----------

class FakeSender implements PushSender {
  readonly sent: { sub: PushTarget; payload: object }[] = [];
  readonly gone = new Set<string>();

  async send(sub: PushTarget, payload: object) {
    this.sent.push({ sub, payload });
    return this.gone.has(sub.endpoint) ? { ok: false, gone: true } : { ok: true, gone: false };
  }
}

const api = setupApi();
let sender: FakeSender;

beforeEach(() => {
  sender = new FakeSender();
  api.deps.push = sender;
});

const KEYS = { p256dh: "B".repeat(87), auth: "a".repeat(22) };
const endpoint = (host = "fcm.googleapis.com") => `https://${host}/fcm/send/${newId(24)}`;
const subscribe = (s: SessionResponse | undefined, ep: string, keys = KEYS) =>
  api.request("/api/push/subscriptions", { token: s?.token, body: { endpoint: ep, keys } });
const unsubscribe = (s: SessionResponse, ep: string) =>
  api.request("/api/push/subscriptions", { method: "DELETE", token: s.token, body: { endpoint: ep } });
const pushTest = (s: SessionResponse) => api.request("/api/push/test", { method: "POST", token: s.token });
const subCount = async () => (await getStats(api.deps)).pushSubscriptions;
const getPush = async (uid: string, ep: string) =>
  (await api.deps.db.send(new GetCommand({ TableName: api.deps.tableName, Key: { pk: `USER#${uid}`, sk: `PUSH#${pushHash(ep)}` } }))).Item;
const setReminder = (s: SessionResponse, enabled: boolean, time = "21:00") =>
  api.request("/api/me", { method: "PATCH", token: s.token, body: { reminder: { enabled, time } } });

describe("GET /api/push/public-key", () => {
  it("returns the configured VAPID public key, or null", async () => {
    expect(await json<PushPublicKeyResponse>(await api.request("/api/push/public-key"))).toEqual({ publicKey: null });
    const app = api.makeApp({ vapidPublicKey: "BConfiguredKey" });
    expect(await json<PushPublicKeyResponse>(await api.request("/api/push/public-key", {}, app))).toEqual({ publicKey: "BConfiguredKey" });
  });
});

describe("POST /api/push/subscriptions", () => {
  it("needs a session", async () => {
    expect((await subscribe(undefined, endpoint())).status).toBe(401);
  });

  it("rejects endpoints outside the push-service allowlist with 400 and stores nothing", async () => {
    const s = await api.createSession();
    for (const ep of [
      "https://fcm.googleapis.com.evil.com/fcm/send/x",
      "http://fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com:8443/fcm/send/x",
      "https://user@fcm.googleapis.com/fcm/send/x",
      "https://127.0.0.1/x",
    ]) {
      const res = await subscribe(s, ep);
      expect(res.status, ep).toBe(400);
      const err = await json<ApiError>(res);
      expect(err.error.code).toBe("bad_request");
      expect(err.error.fields?.endpoint ?? err.error.message).toBeTruthy();
    }
    expect((await subscribe(s, endpoint(), { p256dh: "short", auth: "a".repeat(22) })).status).toBe(400);
    expect(await listPushItems(api.deps, s.user.id)).toEqual([]);
  });

  it("stores the subscription once (re-subscribing refreshes the keys) and counts it in STATS", async () => {
    const s = await api.createSession();
    const ep = endpoint();
    const before = await subCount();
    expect((await subscribe(s, ep)).status).toBe(204);
    const item = await getPush(s.user.id, ep);
    expect(item).toMatchObject({ endpoint: ep, keys: KEYS, type: "push" });
    expect(typeof item?.createdAt).toBe("number");
    expect(item?.gsi3pk).toBeUndefined(); // reminder is off by default
    expect(await subCount()).toBe(before + 1);

    api.clock.advance(60_000);
    const rotated = { p256dh: "C".repeat(87), auth: "b".repeat(22) };
    expect((await subscribe(s, ep, rotated)).status).toBe(204);
    const again = await getPush(s.user.id, ep);
    expect(again?.keys).toEqual(rotated);
    expect(again?.createdAt).toBe(item?.createdAt);
    expect(await listPushItems(api.deps, s.user.id)).toHaveLength(1);
    expect(await subCount()).toBe(before + 1);
  });

  it("puts subscriptions on the reminder slot only while the reminder is on (and follows PATCH /api/me)", async () => {
    api.clock.set("2026-10-06T03:00:00.000Z");
    const s = await api.createSession("通知", "Asia/Tokyo");
    const first = endpoint();
    await subscribe(s, first);
    expect((await getPush(s.user.id, first))?.gsi3pk).toBeUndefined();

    const me = await json<MeResponse>(await setReminder(s, true, "21:00"));
    expect(me.user.reminder).toEqual({ enabled: true, time: "21:00" });
    expect(await getPush(s.user.id, first)).toMatchObject({ gsi3pk: "SLOT#12:00", gsi3sk: `${s.user.id}#${pushHash(first)}` });

    // A new device while the reminder is on goes straight onto the slot.
    const second = endpoint("web.push.apple.com");
    await subscribe(s, second);
    expect(await getPush(s.user.id, second)).toMatchObject({ gsi3pk: "SLOT#12:00", gsi3sk: `${s.user.id}#${pushHash(second)}` });

    await setReminder(s, true, "07:30");
    expect((await getPush(s.user.id, second))?.gsi3pk).toBe("SLOT#22:30");

    await setReminder(s, false);
    expect((await getPush(s.user.id, first))?.gsi3pk).toBeUndefined();
    expect((await getPush(s.user.id, second))?.gsi3pk).toBeUndefined();
    expect((await getPush(s.user.id, second))?.gsi3sk).toBeUndefined();

    // Re-subscribing while off also takes it off the schedule.
    const third = endpoint("updates.push.services.mozilla.com");
    await subscribe(s, third);
    expect((await getPush(s.user.id, third))?.gsi3pk).toBeUndefined();
  });

  it(`keeps at most ${MAX_PUSH_SUBSCRIPTIONS} per user, dropping the least recently registered`, async () => {
    const s = await api.createSession();
    const before = await subCount();
    const eps = Array.from({ length: 7 }, () => endpoint());
    for (const ep of eps.slice(0, 6)) {
      api.clock.advance(1_000);
      expect((await subscribe(s, ep)).status).toBe(204);
    }
    let stored = (await listPushItems(api.deps, s.user.id)).map((i) => i.endpoint);
    expect(stored).toHaveLength(5);
    expect(stored).not.toContain(eps[0]);
    expect(await subCount()).toBe(before + 5);

    // Re-registering eps[1] makes it recent again, so eps[2] is the next to go.
    api.clock.advance(1_000);
    await subscribe(s, eps[1]!);
    api.clock.advance(1_000);
    await subscribe(s, eps[6]!);
    stored = (await listPushItems(api.deps, s.user.id)).map((i) => i.endpoint);
    expect(stored).toHaveLength(5);
    expect(stored).toContain(eps[1]);
    expect(stored).toContain(eps[6]);
    expect(stored).not.toContain(eps[2]);
    expect(await subCount()).toBe(before + 5);
  });
});

describe("DELETE /api/push/subscriptions", () => {
  it("removes the subscription (idempotent) and only the caller's own", async () => {
    const s = await api.createSession();
    const other = await api.createSession();
    const ep = endpoint();
    await subscribe(s, ep);
    await subscribe(other, ep); // the same browser endpoint registered by another account
    const before = await subCount();

    expect((await unsubscribe(other, ep)).status).toBe(204);
    expect(await getPush(other.user.id, ep)).toBeUndefined();
    expect(await getPush(s.user.id, ep)).toBeDefined();
    expect(await subCount()).toBe(before - 1);

    expect((await unsubscribe(other, ep)).status).toBe(204);
    expect(await subCount()).toBe(before - 1);
  });

  it("requires a session and a JSON body", async () => {
    const s = await api.createSession();
    const ep = endpoint();
    await subscribe(s, ep);
    expect((await api.request("/api/push/subscriptions", { method: "DELETE", body: { endpoint: ep } })).status).toBe(401);
    const wrongType = await api.request("/api/push/subscriptions", {
      method: "DELETE",
      token: s.token,
      raw: JSON.stringify({ endpoint: ep }),
      contentType: "text/plain",
    });
    expect(wrongType.status).toBe(415);
    expect((await api.request("/api/push/subscriptions", { method: "DELETE", token: s.token })).status).toBe(400);
    expect((await api.request("/api/push/subscriptions", { method: "DELETE", token: s.token, body: { endpoint: "nope" } })).status).toBe(400);
    expect(await getPush(s.user.id, ep)).toBeDefined();
  });
});

describe("POST /api/push/test", () => {
  it("is 409 when the user has no subscription", async () => {
    const s = await api.createSession();
    const res = await pushTest(s);
    expect(res.status).toBe(409);
    expect((await json<ApiError>(res)).error.code).toBe("conflict");
    expect(sender.sent).toEqual([]);
  });

  it("sends the test notification to every subscription of the user", async () => {
    const s = await api.createSession();
    const other = await api.createSession();
    const eps = [endpoint(), endpoint("web.push.apple.com")];
    for (const ep of eps) await subscribe(s, ep);
    await subscribe(other, endpoint());

    expect((await pushTest(s)).status).toBe(204);
    expect(sender.sent.map((m) => m.sub.endpoint).sort()).toEqual([...eps].sort());
    for (const m of sender.sent) {
      expect(m.payload).toEqual({ title: "30日だけ", body: "テスト通知です。この時刻にリマインドが届きます。", url: "/" });
      expect(m.sub.keys).toEqual(KEYS);
    }
    expect(TEST_PUSH_PAYLOAD.title).toBe("30日だけ");
  });

  it("deletes subscriptions the push service reports as gone", async () => {
    const s = await api.createSession();
    const alive = endpoint();
    const dead = endpoint();
    await subscribe(s, alive);
    await subscribe(s, dead);
    sender.gone.add(dead);
    const before = await subCount();

    expect((await pushTest(s)).status).toBe(204);
    expect(await getPush(s.user.id, dead)).toBeUndefined();
    expect(await getPush(s.user.id, alive)).toBeDefined();
    expect(await subCount()).toBe(before - 1);

    // When every subscription is gone, the browser has to subscribe again.
    sender.gone.add(alive);
    expect((await pushTest(s)).status).toBe(409);
    expect(await listPushItems(api.deps, s.user.id)).toEqual([]);
    expect(await subCount()).toBe(before - 2);
  });

  it(`allows 5 test notifications per user per day`, async () => {
    const s = await api.createSession();
    await subscribe(s, endpoint());
    for (let i = 0; i < 5; i++) expect((await pushTest(s)).status).toBe(204);
    const limited = await pushTest(s);
    expect(limited.status).toBe(429);
    expect((await json<ApiError>(limited)).error.code).toBe("rate_limited");
  });
});

describe("account deletion", () => {
  it("removes the user's subscriptions and their STATS count", async () => {
    const s = await api.createSession();
    await subscribe(s, endpoint());
    await subscribe(s, endpoint());
    const before = await subCount();
    expect((await api.request("/api/me", { method: "DELETE", token: s.token })).status).toBe(204);
    expect(await listPushItems(api.deps, s.user.id)).toEqual([]);
    expect(await subCount()).toBe(before - 2);
  });
});
