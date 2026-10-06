import { describe, expect, it } from "vitest";
import { QUOTAS, type ApiError, type MeResponse, type SessionResponse, type TransferCodeResponse } from "@thirty/shared";
import { sha256 } from "../src/auth";
import { getStats } from "../src/db/stats";
import { TRANSFER_ALPHABET } from "../src/db/users";
import { json, setupApi } from "./helpers";

const api = setupApi();

describe("POST /api/session", () => {
  it("creates an anonymous user with defaults and a working token", async () => {
    const before = await getStats(api.deps);
    const res = await api.request("/api/session", { body: { tz: "Asia/Tokyo" } });
    expect(res.status).toBe(201);
    const { token, user } = await json<SessionResponse>(res);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(user).toMatchObject({
      nickname: "名無し",
      tz: "Asia/Tokyo",
      shareProgress: true,
      reminder: { enabled: false, time: "21:00" },
    });
    expect(user.id).toMatch(/^[0-9a-z]{16}$/);

    const me = await api.request("/api/me", { token });
    expect(me.status).toBe(200);
    expect((await json<MeResponse>(me)).user.id).toBe(user.id);

    expect((await getStats(api.deps)).users).toBe(before.users + 1);
  });

  it("stores only the SHA-256 of the token", async () => {
    const { token } = await api.createSession("ハッシュ");
    const dump = JSON.stringify(await api.scanAll());
    expect(dump).not.toContain(token);
    expect(dump).toContain(`TOKEN#${sha256(token)}`);
  });

  it("cleans the nickname and validates the time zone", async () => {
    const ok = await json<SessionResponse>(await api.request("/api/session", { body: { tz: "UTC", nickname: "  みずき​  " } }));
    expect(ok.user.nickname).toBe("みずき");

    const bad = await api.request("/api/session", { body: { tz: "Mars/Olympus", nickname: "see example.com" } });
    expect(bad.status).toBe(400);
    const err = await json<ApiError>(bad);
    expect(err.error.code).toBe("bad_request");
    expect(Object.keys(err.error.fields ?? {}).sort()).toEqual(["nickname", "tz"]);
  });

  it("limits new sessions per IP per hour", async () => {
    const ip = "192.0.2.10";
    for (let i = 0; i < QUOTAS.sessionsPerIpPerHour; i++) {
      expect((await api.request("/api/session", { body: { tz: "UTC" }, ip })).status).toBe(201);
    }
    const limited = await api.request("/api/session", { body: { tz: "UTC" }, ip });
    expect(limited.status).toBe(429);
    expect((await json<ApiError>(limited)).error.code).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

    api.clock.advance(60 * 60_000);
    expect((await api.request("/api/session", { body: { tz: "UTC" }, ip })).status).toBe(201);
  });
});

describe("device transfer", () => {
  const issue = async (token: string) => {
    const res = await api.request("/api/me/transfer-code", { method: "POST", token });
    expect(res.status).toBe(201);
    return json<TransferCodeResponse>(res);
  };
  const redeem = (code: string, ip?: string) => api.request("/api/session/transfer", { body: { code }, ip });

  it("gives a second device a new token for the same user, once", async () => {
    const a = await api.createSession("引き継ぎ");
    const { code, expiresAt } = await issue(a.token);
    expect(code).toHaveLength(8);
    for (const ch of code) expect(TRANSFER_ALPHABET).toContain(ch);
    expect(expiresAt - api.clock.now().getTime()).toBe(15 * 60_000);

    // Typed loosely on the other device: lower case with a separator.
    const res = await redeem(`${code.slice(0, 4).toLowerCase()}-${code.slice(4).toLowerCase()}`);
    expect(res.status).toBe(200);
    const b = await json<SessionResponse>(res);
    expect(b.user.id).toBe(a.user.id);
    expect(b.token).not.toBe(a.token);

    // Both devices keep working.
    expect((await api.request("/api/me", { token: a.token })).status).toBe(200);
    expect((await api.request("/api/me", { token: b.token })).status).toBe(200);

    const again = await redeem(code);
    expect(again.status).toBe(400);
    expect((await json<ApiError>(again)).error.fields?.code).toBeTruthy();
  });

  it("expires after 15 minutes", async () => {
    const a = await api.createSession();
    const { code } = await issue(a.token);
    api.clock.advance(15 * 60_000 + 1_000);
    expect((await redeem(code)).status).toBe(400);
  });

  it("revokes the previous code when a new one is issued", async () => {
    const a = await api.createSession();
    const first = await issue(a.token);
    const second = await issue(a.token);
    expect((await redeem(first.code)).status).toBe(400);
    expect((await redeem(second.code)).status).toBe(200);
  });

  it("rejects malformed codes without touching the quota", async () => {
    const res = await redeem("12");
    expect(res.status).toBe(400);
  });

  it("throttles guessing per IP", async () => {
    const ip = "198.51.100.7";
    for (let i = 0; i < QUOTAS.transferRedeemPerIpPerHour; i++) expect((await redeem("ZZZZZZZZ", ip)).status).toBe(400);
    expect((await redeem("ZZZZZZZZ", ip)).status).toBe(429);
  });

  it("limits code issuing per user per hour", async () => {
    const a = await api.createSession();
    for (let i = 0; i < QUOTAS.transferCodesPerUserPerHour; i++) await issue(a.token);
    const res = await api.request("/api/me/transfer-code", { method: "POST", token: a.token });
    expect(res.status).toBe(429);
  });
});
