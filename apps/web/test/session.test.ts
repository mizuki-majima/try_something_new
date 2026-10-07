import { API, type SessionResponse } from "@thirty/shared";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ApiClientError } from "../src/lib/http";
import { clearSession, ensureSession, getToken, isSessionInvalid, markSessionInvalid, redeemTransfer, subscribeSessionCreated } from "../src/lib/session";
import { KEYS, writeString } from "../src/lib/storage";

const user = { id: "u0000000000001", nickname: "みず", tz: "Asia/Tokyo", shareProgress: true, reminder: { enabled: false, time: "21:00" }, createdAt: 1 };

function sessionResponse(token: string): Response {
  const body: SessionResponse = { token, user };
  return new Response(JSON.stringify(body), { status: 201, headers: { "Content-Type": "application/json" } });
}

let fetchMock: Mock<typeof fetch>;

beforeEach(() => {
  clearSession();
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ensureSession", () => {
  it("creates the account once for concurrent callers and stores the token", async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));

    const a = ensureSession("みず");
    const b = ensureSession();
    resolve(sessionResponse("tok-1"));
    const [ra, rb] = await Promise.all([a, b]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ra).toEqual(rb);
    expect(ra).toMatchObject({ token: "tok-1", created: true, user: { id: user.id } });
    expect(getToken()).toBe("tok-1");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(API.session);
    const body = JSON.parse(String(init?.body)) as { tz: string; nickname?: string };
    expect(body.nickname).toBe("みず");
    expect(body.tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("is idempotent once a token exists", async () => {
    writeString(KEYS.token, "existing");
    await expect(ensureSession()).resolves.toEqual({ token: "existing", user: null, created: false });
    await expect(ensureSession()).resolves.toMatchObject({ token: "existing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops an invalid nickname instead of failing the account creation", async () => {
    fetchMock.mockResolvedValue(sessionResponse("tok-2"));
    await ensureSession("https://spam.example.com");
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as { nickname?: string };
    expect(body.nickname).toBeUndefined();
  });

  it("can try again after a failed attempt", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(sessionResponse("tok-3"));
    await expect(ensureSession()).rejects.toMatchObject({ code: "network" });
    await expect(ensureSession()).resolves.toMatchObject({ token: "tok-3" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses to create a new account while the session is flagged invalid", async () => {
    writeString(KEYS.token, "old");
    markSessionInvalid();
    expect(getToken()).toBeNull();
    const err = await ensureSession().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not store a token that arrives after clearSession", async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    const p = ensureSession();
    clearSession();
    resolve(sessionResponse("late"));
    await p;
    expect(getToken()).toBeNull();
  });
});

describe("subscribeSessionCreated", () => {
  it("tells listeners about an account created by any caller, once, with its user", async () => {
    const created = vi.fn();
    const unsubscribe = subscribeSessionCreated(created);
    fetchMock.mockResolvedValue(sessionResponse("tok-4"));
    await Promise.all([ensureSession(), ensureSession()]);
    expect(created).toHaveBeenCalledTimes(1);
    expect(created).toHaveBeenCalledWith({ token: "tok-4", user });

    await ensureSession(); // the token exists: nothing is created
    expect(created).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("is silent for a create that resolves after clearSession", async () => {
    const created = vi.fn();
    const unsubscribe = subscribeSessionCreated(created);
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    const p = ensureSession();
    clearSession();
    resolve(sessionResponse("late"));
    await p;
    expect(created).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("redeemTransfer", () => {
  it("normalises the code, stores the new token and clears the invalid flag", async () => {
    markSessionInvalid();
    fetchMock.mockResolvedValue(sessionResponse("tok-transfer"));
    await redeemTransfer("abcd-1234");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ code: "ABCD1234" });
    expect(fetchMock.mock.calls[0]![0]).toBe(API.sessionTransfer);
    expect(getToken()).toBe("tok-transfer");
    expect(isSessionInvalid()).toBe(false);
  });

  it("rejects a malformed code without calling the API", async () => {
    await expect(redeemTransfer("abc")).rejects.toMatchObject({ status: 400, code: "bad_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
