import { API } from "@thirty/shared";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type * as PushModuleNs from "../src/lib/push";
import { KEYS, writeString } from "../src/lib/storage";

type PushModule = typeof PushModuleNs;
let push: PushModule;

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Properties defined on navigator / window by a test; removed afterwards (the prototype getters come back). */
const defined: [object, string][] = [];
function define(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  defined.push([target, key]);
}

type Env = {
  ua: string;
  touch?: number;
  /** navigator.standalone (iOS Home Screen) */
  standalone?: boolean;
  /** (display-mode: standalone) */
  displayStandalone?: boolean;
  /** Service worker + PushManager + Notification present */
  push?: boolean;
  permission?: NotificationPermission;
  sw?: unknown;
};

function setEnv(env: Env) {
  define(navigator, "userAgent", env.ua);
  define(navigator, "maxTouchPoints", env.touch ?? 0);
  define(navigator, "standalone", env.standalone);
  define(window, "matchMedia", (q: string) => ({
    matches: q.includes("display-mode: standalone") && env.displayStandalone === true,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }));
  if (env.push) {
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("Notification", { permission: env.permission ?? "default", requestPermission: vi.fn(async () => "granted") });
    define(navigator, "serviceWorker", env.sw ?? {});
  }
}

const KEY_BYTES = Uint8Array.from({ length: 65 }, (_, i) => (i * 37 + 4) % 256);
const KEY_B64URL = btoa(String.fromCharCode(...KEY_BYTES)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function fakeSubscription(endpoint = "https://fcm.googleapis.com/fcm/send/abc") {
  return {
    endpoint,
    options: { applicationServerKey: KEY_BYTES.buffer.slice(0) },
    toJSON: () => ({ endpoint, keys: { p256dh: "p256dh-key-0123456789", auth: "auth-key-0123" } }),
    unsubscribe: vi.fn(async () => true),
  };
}

let fetchMock: Mock<typeof fetch>;

beforeEach(async () => {
  vi.resetModules();
  push = await import("../src/lib/push");
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const [target, key] of defined.splice(0)) delete (target as Record<string, unknown>)[key];
  vi.unstubAllGlobals();
});

describe("urlBase64ToUint8Array", () => {
  it("decodes base64url without padding", () => {
    expect([...push.urlBase64ToUint8Array("AQID")]).toEqual([1, 2, 3]);
    expect([...push.urlBase64ToUint8Array("-_8")]).toEqual([0xfb, 0xff]);
    expect([...push.urlBase64ToUint8Array("AQ")]).toEqual([1]);
  });

  it("round-trips a 65-byte VAPID public key", () => {
    const out = push.urlBase64ToUint8Array(KEY_B64URL);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(65);
    expect([...out]).toEqual([...KEY_BYTES]);
  });
});

describe("device detection", () => {
  it("recognises iPhone and iPadOS (desktop UA with touch), not a Mac or Android", () => {
    setEnv({ ua: IPHONE_UA });
    expect(push.isIos()).toBe(true);
    setEnv({ ua: MAC_UA, touch: 5 });
    expect(push.isIos()).toBe(true);
    setEnv({ ua: MAC_UA, touch: 0 });
    expect(push.isIos()).toBe(false);
    setEnv({ ua: ANDROID_UA });
    expect(push.isIos()).toBe(false);
  });

  it("detects standalone from navigator.standalone or the display-mode query", () => {
    setEnv({ ua: IPHONE_UA, standalone: true });
    expect(push.isStandalone()).toBe(true);
    setEnv({ ua: ANDROID_UA, displayStandalone: true });
    expect(push.isStandalone()).toBe(true);
    setEnv({ ua: ANDROID_UA });
    expect(push.isStandalone()).toBe(false);
  });
});

describe("getPushStatus (guidance branches)", () => {
  it("iPhone in a Safari tab → add to Home Screen first", () => {
    setEnv({ ua: IPHONE_UA });
    expect(push.getPushStatus()).toBe("ios-needs-install");
  });

  it("iPhone opened from the Home Screen with Push → can ask", () => {
    setEnv({ ua: IPHONE_UA, standalone: true, push: true, permission: "default" });
    expect(push.getPushStatus()).toBe("default");
  });

  it("iPhone Home Screen app without the Push API (older iOS) → unsupported", () => {
    setEnv({ ua: IPHONE_UA, standalone: true });
    expect(push.getPushStatus()).toBe("unsupported");
  });

  it("Android: denied / granted / unsupported", () => {
    setEnv({ ua: ANDROID_UA, push: true, permission: "denied" });
    expect(push.getPushStatus()).toBe("denied");
    vi.unstubAllGlobals();
    setEnv({ ua: ANDROID_UA, push: true, permission: "granted" });
    expect(push.getPushStatus()).toBe("granted");
  });

  it("a browser without PushManager → unsupported", () => {
    setEnv({ ua: ANDROID_UA });
    expect(push.getPushStatus()).toBe("unsupported");
  });
});

describe("enablePush", () => {
  it("refuses on an iPhone Safari tab with the Home Screen guidance", async () => {
    setEnv({ ua: IPHONE_UA });
    const err = await push.enablePush().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(push.PushError);
    expect((err as InstanceType<PushModule["PushError"]>).code).toBe("ios-needs-install");
    expect(push.pushErrorMessage(err)).toContain("ホーム画面に追加");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses when notifications are blocked, without prompting", async () => {
    setEnv({ ua: ANDROID_UA, push: true, permission: "denied" });
    const err = await push.enablePush().catch((e: unknown) => e);
    expect((err as InstanceType<PushModule["PushError"]>).code).toBe("denied");
    expect((globalThis as unknown as { Notification: { requestPermission: Mock } }).Notification.requestPermission).not.toHaveBeenCalled();
  });

  it("reports a dismissed prompt", async () => {
    setEnv({ ua: ANDROID_UA, push: true, permission: "default" });
    (globalThis as unknown as { Notification: { requestPermission: Mock } }).Notification.requestPermission.mockResolvedValue("default");
    const err = await push.enablePush().catch((e: unknown) => e);
    expect((err as InstanceType<PushModule["PushError"]>).code).toBe("dismissed");
  });

  it("asks, subscribes with the server key and registers the subscription", async () => {
    writeString(KEYS.token, "tok");
    const sub = fakeSubscription();
    const subscribe = vi.fn(async () => sub);
    const reg = { pushManager: { getSubscription: vi.fn(async () => null), subscribe } };
    setEnv({ ua: ANDROID_UA, push: true, permission: "default", sw: { ready: Promise.resolve(reg) } });
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === API.pushPublicKey && (init?.method ?? "GET") === "GET") return json(200, { publicKey: KEY_B64URL });
      if (String(input) === API.pushSubscriptions && init?.method === "POST") return new Response(null, { status: 204 });
      return json(404, { error: { code: "not_found", message: "no route" } });
    });

    const res = await push.enablePush();

    expect((globalThis as unknown as { Notification: { requestPermission: Mock } }).Notification.requestPermission).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    const opts = (subscribe.mock.calls[0] as unknown as [PushSubscriptionOptionsInit])[0];
    expect(opts.userVisibleOnly).toBe(true);
    expect([...(opts.applicationServerKey as Uint8Array)]).toEqual([...KEY_BYTES]);
    expect(res).toEqual({ endpoint: sub.endpoint, keys: { p256dh: "p256dh-key-0123456789", auth: "auth-key-0123" } });

    const post = fetchMock.mock.calls.find(([u, i]) => String(u) === API.pushSubscriptions && i?.method === "POST");
    expect(post).toBeTruthy();
    const headers = post![1]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(post![1]!.body))).toEqual(res);
  });

  it("stops with a clear message when the server has push turned off", async () => {
    writeString(KEYS.token, "tok");
    setEnv({ ua: ANDROID_UA, push: true, permission: "granted", sw: { ready: new Promise(() => {}) } });
    fetchMock.mockResolvedValue(json(200, { publicKey: null }));
    const err = await push.enablePush().catch((e: unknown) => e);
    expect((err as InstanceType<PushModule["PushError"]>).code).toBe("server-unsupported");
  });
});

describe("syncPushSubscription", () => {
  function envWithSubscription(permission: NotificationPermission, sub: unknown) {
    const reg = { pushManager: { getSubscription: vi.fn(async () => sub) } };
    setEnv({ ua: ANDROID_UA, push: true, permission, sw: { getRegistration: vi.fn(async () => reg) } });
  }

  it("re-posts an existing subscription when allowed and signed in", async () => {
    writeString(KEYS.token, "tok");
    envWithSubscription("granted", fakeSubscription("https://fcm.googleapis.com/fcm/send/rotated"));
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(push.syncPushSubscription()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(API.pushSubscriptions);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body)).endpoint).toBe("https://fcm.googleapis.com/fcm/send/rotated");
  });

  it("does nothing without an account, without permission or without a subscription", async () => {
    envWithSubscription("granted", fakeSubscription());
    await expect(push.syncPushSubscription()).resolves.toBe(false); // no token

    writeString(KEYS.token, "tok");
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", fetchMock);
    envWithSubscription("default", fakeSubscription());
    await expect(push.syncPushSubscription()).resolves.toBe(false);

    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", fetchMock);
    envWithSubscription("granted", null);
    await expect(push.syncPushSubscription()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when the API is unreachable", async () => {
    writeString(KEYS.token, "tok");
    envWithSubscription("granted", fakeSubscription());
    fetchMock.mockRejectedValue(new TypeError("offline"));
    await expect(push.syncPushSubscription()).resolves.toBe(false);
  });
});

describe("sendTestPush / pushErrorMessage", () => {
  it("posts JSON with the token and explains the daily limit", async () => {
    writeString(KEYS.token, "tok");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await push.sendTestPush();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(API.pushTest);
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

    fetchMock.mockResolvedValueOnce(json(429, { error: { code: "rate_limited", message: "多すぎます" } }));
    const err = await push.sendTestPush().catch((e: unknown) => e);
    expect(push.pushErrorMessage(err)).toContain("1日5回");
  });
});
