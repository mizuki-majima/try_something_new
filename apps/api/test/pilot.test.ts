/**
 * PILOT metrics on GET /api/admin/stats (docs/validation-plan.md). A file of its own: one fresh
 * dynalite, so the numbers are exact.
 */
import { PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { newId, type AdminStats, type Challenge, type PilotStats, type SessionResponse, type Stamp } from "@thirty/shared";
import { toChallengeItem } from "../src/db/challenges";
import {
  PILOT_PAGE_LIMIT,
  PILOT_TIME_BUDGET_MS,
  computePilotStats,
  pilotStats,
  toPilotChallenge,
  type PilotChallenge,
} from "../src/db/pilot";
import { ADMIN_TOKEN, json, setupApi } from "./helpers";

const api = setupApi();

/** 12:00 in Tokyo on 2026-10-10. */
const NOW = "2026-10-10T03:00:00.000Z";
const TODAY = "2026-10-10";

const pc = (userId: string, startDate: string, stampDays: number[] = [], status = "active", shared = false): PilotChallenge => ({
  userId,
  startDate,
  status,
  stampDays,
  shared,
});

describe("pilotStats (pure)", () => {
  it("counts PEOPLE (docs/validation-plan.md), not challenges", () => {
    const stats = pilotStats(
      [
        pc("a", "2026-10-01", [1, 2, 3, 4, 5]), // day 10: a is eligible and retained
        pc("a", "2026-10-01", [1, 2, 3, 4, 8, 9, 10]), // a's second challenge changes nothing
        pc("b", "2026-10-03", [1, 2, 3, 4, 5, 6, 7], "done", true), // day 8: b eligible, retained, reflected, shared
        pc("b", "2026-10-04", [1, 2, 3, 4, 5, 6, 7], "done"), // b again
        pc("c", "2026-11-01"), // only a reservation: not a starter
        pc("d", TODAY), // day 1: a starter, not eligible yet
        pc("e", "2026-10-02", [1, 2]), // day 9: eligible, not retained
        pc("e", "2026-10-09", [1, 2]), // a later challenge does not make e "not eligible"
        pc("f", "2026-10-05", [1, 2, 3, 4, 5, 6], "done", false), // day 6: reflected early, not eligible
      ],
      TODAY,
    );
    expect(stats).toEqual<PilotStats>({ starters: 5, eligible7: 3, retained7: 2, reflected: 2, sharers: 1 });
  });

  it("one person with many challenges cannot move a rate (the per-challenge numbers did)", () => {
    // 8 people each start 2 challenges and keep one going: per person that is 100%.
    const challenges = Array.from({ length: 8 }, (_, i) => [
      pc(`p${i}`, "2026-10-01", [1, 2, 3, 4, 5]),
      pc(`p${i}`, "2026-10-01", []),
    ]).flat();
    expect(pilotStats(challenges, TODAY)).toMatchObject({ starters: 8, eligible7: 8, retained7: 8 });
    // One person who reflects and shares several times is still one sharer.
    const sharing = [pc("s", "2026-09-01", [], "done", true), pc("s", "2026-09-02", [], "done", true), pc("t", "2026-09-01", [], "done")];
    expect(pilotStats(sharing, TODAY)).toMatchObject({ reflected: 2, sharers: 1 });
  });

  it("is all zeros without challenges", () => {
    expect(pilotStats([], TODAY)).toEqual({ starters: 0, eligible7: 0, retained7: 0, reflected: 0, sharers: 0 });
  });

  it("reads challenge items only, and not imported ones", () => {
    expect(toPilotChallenge({ pk: "USER#u1", sk: "CH#c1", startDate: "2026-10-01", status: "done", stamps: { "1": {}, "7": {}, x: {} }, shareId: "s1" })).toEqual(
      pc("u1", "2026-10-01", [1, 7], "done", true),
    );
    expect(toPilotChallenge({ pk: "USER#u1", sk: "CH#c2", startDate: "2026-10-01" })).toEqual(pc("u1", "2026-10-01"));
    expect(toPilotChallenge({ pk: "USER#u1", sk: "CH#c4", startDate: "2026-10-01", imported: true })).toBeUndefined();
    expect(toPilotChallenge({ pk: "USER#u1", sk: "PROFILE" })).toBeUndefined();
    expect(toPilotChallenge({ pk: "CHREF#c1", sk: "REF", userId: "u1" })).toBeUndefined();
    expect(toPilotChallenge({ pk: "USER#u1", sk: "CH#c3", startDate: "2026-13-01" })).toBeUndefined();
  });
});

// ---------- GET /api/admin/stats ----------

function challenge(startDate: string, stampDays: number[], status: Challenge["status"] = "active"): Challenge {
  const now = Date.parse(NOW);
  const stamps: Record<string, Stamp> = Object.fromEntries(stampDays.map((d) => [String(d), { at: now, note: "ひみつ" }]));
  return {
    id: newId(16),
    recipeId: "photo",
    title: "毎日1枚、写真を撮る",
    seal: "写",
    startDate,
    status,
    stamps,
    verdict: status === "done" ? "continue" : null,
    reflection: null,
    finishedAt: status === "done" ? now : null,
    finishedDay: status === "done" ? 8 : null,
    cheers: 0,
    shareId: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function seed(s: SessionResponse, c: Challenge): Promise<Challenge> {
  await api.deps.db.send(new PutCommand({ TableName: api.deps.tableName, Item: toChallengeItem(s.user.id, s.user, c) }));
  await api.deps.db.send(new PutCommand({ TableName: api.deps.tableName, Item: { pk: `CHREF#${c.id}`, sk: "REF", userId: s.user.id } }));
  return c;
}

async function stats(): Promise<AdminStats> {
  const res = await api.request("/api/admin/stats", { headers: { "x-admin-token": ADMIN_TOKEN } });
  expect(res.status).toBe(200);
  return json<AdminStats>(res);
}

describe("GET /api/admin/stats → pilot", () => {
  it("scans the challenges that exist now, ignoring every other item", async () => {
    api.clock.set(NOW);
    expect((await stats()).pilot).toEqual({ starters: 0, eligible7: 0, retained7: 0, reflected: 0, sharers: 0 });

    const a = await api.createSession("A");
    const b = await api.createSession("B");
    const c = await api.createSession("C"); // only a reservation
    const d = await api.createSession("D"); // no challenge of their own (later: only an imported one)
    await seed(a, challenge("2026-10-01", [1, 2, 3, 4, 5]));
    await seed(a, challenge("2026-10-02", [1, 2, 9]));
    await seed(b, challenge("2026-10-03", [1, 2, 3, 4, 5, 6, 7, 8], "done"));
    await seed(b, challenge("2026-10-04", [1, 2, 3, 4, 5], "done"));
    await seed(c, challenge("2026-11-01", []));
    // Created through the API too: today's start, plus unrelated items (recipe, report, stats).
    const created = await api.request("/api/challenges", {
      token: c.token,
      body: { id: newId(16), recipeId: "walk", title: "毎日20分歩く", seal: "歩", startDate: TODAY },
    });
    expect(created.status).toBe(201);
    await api.request("/api/recipes", {
      token: a.token,
      body: { seal: "跳", title: "毎朝なわとび", category: "body", minutes: 5, place: "out", difficulty: 1, summary: "朝に跳ぶ。", how: [], after: "" },
    });

    const s = await stats();
    // a, b (eligible; a and b retained), c (started today), b reflected.
    expect(s.pilot).toEqual({ starters: 3, eligible7: 2, retained7: 2, reflected: 1, sharers: 0 });
    // Nothing private leaks into the response.
    expect(JSON.stringify(s)).not.toContain("ひみつ");

    // A new person, then their challenge is deleted: they drop out again.
    const e = await api.createSession("E");
    const gone = await seed(e, challenge("2026-10-01", [1, 2, 3, 4, 5, 6]));
    expect((await stats()).pilot).toMatchObject({ starters: 4, eligible7: 3, retained7: 3 });
    expect((await api.request(`/api/challenges/${gone.id}`, { method: "DELETE", token: e.token })).status).toBe(204);
    expect((await stats()).pilot).toEqual({ starters: 3, eligible7: 2, retained7: 2, reflected: 1, sharers: 0 });

    // A current public card on a done challenge makes b a sharer; imported challenges never count.
    await seed(b, { ...challenge("2026-09-20", [1, 2, 3, 4, 5], "done"), shareId: "share0000000001" });
    await api.deps.db.send(
      new PutCommand({ TableName: api.deps.tableName, Item: toChallengeItem(d.user.id, d.user, challenge("2026-09-01", [1, 2, 3, 4, 5], "done"), { imported: true }) }),
    );
    expect((await stats()).pilot).toEqual({ starters: 3, eligible7: 2, retained7: 2, reflected: 1, sharers: 1 });

    // Time moves on: c's first challenge reaches day 8 (and c's reservation starts).
    api.clock.set("2026-11-01T03:00:00.000Z");
    expect((await stats()).pilot).toEqual({ starters: 3, eligible7: 3, retained7: 2, reflected: 1, sharers: 1 });
  });

  it("paginates the scan and stops at the cap", async () => {
    api.clock.set(NOW);
    const full = await computePilotStats(api.deps);
    expect(full.partial).toBeUndefined();
    expect(await computePilotStats(api.deps, { pageSize: 2 })).toEqual(full);
    const capped = await computePilotStats(api.deps, { pageSize: 2, cap: 2 });
    expect(capped.starters).toBeLessThanOrEqual(2);
    expect(capped.partial).toBe(true);
    expect(full.starters).toBeGreaterThan(2);
  });

  it("reads only what the metrics need (no notes, stamps of days 1–7 only) in pages of a bounded size (R15)", async () => {
    api.clock.set(NOW);
    const s = await api.createSession("メモ多め");
    await seed(s, challenge("2026-10-01", [1, 2, 3, 4, 5, 6, 8, 9]));
    const db = api.deps.db;
    const original = db.send.bind(db) as (cmd: unknown) => Promise<{ Items?: unknown[] }>;
    const scans: { input: ScanCommand["input"]; items: unknown[] }[] = [];
    const send = vi.spyOn(db, "send").mockImplementation((async (cmd: unknown) => {
      const out = await original(cmd);
      if (cmd instanceof ScanCommand) scans.push({ input: cmd.input, items: out.Items ?? [] });
      return out;
    }) as typeof db.send);
    let result: PilotStats;
    try {
      result = await computePilotStats(api.deps);
    } finally {
      send.mockRestore();
    }
    expect(result.retained7).toBeGreaterThan(0);
    expect(scans.length).toBeGreaterThan(0);
    for (const scan of scans) {
      expect(scan.input.Limit).toBe(PILOT_PAGE_LIMIT);
      // Before: the whole stamps map came back, notes ("ひみつ") included.
      expect(JSON.stringify(scan.items)).not.toContain("ひみつ");
    }
    const mine = scans.flatMap((x) => x.items as Record<string, unknown>[]).find((i) => i.pk === `USER#${s.user.id}`);
    expect(Object.keys(mine?.stamps as object).sort()).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it(`stops after ${PILOT_TIME_BUDGET_MS / 1000} seconds and says the numbers are partial (R15)`, async () => {
    api.clock.set(NOW);
    expect(PILOT_TIME_BUDGET_MS).toBe(20_000);
    // A fake monotonic clock: every read of it is 7 seconds later, so the 4th page is never read.
    let t = 0;
    const elapsed = () => (t += 7_000);
    const db = api.deps.db;
    const send = vi.spyOn(db, "send");
    let result: PilotStats;
    let pages: number;
    try {
      result = await computePilotStats(api.deps, { pageSize: 1, elapsed });
      pages = send.mock.calls.filter(([cmd]) => cmd instanceof ScanCommand).length;
    } finally {
      send.mockRestore();
    }
    expect(pages).toBeLessThanOrEqual(3); // before: every page of the table
    expect(result.partial).toBe(true);
    // A scan that finishes in time is not marked (the admin page shows a note only when partial).
    expect((await stats()).pilot.partial).toBeUndefined();
  });
});
