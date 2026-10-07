import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { QUOTAS, type ApiError } from "@thirty/shared";
import { hashIp, hashNetwork, hashWideNetwork, ipKey, networkKey, requireAdmin, sha256, wideNetworkKey } from "../src/auth";
import { MAX_BODY_BYTES, originVerifyValues } from "../src/app";
import { DEFAULT_IP_HASH_KEY } from "../src/config";
import { enforceQuota, getQuotaUsage, quotaCounterKey, refundQuota, windowFor } from "../src/db/rate";
import { log } from "../src/log";
import { ALARMED_LOGS } from "../src/log-events";
import {
  SESSION_GLOBAL_KEY,
  SESSION_GLOBAL_SCOPE,
  SESSION_IP_SCOPE,
  SESSION_NETWORK_SCOPE,
  SESSIONS_BUSY,
} from "../src/routes/session";
import { onError } from "../src/errors";
import type { AppEnv } from "../src/types";
import { ADMIN_TOKEN, json, setupApi } from "./helpers";

const api = setupApi();

const errorOf = async (res: Response) => (await json<ApiError>(res)).error;

describe("HTTP contract", () => {
  it("health is open", async () => {
    const res = await api.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("unknown /api routes are 404 JSON", async () => {
    const res = await api.request("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toMatchObject({ code: "not_found" });
    const other = await api.request("/nope");
    expect(other.status).toBe(404);
  });

  it("requires application/json on POST / PUT / PATCH", async () => {
    const res = await api.request("/api/session", { raw: "tz=UTC", contentType: "application/x-www-form-urlencoded" });
    expect(res.status).toBe(415);
    expect(await errorOf(res)).toMatchObject({ code: "unsupported_media_type" });
    expect((await api.request("/api/me/transfer-code", { method: "POST", contentType: null })).status).toBe(415);
    // charset parameter is fine
    const ok = await api.request("/api/session", { body: { tz: "UTC" }, contentType: "application/json; charset=utf-8" });
    expect(ok.status).toBe(201);
  });

  it("lets DELETE without a body through, but not DELETE with a non-JSON body", async () => {
    expect((await api.request("/api/me", { method: "DELETE", contentType: null })).status).toBe(401);
    expect((await api.request("/api/me", { method: "DELETE", raw: "x", contentType: "text/plain" })).status).toBe(415);
  });

  it("rejects bodies over 1MB with 413", async () => {
    const res = await api.request("/api/session", { raw: JSON.stringify({ tz: "UTC", pad: "x".repeat(MAX_BODY_BYTES) }) });
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toMatchObject({ code: "payload_too_large" });
  });

  it("maps malformed JSON and schema errors to 400 bad_request", async () => {
    const bad = await api.request("/api/session", { raw: "{not json" });
    expect(bad.status).toBe(400);
    expect(await errorOf(bad)).toMatchObject({ code: "bad_request" });
    const missing = await api.request("/api/session", { body: {} });
    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).fields).toHaveProperty("tz");
  });

  it("marks API responses as not cacheable", async () => {
    expect((await api.request("/api/health")).headers.get("cache-control")).toBe("no-store");
  });
});

describe("origin verify", () => {
  it("accepts every value of a comma-separated list, so a rotation never refuses old edges", async () => {
    expect(originVerifyValues(" new-secret , old-secret ,, ")).toEqual(["new-secret", "old-secret"]);
    expect(originVerifyValues(undefined)).toEqual([]);
    const app = api.makeApp({ originVerify: "new-secret,old-secret" });
    for (const value of ["new-secret", "old-secret"]) {
      expect((await api.request("/api/health", { headers: { "x-origin-verify": value } }, app)).status, value).toBe(200);
    }
    for (const value of ["new-secret,old-secret", "new", "other", ""]) {
      expect((await api.request("/api/health", { headers: { "x-origin-verify": value } }, app)).status, value).toBe(403);
    }
    expect((await api.request("/api/health", {}, app)).status).toBe(403);
  });

  it("fails closed when ORIGIN_VERIFY is set but holds no value (NF-6)", async () => {
    for (const configured of ["", " ", ",", " , ,"]) {
      const app = api.makeApp({ originVerify: configured });
      expect((await api.request("/api/health", {}, app)).status, JSON.stringify(configured)).toBe(403);
      for (const value of ["", ",", "x"]) {
        expect((await api.request("/api/health", { headers: { "x-origin-verify": value } }, app)).status, JSON.stringify([configured, value])).toBe(403);
      }
    }
    // Unset (local runs, tests): no check.
    expect((await api.request("/api/health", {}, api.makeApp({ originVerify: undefined }))).status).toBe(200);
  });

  it("refuses requests without the CloudFront secret header when configured", async () => {
    const app = api.makeApp({ originVerify: "s3cret-from-cloudfront" });
    const none = await api.request("/api/health", {}, app);
    expect(none.status).toBe(403);
    expect(await errorOf(none)).toMatchObject({ code: "forbidden" });
    const wrong = await api.request("/api/health", { headers: { "x-origin-verify": "guess" } }, app);
    expect(wrong.status).toBe(403);
    const right = await api.request("/api/health", { headers: { "x-origin-verify": "s3cret-from-cloudfront" } }, app);
    expect(right.status).toBe(200);
  });
});

describe("quotas", () => {
  it("day windows follow the JST calendar day", () => {
    expect(windowFor("day", new Date("2026-10-06T14:59:59Z")).id).toBe("2026-10-06");
    const next = windowFor("day", new Date("2026-10-06T15:00:00Z"));
    expect(next.id).toBe("2026-10-07");
    expect(new Date(next.resetAt).toISOString()).toBe("2026-10-07T15:00:00.000Z");
    expect(windowFor("hour", new Date("2026-10-06T14:59:59Z"))).toEqual({
      id: "2026-10-06T14",
      resetAt: Date.parse("2026-10-06T15:00:00Z"),
    });
  });

  it("counts up to the limit, refuses with 429, and resets in the next window", async () => {
    api.clock.set("2026-10-06T14:00:00Z");
    const first = await enforceQuota(api.deps, "test", "k1", 2, "day");
    expect(first).toMatchObject({ count: 1, remaining: 1 });
    expect((await enforceQuota(api.deps, "test", "k1", 2, "day")).remaining).toBe(0);
    await expect(enforceQuota(api.deps, "test", "k1", 2, "day")).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    // Refused attempts are not counted.
    expect((await getQuotaUsage(api.deps, "test", "k1", 2, "day")).count).toBe(2);
    // Other keys are independent.
    expect((await enforceQuota(api.deps, "test", "k2", 2, "day")).count).toBe(1);

    api.clock.set("2026-10-06T15:00:00Z"); // 00:00 JST
    expect((await enforceQuota(api.deps, "test", "k1", 2, "day")).count).toBe(1);
  });

  it("refundQuota gives one use back, never below zero", async () => {
    api.clock.set("2026-10-08T03:00:00Z");
    await refundQuota(api.deps, "refund", "k", "day"); // no counter yet: nothing happens
    expect((await getQuotaUsage(api.deps, "refund", "k", 2, "day")).count).toBe(0);
    await enforceQuota(api.deps, "refund", "k", 2, "day");
    await enforceQuota(api.deps, "refund", "k", 2, "day");
    await expect(enforceQuota(api.deps, "refund", "k", 2, "day")).rejects.toMatchObject({ status: 429 });
    await refundQuota(api.deps, "refund", "k", "day");
    expect((await getQuotaUsage(api.deps, "refund", "k", 2, "day")).count).toBe(1);
    expect((await enforceQuota(api.deps, "refund", "k", 2, "day")).count).toBe(2);
    await refundQuota(api.deps, "refund", "k", "day");
    await refundQuota(api.deps, "refund", "k", "day");
    await refundQuota(api.deps, "refund", "k", "day");
    expect((await getQuotaUsage(api.deps, "refund", "k", 2, "day")).count).toBe(0);
  });
});

describe("client IP keys for rate limits", () => {
  it("counts an IPv6 /56 as one client (Japanese IPoE homes get a /56), and an IPv4-mapped address as its IPv4 address", () => {
    expect(ipKey("203.0.113.9")).toBe("203.0.113.9");
    expect(ipKey("2001:db8:1:2::1")).toBe("2001:db8:1:0::/56");
    expect(ipKey("2001:0DB8:0001:0002:ffff:eeee:dddd:cccc")).toBe("2001:db8:1:0::/56");
    expect(ipKey("[2001:db8:1:2::5]")).toBe("2001:db8:1:0::/56");
    expect(ipKey("2001:db8:1:12ab::1")).toBe("2001:db8:1:1200::/56");
    expect(ipKey("fe80::1%eth0")).toBe("fe80:0:0:0::/56");
    expect(ipKey("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(ipKey("2001:db8::")).toBe("2001:db8:0:0::/56");
    expect(ipKey("::1")).toBe("0:0:0:0::/56");
    expect(ipKey("unknown")).toBe("unknown");
    // The 256 /64s of one /56 are one client; the next /56 is someone else.
    expect(ipKey("2001:db8:1:ff::1")).toBe(ipKey("2001:db8:1:2::1"));
    expect(ipKey("2001:db8:1:100::1")).not.toBe(ipKey("2001:db8:1:2::1"));
  });

  it("groups clients into networks for report diversity: IPv4 /24, IPv6 /48", () => {
    expect(networkKey("203.0.113.9")).toBe("203.0.113.0/24");
    expect(networkKey("203.0.113.250")).toBe(networkKey("203.0.113.9"));
    expect(networkKey("203.0.114.9")).not.toBe(networkKey("203.0.113.9"));
    expect(networkKey("::ffff:203.0.113.7")).toBe("203.0.113.0/24");
    expect(networkKey("2001:db8:1:2::1")).toBe("2001:db8:1::/48");
    expect(networkKey("2001:db8:1:ffff::1")).toBe(networkKey("2001:db8:1:2::1"));
    expect(networkKey("2001:db8:2::1")).not.toBe(networkKey("2001:db8:1::1"));
    expect(networkKey("unknown")).toBe("unknown");
    const h = hashNetwork("203.0.113.9", "k");
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(h).toBe(hashNetwork("203.0.113.77", "k"));
    expect(h).not.toBe(hashNetwork("203.0.113.9", "other"));
    expect(h).not.toBe(hashIp("203.0.113.9", "k").slice(0, 32));
  });

  it("is a keyed hash (HMAC): not the plain SHA-256 of the address, and different per key", () => {
    const h = hashIp("203.0.113.9", DEFAULT_IP_HASH_KEY);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toBe(sha256("203.0.113.9"));
    expect(hashIp("203.0.113.9", "another-key")).not.toBe(h);
    expect(hashIp("2001:db8:1:2::1", "k")).toBe(hashIp("2001:db8:1:2:aaaa::9", "k"));
    expect(hashIp("2001:db8:1:2::1", "k")).toBe(hashIp("2001:db8:1:ab::9", "k"));
  });

  it("applies the per-IP session quota to the whole IPv6 /56 (security-3)", async () => {
    api.clock.set("2026-10-09T05:10:00Z");
    // 25 different /64s of one /56: before, each was a separate client and all 25 got an account.
    const statuses: number[] = [];
    for (let i = 1; i <= QUOTAS.sessionsPerIpPerHour + 5; i++) {
      const res = await api.request("/api/session", { body: { tz: "Asia/Tokyo" }, ip: `2001:db8:77:${i.toString(16)}::1` });
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 201)).toHaveLength(QUOTAS.sessionsPerIpPerHour);
    expect(statuses.slice(QUOTAS.sessionsPerIpPerHour)).toEqual([429, 429, 429, 429, 429]);
    // The next /56 is someone else.
    expect((await api.request("/api/session", { body: { tz: "Asia/Tokyo" }, ip: "2001:db8:77:100::1" })).status).toBe(201);
    // The stored rate-limit keys never contain the address.
    expect(JSON.stringify(await api.scanAll())).not.toContain("2001:db8:77");
  });

  it("groups clients into wider networks for the new-session limit: IPv4 /16, IPv6 /48 (R11)", () => {
    expect(wideNetworkKey("203.0.113.9")).toBe("203.0.0.0/16");
    expect(wideNetworkKey("203.0.250.1")).toBe(wideNetworkKey("203.0.113.9"));
    expect(wideNetworkKey("203.1.113.9")).not.toBe(wideNetworkKey("203.0.113.9"));
    expect(wideNetworkKey("::ffff:203.0.113.7")).toBe("203.0.0.0/16");
    expect(wideNetworkKey("2001:db8:1:2::1")).toBe("2001:db8:1::/48");
    expect(wideNetworkKey("2001:db8:1:ff00::1")).toBe(wideNetworkKey("2001:db8:1:2::1"));
    expect(wideNetworkKey("2001:db8:2::1")).not.toBe(wideNetworkKey("2001:db8:1::1"));
    expect(wideNetworkKey("unknown")).toBe("unknown");
    // Keyed (2^16 IPv4 /16s are easy to enumerate) and domain-separated from the other hashes.
    const h = hashWideNetwork("203.0.1.1", "k");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(hashWideNetwork("203.0.200.9", "k"));
    expect(h).not.toBe(hashWideNetwork("203.0.1.1", "other"));
    expect(h).not.toBe(hashIp("203.0.1.1", "k"));
    expect(h.slice(0, 32)).not.toBe(hashNetwork("203.0.1.1", "k"));
  });

  it(`one IPv6 /48 cannot use up the global ceiling: ${QUOTAS.sessionsPerNetworkPerHour} new sessions an hour per network (R11)`, async () => {
    api.clock.set("2026-10-09T09:10:00Z");
    expect(QUOTAS.sessionsPerNetworkPerHour).toBe(60);
    expect(QUOTAS.sessionsGlobalPerHour).toBe(2000);
    // Four /56s of one /48 (a free tunnel broker hands out a /48 = 256 of them), 20 sessions each.
    const statuses: number[] = [];
    const ipOf = (n: number, i: number) => `2001:db8:48:${(n << 8).toString(16)}::${(i + 1).toString(16)}`;
    for (let n = 0; n < 4; n++) {
      for (let i = 0; i < QUOTAS.sessionsPerIpPerHour; i++) {
        statuses.push((await api.request("/api/session", { body: { tz: "Asia/Tokyo" }, ip: ipOf(n, i) })).status);
      }
    }
    // Before R11 all 80 got an account (and 2,000 /56s would have emptied the global ceiling).
    expect(statuses.filter((s) => s === 201)).toHaveLength(QUOTAS.sessionsPerNetworkPerHour);
    expect(statuses.slice(QUOTAS.sessionsPerNetworkPerHour).every((s) => s === 429)).toBe(true);
    // The refused /56 keeps its own allowance (given back), and the global ceiling only saw the 60.
    const usage = (scope: string, key: string, limit: number) => getQuotaUsage(api.deps, scope, key, limit, "hour");
    expect((await usage(SESSION_IP_SCOPE, hashIp(ipOf(3, 0), DEFAULT_IP_HASH_KEY), QUOTAS.sessionsPerIpPerHour)).count).toBe(0);
    expect((await usage(SESSION_GLOBAL_SCOPE, SESSION_GLOBAL_KEY, QUOTAS.sessionsGlobalPerHour)).count).toBe(QUOTAS.sessionsPerNetworkPerHour);
    // Everyone else still gets in: another /48, and an IPv4 visitor.
    expect((await api.request("/api/session", { body: { tz: "Asia/Tokyo" }, ip: "2001:db8:49::1" })).status).toBe(201);
    expect((await api.request("/api/session", { body: { tz: "Asia/Tokyo" }, ip: "198.51.100.42" })).status).toBe(201);
    // The next hour the network starts again.
    api.clock.set("2026-10-09T10:00:00Z");
    expect((await api.request("/api/session", { body: { tz: "Asia/Tokyo" }, ip: ipOf(3, 0) })).status).toBe(201);
  });

  it("counts an IPv4 /16 as one network for new sessions (R11)", async () => {
    api.clock.set("2026-10-09T11:10:00Z");
    let created = 0;
    for (let n = 1; n <= 4; n++) {
      for (let i = 0; i < QUOTAS.sessionsPerIpPerHour; i++) {
        if ((await api.request("/api/session", { body: { tz: "Asia/Tokyo" }, ip: `203.0.${n}.9` })).status === 201) created++;
      }
    }
    expect(created).toBe(QUOTAS.sessionsPerNetworkPerHour);
    expect((await getQuotaUsage(api.deps, SESSION_NETWORK_SCOPE, hashWideNetwork("203.0.77.1", DEFAULT_IP_HASH_KEY), QUOTAS.sessionsPerNetworkPerHour, "hour")).count).toBe(
      QUOTAS.sessionsPerNetworkPerHour,
    );
    expect((await api.request("/api/session", { body: { tz: "Asia/Tokyo" }, ip: "203.1.0.9" })).status).toBe(201);
  });

  it(`stops new sessions from all clients together at ${QUOTAS.sessionsGlobalPerHour} an hour, with a message, Retry-After and the alarmed warning (R7, R11)`, async () => {
    api.clock.set("2026-10-09T07:40:00Z");
    // The global counter one below the ceiling (as if many other networks had signed up this hour).
    await api.deps.db.send(
      new UpdateCommand({
        TableName: api.deps.tableName,
        Key: quotaCounterKey(SESSION_GLOBAL_SCOPE, SESSION_GLOBAL_KEY, windowFor("hour", api.clock.now()).id),
        UpdateExpression: "SET #count = :n",
        ExpressionAttributeNames: { "#count": "count" },
        ExpressionAttributeValues: { ":n": QUOTAS.sessionsGlobalPerHour - 1 },
      }),
    );
    expect((await api.request("/api/session", { body: { tz: "Asia/Tokyo" } })).status).toBe(201);
    const ip = "198.51.100.77";
    const warn = vi.spyOn(log, "warn");
    try {
      const refused = await api.request("/api/session", { body: { tz: "Asia/Tokyo" }, ip });
      expect(refused.status).toBe(429);
      expect(await errorOf(refused)).toMatchObject({ code: "rate_limited", message: SESSIONS_BUSY });
      expect(refused.headers.get("retry-after")).toBe(String(20 * 60)); // until 08:00 UTC
      // The CloudWatch metric filter (infra cost-guard SessionCeiling) matches this exact message.
      expect(warn).toHaveBeenCalledWith(ALARMED_LOGS.sessionCeiling, expect.objectContaining({ limit: QUOTAS.sessionsGlobalPerHour }));
    } finally {
      warn.mockRestore();
    }
    // The refused client keeps its own per-IP and per-network allowance for the next hour.
    expect((await getQuotaUsage(api.deps, SESSION_IP_SCOPE, hashIp(ip, DEFAULT_IP_HASH_KEY), QUOTAS.sessionsPerIpPerHour, "hour")).count).toBe(0);
    expect(
      (await getQuotaUsage(api.deps, SESSION_NETWORK_SCOPE, hashWideNetwork(ip, DEFAULT_IP_HASH_KEY), QUOTAS.sessionsPerNetworkPerHour, "hour")).count,
    ).toBe(0);
    api.clock.set("2026-10-09T08:00:00Z");
    expect((await api.request("/api/session", { body: { tz: "Asia/Tokyo" }, ip })).status).toBe(201);
  });
});

describe("Retry-After on the API's own 429s (R9: the client drops a write only when it is long)", () => {
  it("sends Retry-After on every quota refusal: seconds until JST midnight for daily quotas, until the hour for hourly ones", async () => {
    api.clock.set("2026-10-09T13:00:00Z"); // 22:00 JST
    const s = await api.createSession();
    const ip = "198.51.100.88";
    let hourly: Response | undefined;
    for (let i = 0; i <= QUOTAS.sessionsPerIpPerHour; i++) hourly = await api.request("/api/session", { body: { tz: "Asia/Tokyo" }, ip });
    expect(hourly?.status).toBe(429);
    expect(hourly?.headers.get("retry-after")).toBe(String(60 * 60));
    let daily: Response | undefined;
    for (let i = 0; i <= QUOTAS.profileChangesPerUserPerDay; i++) {
      daily = await api.request("/api/me", { method: "PATCH", token: s.token, body: { nickname: `名前${i}` } });
    }
    expect(daily?.status).toBe(429);
    expect(daily?.headers.get("retry-after")).toBe(String(2 * 60 * 60)); // until 00:00 JST
    await expect(enforceQuota(api.deps, "any-scope", "k", 0, "day")).rejects.toMatchObject({
      status: 429,
      headers: { "Retry-After": String(2 * 60 * 60) },
    });
  });
});

describe("requireAdmin", () => {
  const adminApp = (adminToken?: string) => {
    const app = new Hono<AppEnv>();
    app.get("/api/admin/x", requireAdmin({ ...api.deps, secrets: { adminToken } }), (c) => c.json({ ok: true }));
    app.onError(onError);
    return app;
  };

  it("accepts only the configured token", async () => {
    const app = adminApp(ADMIN_TOKEN);
    expect((await app.request("/api/admin/x", { headers: { "x-admin-token": ADMIN_TOKEN } })).status).toBe(200);
    expect((await app.request("/api/admin/x", { headers: { "x-admin-token": "nope" } })).status).toBe(403);
    expect((await app.request("/api/admin/x")).status).toBe(403);
  });

  it("is closed when no admin token is configured", async () => {
    const res = await adminApp(undefined).request("/api/admin/x", { headers: { "x-admin-token": "" } });
    expect(res.status).toBe(403);
  });
});
