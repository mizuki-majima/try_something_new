import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { QUOTAS, type ApiError } from "@thirty/shared";
import { hashIp, ipKey, requireAdmin, sha256 } from "../src/auth";
import { MAX_BODY_BYTES, originVerifyValues } from "../src/app";
import { DEFAULT_IP_HASH_KEY } from "../src/config";
import { enforceQuota, getQuotaUsage, refundQuota, windowFor } from "../src/db/rate";
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
  it("counts an IPv6 /64 as one client, and an IPv4-mapped address as its IPv4 address", () => {
    expect(ipKey("203.0.113.9")).toBe("203.0.113.9");
    expect(ipKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:0DB8:0001:0002:ffff:eeee:dddd:cccc")).toBe("2001:db8:1:2::/64");
    expect(ipKey("[2001:db8:1:2::5]")).toBe("2001:db8:1:2::/64");
    expect(ipKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(ipKey("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(ipKey("2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(ipKey("::1")).toBe("0:0:0:0::/64");
    expect(ipKey("unknown")).toBe("unknown");
    expect(ipKey("2001:db8:1:3::1")).not.toBe(ipKey("2001:db8:1:2::1"));
  });

  it("is a keyed hash (HMAC): not the plain SHA-256 of the address, and different per key", () => {
    const h = hashIp("203.0.113.9", DEFAULT_IP_HASH_KEY);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toBe(sha256("203.0.113.9"));
    expect(hashIp("203.0.113.9", "another-key")).not.toBe(h);
    expect(hashIp("2001:db8:1:2::1", "k")).toBe(hashIp("2001:db8:1:2:aaaa::9", "k"));
  });

  it("applies the per-IP session quota to the whole IPv6 /64", async () => {
    api.clock.set("2026-10-09T05:10:00Z");
    for (let i = 1; i <= QUOTAS.sessionsPerIpPerHour; i++) {
      const res = await api.request("/api/session", { body: { tz: "Asia/Tokyo" }, ip: `2001:db8:77:1::${i.toString(16)}` });
      expect(res.status, String(i)).toBe(201);
    }
    // Another address in the same /64 is the same client.
    expect((await api.request("/api/session", { body: { tz: "Asia/Tokyo" }, ip: "2001:db8:77:1:abcd::99" })).status).toBe(429);
    // The next /64 is someone else.
    expect((await api.request("/api/session", { body: { tz: "Asia/Tokyo" }, ip: "2001:db8:77:2::1" })).status).toBe(201);
    // The stored rate-limit keys never contain the address.
    expect(JSON.stringify(await api.scanAll())).not.toContain("2001:db8:77");
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
