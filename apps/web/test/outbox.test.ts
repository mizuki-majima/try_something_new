import type { Challenge } from "@thirty/shared";
import { describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../src/lib/http";
import {
  applyPending,
  backoffMs,
  classifyError,
  drain,
  enqueue,
  isAlreadyDone,
  isLongRateLimit,
  opRequest,
  retryDelayMs,
  type OutboxItem,
  type OutboxOp,
} from "../src/lib/outbox";

let n = 0;
const key = () => `k${++n}`;

function queue(...ops: OutboxOp[]): OutboxItem[] {
  return ops.reduce<OutboxItem[]>((items, op) => enqueue(items, op, 1000, key()), []);
}

const create = (id: string): OutboxOp => ({ kind: "challenge.create", body: { id, title: "毎日1枚、写真を撮る", seal: "写", startDate: "2026-10-01", recipeId: "photo" } });
const stamp = (id: string, day: number, note?: string): OutboxOp => ({ kind: "stamp.put", id, day, body: note === undefined ? {} : { note } });

/** An in-memory store for drain(). */
function memory(items: OutboxItem[]) {
  let state = items;
  return {
    load: () => state,
    save: (next: OutboxItem[]) => {
      state = next;
    },
    get items() {
      return state;
    },
  };
}

describe("enqueue", () => {
  it("merges repeated edits of the same stamp into one item with a fresh key", () => {
    const items = queue(stamp("a", 1), stamp("a", 1, "雨だった"));
    expect(items).toHaveLength(1);
    expect(items[0]!.op).toEqual(stamp("a", 1, "雨だった"));
    const again = enqueue(items, stamp("a", 1, "晴れた"), 2000, "fresh");
    expect(again).toHaveLength(1);
    expect(again[0]!.key).toBe("fresh");
  });

  it("does not merge different days or a delete", () => {
    expect(queue(stamp("a", 1), stamp("a", 2))).toHaveLength(2);
    expect(queue(stamp("a", 1), { kind: "stamp.delete", id: "a", day: 1 }, stamp("a", 1))).toHaveLength(3);
  });

  it("merges profile patches", () => {
    const items = queue({ kind: "me.patch", body: { nickname: "みず" } }, { kind: "me.patch", body: { shareProgress: false } });
    expect(items).toHaveLength(1);
    expect(items[0]!.op).toEqual({ kind: "me.patch", body: { nickname: "みず", shareProgress: false } });
  });

  it("deleting a challenge the server never saw just cancels its queue", () => {
    const items = queue(create("a"), stamp("a", 1), create("b"), { kind: "challenge.delete", id: "a" });
    expect(items.map((i) => i.op.kind)).toEqual(["challenge.create"]);
    expect(items[0]!.op).toEqual(create("b"));
  });

  it("deleting a challenge whose create may have reached the server sends a delete", () => {
    const sent = queue(create("a")).map((i) => ({ ...i, sent: true }));
    const items = enqueue([...sent, ...queue(stamp("a", 1))], { kind: "challenge.delete", id: "a" }, 1000, key());
    expect(items.map((i) => i.op.kind)).toEqual(["challenge.create", "challenge.delete"]);
  });
});

describe("drain", () => {
  it("sends items strictly in order and empties the queue", async () => {
    const store = memory(queue(create("a"), stamp("a", 1), { kind: "me.patch", body: { nickname: "みず" } }));
    const calls: string[] = [];
    const result = await drain({
      ...store,
      send: async (item) => {
        const r = opRequest(item.op);
        calls.push(`${r.method} ${r.path}`);
        return {};
      },
    });
    expect(result).toEqual({ status: "empty", sent: 3, dropped: 0 });
    expect(calls).toEqual(["POST /api/challenges", "PUT /api/challenges/a/stamps/1", "PATCH /api/me"]);
    expect(store.items).toEqual([]);
  });

  it("drops a 4xx item, reports it and carries on", async () => {
    const store = memory(queue(stamp("a", 1), stamp("a", 2), stamp("a", 3)));
    const onDropped = vi.fn();
    const send = vi.fn(async (item: OutboxItem) => {
      if (item.op.kind === "stamp.put" && item.op.day === 2) throw new ApiClientError(409, "conflict", "もう振り返り済みです");
      return {};
    });
    const result = await drain({ ...store, send, onDropped });
    expect(result).toEqual({ status: "empty", sent: 2, dropped: 1 });
    expect(send).toHaveBeenCalledTimes(3);
    expect(onDropped).toHaveBeenCalledTimes(1);
    expect((onDropped.mock.calls[0]![1] as ApiClientError).message).toBe("もう振り返り済みです");
    expect(store.items).toEqual([]);
  });

  it("when a create is rejected, its dependent ops are dropped without sending", async () => {
    const store = memory(queue(create("a"), stamp("a", 1), create("b")));
    const sent: string[] = [];
    const result = await drain({
      ...store,
      send: async (item) => {
        if (item.op.kind === "challenge.create" && item.op.body.id === "a") throw new ApiClientError(409, "conflict");
        sent.push(opRequest(item.op).path);
        return {};
      },
    });
    expect(result.dropped).toBe(1);
    expect(sent).toEqual(["/api/challenges"]);
    expect(store.items).toEqual([]);
  });

  it("keeps a 5xx item and everything after it, in order, for a later retry", async () => {
    const initial = queue(create("a"), stamp("a", 1));
    const store = memory(initial);
    const send = vi.fn(async () => {
      throw new ApiClientError(503, "internal");
    });
    const result = await drain({ ...store, send });
    expect(result.status).toBe("retry");
    expect(result).toMatchObject({ attempts: 1, sent: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.items.map((i) => i.key)).toEqual(initial.map((i) => i.key));
    expect(store.items[0]).toMatchObject({ attempts: 1, sent: true });
    expect(store.items[1]).toMatchObject({ attempts: 0, sent: false });
  });

  it("treats network errors and timeouts as retryable", async () => {
    for (const err of [new ApiClientError(0, "network"), new ApiClientError(0, "timeout"), new ApiClientError(429, "rate_limited")]) {
      const store = memory(queue(stamp("a", 1)));
      const result = await drain({ ...store, send: () => Promise.reject(err) });
      expect(result.status).toBe("retry");
      expect(store.items).toHaveLength(1);
    }
  });

  it("a create refused by the daily quota (429) is dropped with its dependent ops; later writes still go out", async () => {
    const store = memory(queue(create("a"), stamp("a", 1), stamp("b", 3), { kind: "me.patch", body: { nickname: "みず" } }));
    const sent: string[] = [];
    const onDropped = vi.fn();
    const result = await drain({
      ...store,
      send: async (item) => {
        // The server's create quota resets at 0:00 JST: Retry-After is hours away.
        if (item.op.kind === "challenge.create") throw new ApiClientError(429, "rate_limited", "今日はここまでです。", undefined, 51_365);
        sent.push(opRequest(item.op).path);
        return {};
      },
      onDropped,
    });
    expect(result).toEqual({ status: "empty", sent: 2, dropped: 1 });
    expect(sent).toEqual(["/api/challenges/b/stamps/3", "/api/me"]);
    expect(onDropped).toHaveBeenCalledTimes(1);
    expect(store.items).toEqual([]);
  });

  it("a 429 on a create is dropped even without Retry-After; a long Retry-After drops any write", async () => {
    const short = memory(queue(create("a")));
    expect((await drain({ ...short, send: () => Promise.reject(new ApiClientError(429, "rate_limited")) })).status).toBe("empty");
    expect(short.items).toEqual([]);

    const long = memory(queue(stamp("a", 1), stamp("a", 2)));
    const r = await drain({ ...long, send: (item) => (item.op.kind === "stamp.put" && item.op.day === 1 ? Promise.reject(new ApiClientError(429, "rate_limited", undefined, undefined, 7_200)) : Promise.resolve({})) });
    expect(r).toEqual({ status: "empty", sent: 1, dropped: 1 });
  });

  it("stops on 401 and keeps the queue for after the account is restored", async () => {
    const store = memory(queue(stamp("a", 1), stamp("a", 2)));
    const result = await drain({ ...store, send: () => Promise.reject(new ApiClientError(401, "unauthorized")) });
    expect(result.status).toBe("auth");
    expect(store.items).toHaveLength(2);
  });

  it("treats a 404 to a queued challenge delete as done: no drop, no rollback, no message", async () => {
    const del: OutboxOp = { kind: "challenge.delete", id: "a" };
    const store = memory(queue(del, stamp("b", 1)));
    const onSent = vi.fn();
    const onDropped = vi.fn();
    const send = vi.fn(async (item: OutboxItem) => {
      if (item.op.kind === "challenge.delete") throw new ApiClientError(404, "not_found");
      return {};
    });
    const result = await drain({ ...store, send, onSent, onDropped });
    expect(result).toEqual({ status: "empty", sent: 2, dropped: 0 });
    expect(onDropped).not.toHaveBeenCalled();
    expect(onSent).toHaveBeenCalledTimes(2);
    expect(onSent.mock.calls[0]![0].op).toEqual(del);
    expect(onSent.mock.calls[0]![1]).toBeUndefined();
    expect(store.items).toEqual([]);
    // Applied as sent: the challenge stays deleted locally.
    const base = applyPending({ user: null, challenges: [] }, queue(create("a")));
    expect(applyPending(base, queue(del)).challenges).toEqual([]);
  });

  it("still drops other 404s and other failures of a delete", async () => {
    expect(isAlreadyDone({ kind: "challenge.delete", id: "a" }, new ApiClientError(404, "not_found"))).toBe(true);
    expect(isAlreadyDone({ kind: "challenge.delete", id: "a" }, new ApiClientError(409, "conflict"))).toBe(false);
    expect(isAlreadyDone({ kind: "challenge.delete", id: "a" }, new ApiClientError(500, "internal"))).toBe(false);
    expect(isAlreadyDone({ kind: "stamp.delete", id: "a", day: 1 }, new ApiClientError(404, "not_found"))).toBe(false);
    expect(isAlreadyDone(stamp("a", 1), new ApiClientError(404, "not_found"))).toBe(false);
    expect(isAlreadyDone({ kind: "challenge.delete", id: "a" }, new TypeError("bug"))).toBe(false);

    const store = memory(queue(stamp("a", 1)));
    const onDropped = vi.fn();
    const result = await drain({ ...store, send: () => Promise.reject(new ApiClientError(404, "not_found")), onDropped });
    expect(result).toEqual({ status: "empty", sent: 0, dropped: 1 });
    expect(onDropped).toHaveBeenCalledTimes(1);

    // A 5xx on the delete is retried as usual.
    const retry = memory(queue({ kind: "challenge.delete", id: "a" }));
    expect((await drain({ ...retry, send: () => Promise.reject(new ApiClientError(503, "internal")) })).status).toBe("retry");
    expect(retry.items).toHaveLength(1);
  });

  it("a create followed by its delete before sending: both are dropped and nothing is sent", async () => {
    const del: OutboxOp = { kind: "challenge.delete", id: "a" };
    const patch: OutboxOp = { kind: "challenge.patch", id: "a", body: { title: "変更" } };
    for (const ops of [[create("a"), del], [create("a"), stamp("a", 1), patch, stamp("a", 1, "メモ"), del]]) {
      const store = memory(queue(...ops));
      expect(store.items).toEqual([]);
      const send = vi.fn(async () => ({}));
      expect(await drain({ ...store, send })).toEqual({ status: "empty", sent: 0, dropped: 0 });
      expect(send).not.toHaveBeenCalled();
    }
    // Other challenges' items stay, in order.
    const mixed = queue(stamp("b", 1), create("a"), stamp("a", 1), stamp("b", 2), del);
    expect(mixed.map((i) => [i.op.kind, "id" in i.op ? i.op.id : i.op.kind === "challenge.create" ? i.op.body.id : null])).toEqual([
      ["stamp.put", "b"],
      ["stamp.put", "b"],
    ]);
  });

  it("picks up items enqueued while a send is in flight", async () => {
    const store = memory(queue(stamp("a", 1)));
    const seen: number[] = [];
    await drain({
      ...store,
      send: async (item) => {
        if (item.op.kind === "stamp.put") seen.push(item.op.day);
        if (seen.length === 1) store.save(enqueue(store.load(), stamp("a", 2), 2000, key()));
        return {};
      },
    });
    expect(seen).toEqual([1, 2]);
    expect(store.items).toEqual([]);
  });
});

describe("classifyError / backoff", () => {
  it("429: a create or a Retry-After beyond an hour is dropped, a short one is retried", () => {
    const limited = (retryAfter?: number) => new ApiClientError(429, "rate_limited", undefined, undefined, retryAfter);
    expect(classifyError(limited(), create("a"))).toBe("drop");
    expect(classifyError(limited(30), create("a"))).toBe("drop");
    expect(classifyError(limited(), stamp("a", 1))).toBe("retry");
    expect(classifyError(limited(60), stamp("a", 1))).toBe("retry");
    expect(classifyError(limited(3_600), stamp("a", 1))).toBe("retry");
    expect(classifyError(limited(3_601), { kind: "me.patch", body: { nickname: "みず" } })).toBe("drop");
    expect(isLongRateLimit(create("a"), new ApiClientError(503, "internal"))).toBe(false);
    expect(classifyError(new ApiClientError(503, "internal"), create("a"))).toBe("retry");
  });

  it("waits at least as long as a short 429's Retry-After (capped at an hour)", () => {
    expect(retryDelayMs(1, new ApiClientError(503, "internal"))).toBe(2000);
    expect(retryDelayMs(1, new ApiClientError(429, "rate_limited"))).toBe(2000);
    expect(retryDelayMs(1, new ApiClientError(429, "rate_limited", undefined, undefined, 90))).toBe(90_000);
    expect(retryDelayMs(20, new ApiClientError(429, "rate_limited", undefined, undefined, 10))).toBe(300_000);
    expect(retryDelayMs(1, new ApiClientError(429, "rate_limited", undefined, undefined, 86_400))).toBe(3_600_000);
  });

  it("classifies by status", () => {
    expect(classifyError(new ApiClientError(400, "bad_request"))).toBe("drop");
    expect(classifyError(new ApiClientError(404, "not_found"))).toBe("drop");
    expect(classifyError(new ApiClientError(500, "internal"))).toBe("retry");
    expect(classifyError(new ApiClientError(0, "network"))).toBe("retry");
    expect(classifyError(new ApiClientError(401, "unauthorized"))).toBe("auth");
    expect(classifyError(new TypeError("bug"))).toBe("drop");
  });

  it("backs off exponentially with a cap", () => {
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(2)).toBe(4000);
    expect(backoffMs(20)).toBe(300_000);
  });
});

describe("applyPending", () => {
  it("replays queued ops on top of server state", () => {
    const base = { user: null, challenges: [] as Challenge[] };
    const items = queue(create("a"), stamp("a", 1), stamp("a", 2, "雨"), { kind: "stamp.delete", id: "a", day: 1 });
    const { challenges } = applyPending(base, items);
    expect(challenges).toHaveLength(1);
    expect(challenges[0]).toMatchObject({ id: "a", seal: "写", status: "active", stamps: { "2": { note: "雨" } } });
    expect(challenges[0]!.stamps["1"]).toBeUndefined();

    const reflected = applyPending(
      { user: null, challenges },
      queue({ kind: "challenge.reflect", id: "a", body: { verdict: "continue", reflection: "続ける" }, finishedDay: 30 }),
    );
    expect(reflected.challenges[0]).toMatchObject({ status: "done", verdict: "continue", reflection: "続ける", finishedDay: 30 });
  });

  it("does not duplicate a create the server already has", () => {
    const first = applyPending({ user: null, challenges: [] }, queue(create("a")));
    const again = applyPending(first, queue(create("a")));
    expect(again.challenges).toHaveLength(1);
  });
});
