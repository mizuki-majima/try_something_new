import { API } from "@thirty/shared";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ApiClientError, THROTTLED_MESSAGE, isQuotaLimit, request } from "../src/lib/api";
import { requestBody } from "../src/lib/http";
import { clearSession, getToken, isSessionInvalid } from "../src/lib/session";
import { KEYS, writeString } from "../src/lib/storage";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

let fetchMock: Mock<typeof fetch>;

beforeEach(() => {
  clearSession();
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function failure(p: Promise<unknown>): Promise<ApiClientError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiClientError) return err;
    throw err;
  }
  throw new Error("expected the request to fail");
}

describe("request", () => {
  it("returns parsed JSON and sends JSON bodies", async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true }));
    await expect(request("POST", API.contact, { body: { message: "こんにちは" }, auth: "none" })).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/contact");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init?.body).toBe(JSON.stringify({ message: "こんにちは" }));
  });

  it("always sends JSON for POST / PUT / PATCH, with {} when there is no body (the API answers 415 otherwise)", async () => {
    fetchMock.mockImplementation(async () => json(200, {}));
    for (const method of ["POST", "PUT", "PATCH"] as const) {
      fetchMock.mockClear();
      await request(method, "/api/x", { auth: "none" });
      const init = fetchMock.mock.calls[0]![1]!;
      expect(init.method).toBe(method);
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      expect(init.body).toBe("{}");
    }
  });

  it("sends a DELETE body as JSON, and a DELETE or GET without one with neither body nor Content-Type", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
    await request("DELETE", API.pushSubscriptions, { body: { endpoint: "https://fcm.googleapis.com/x" }, auth: "none" });
    let init = fetchMock.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ endpoint: "https://fcm.googleapis.com/x" }));
    for (const method of ["DELETE", "GET"] as const) {
      fetchMock.mockClear();
      await request(method, "/api/x", { auth: "none" });
      init = fetchMock.mock.calls[0]![1]!;
      expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
      expect(init.body).toBeUndefined();
    }
  });

  it("requestBody: the wire body for each method", () => {
    expect(requestBody("POST", undefined)).toBe("{}");
    expect(requestBody("put", undefined)).toBe("{}");
    expect(requestBody("PATCH", { a: 1 })).toBe('{"a":1}');
    expect(requestBody("DELETE", undefined)).toBeUndefined();
    expect(requestBody("DELETE", { endpoint: "e" })).toBe('{"endpoint":"e"}');
    expect(requestBody("GET", undefined)).toBeUndefined();
    expect(requestBody("POST", null)).toBe("null");
  });

  it("maps an ApiError body to ApiClientError with fields", async () => {
    fetchMock.mockResolvedValue(
      json(400, { error: { code: "bad_request", message: "タイトルを入力してください", fields: { title: "タイトルを入力してください" } } }),
    );
    const err = await failure(request("POST", API.recipes, { body: {}, auth: "none" }));
    expect(err.status).toBe(400);
    expect(err.code).toBe("bad_request");
    expect(err.message).toBe("タイトルを入力してください");
    expect(err.fields).toEqual({ title: "タイトルを入力してください" });
    expect(err.retryable).toBe(false);
  });

  it("maps a non-JSON 5xx to internal and does not retry", async () => {
    fetchMock.mockResolvedValue(new Response("<html>Bad Gateway</html>", { status: 502 }));
    const err = await failure(request("GET", API.recipes));
    expect(err.status).toBe(502);
    expect(err.code).toBe("internal");
    expect(err.retryable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the server error code on a 503 and makes one attempt only", async () => {
    fetchMock.mockResolvedValue(json(503, { error: { code: "ai_unavailable", message: "いまは提案を使えません" } }));
    const err = await failure(request("POST", API.suggestions, { body: {}, auth: "none" }));
    expect(err.code).toBe("ai_unavailable");
    expect(err.message).toBe("いまは提案を使えません");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps 429 to rate_limited with Retry-After", async () => {
    fetchMock.mockResolvedValue(json(429, { error: { code: "rate_limited", message: "今日はここまで" } }, { "Retry-After": "120" }));
    const err = await failure(request("POST", API.suggestions, { body: {}, auth: "none" }));
    expect(err.code).toBe("rate_limited");
    expect(err.retryAfter).toBe(120);
  });

  it("tells the action's own quota from the edge throttle and from a refused account creation (isQuotaLimit)", async () => {
    // The API's quota: its JSON error and Retry-After.
    fetchMock.mockResolvedValueOnce(json(429, { error: { code: "rate_limited", message: "今日はここまで" } }, { "Retry-After": "120" }));
    const own = await failure(request("POST", API.suggestions, { body: {}, auth: "none" }));
    expect(own.fromApi).toBe(true);
    expect(isQuotaLimit(own)).toBe(true);

    // API Gateway's stage throttle: {"message":"Too Many Requests"}, no Retry-After.
    fetchMock.mockResolvedValueOnce(json(429, { message: "Too Many Requests" }));
    const edge = await failure(request("POST", API.suggestions, { body: {}, auth: "none" }));
    expect(edge).toMatchObject({ status: 429, code: "rate_limited", fromApi: false, retryAfter: undefined, message: THROTTLED_MESSAGE });
    expect(isQuotaLimit(edge)).toBe(false);

    // The account creation in front of the action was refused (R7: per network, and overall).
    clearSession();
    fetchMock.mockResolvedValueOnce(json(429, { error: { code: "rate_limited", message: "混み合っています" } }, { "Retry-After": "600" }));
    const session = await failure(request("POST", API.suggestions, { body: {}, auth: "required" }));
    expect(session).toMatchObject({ status: 429, fromApi: true, session: true, retryAfter: 600, message: "混み合っています" });
    expect(isQuotaLimit(session)).toBe(false);
    expect(isQuotaLimit(new ApiClientError(500, "internal"))).toBe(false);
    expect(isQuotaLimit(new Error("x"))).toBe(false);
  });

  it("maps a failed fetch to network", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const err = await failure(request("GET", API.recipes));
    expect(err.status).toBe(0);
    expect(err.code).toBe("network");
    expect(err.retryable).toBe(true);
  });

  it("times out with code timeout", async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const err = await failure(request("GET", API.recipes, { timeoutMs: 20 }));
    expect(err.code).toBe("timeout");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a caller abort as aborted", async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const ctrl = new AbortController();
    const p = request("GET", API.recipes, { signal: ctrl.signal });
    ctrl.abort();
    const err = await failure(p);
    expect(err.code).toBe("aborted");
    expect(err.retryable).toBe(false);
  });

  it("returns undefined for 204", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(request("POST", API.reports, { body: { targetType: "recipe", targetId: "x" }, auth: "none" })).resolves.toBeUndefined();
  });

  it("sends the bearer token unless auth is none", async () => {
    writeString(KEYS.token, "tok-123");
    fetchMock.mockImplementation(async () => json(200, {}));
    await request("GET", API.recipes);
    await request("GET", API.health, { auth: "none" });
    const h1 = fetchMock.mock.calls[0]![1]?.headers as Record<string, string>;
    const h2 = fetchMock.mock.calls[1]![1]?.headers as Record<string, string>;
    expect(h1.Authorization).toBe("Bearer tok-123");
    expect(h2.Authorization).toBeUndefined();
  });

  it("creates the session first when auth is required", async () => {
    fetchMock.mockImplementation(async (url) =>
      url === API.session
        ? json(201, {
            token: "new-token",
            user: { id: "u0000000000001", nickname: "", tz: "Asia/Tokyo", shareProgress: true, reminder: { enabled: false, time: "21:00" }, createdAt: 1 },
          })
        : json(200, { recipe: {} }),
    );
    await request("POST", API.recipes, { body: {}, auth: "required" });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([API.session, API.recipes]);
    expect((fetchMock.mock.calls[1]![1]?.headers as Record<string, string>).Authorization).toBe("Bearer new-token");
    expect(getToken()).toBe("new-token");
  });

  it("marks the session invalid when our token gets a 401", async () => {
    writeString(KEYS.token, "stale");
    fetchMock.mockResolvedValue(json(401, { error: { code: "unauthorized", message: "トークンが無効です" } }));
    const err = await failure(request("GET", API.challenges));
    expect(err.code).toBe("unauthorized");
    expect(getToken()).toBeNull();
    expect(isSessionInvalid()).toBe(true);
  });
});
