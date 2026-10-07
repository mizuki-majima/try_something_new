/**
 * PILOT metrics on GET /api/admin/stats (docs/validation-plan.md). A file of its own: one fresh
 * dynalite, so the numbers are exact.
 */
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { newId, type AdminStats, type Challenge, type PilotStats, type SessionResponse, type Stamp } from "@thirty/shared";
import { toChallengeItem } from "../src/db/challenges";
import { computePilotStats, pilotStats, toPilotChallenge, type PilotChallenge } from "../src/db/pilot";
import { ADMIN_TOKEN, json, setupApi } from "./helpers";

const api = setupApi();

/** 12:00 in Tokyo on 2026-10-10. */
const NOW = "2026-10-10T03:00:00.000Z";
const TODAY = "2026-10-10";

const pc = (userId: string, startDate: string, stampDays: number[] = [], status = "active"): PilotChallenge => ({
  userId,
  startDate,
  status,
  stampDays,
});

describe("pilotStats (pure)", () => {
  it("counts started challenges, distinct starters, reflections and 7-day retention", () => {
    const stats = pilotStats(
      [
        pc("a", "2026-10-01", [1, 2, 3, 4, 5]), // day 10: eligible, retained
        pc("a", "2026-10-01", [1, 2, 3, 4, 8, 9, 10]), // eligible, only 4 within days 1..7
        pc("b", "2026-10-03", [1, 2, 3, 4, 5, 6, 7], "done"), // day 8: eligible, retained, reflected
        pc("b", "2026-10-04", [1, 2, 3, 4, 5, 6, 7], "done"), // day 7: not eligible yet, reflected early
        pc("c", "2026-11-01"), // a reservation: not started
        pc("d", TODAY), // day 1
      ],
      TODAY,
    );
    expect(stats).toEqual<PilotStats>({ starters: 3, eligible7: 3, retained7: 2, started: 5, reflected: 2 });
  });

  it("is all zeros without challenges", () => {
    expect(pilotStats([], TODAY)).toEqual({ starters: 0, eligible7: 0, retained7: 0, started: 0, reflected: 0 });
  });

  it("reads challenge items only", () => {
    expect(toPilotChallenge({ pk: "USER#u1", sk: "CH#c1", startDate: "2026-10-01", status: "done", stamps: { "1": {}, "7": {}, x: {} } })).toEqual(
      pc("u1", "2026-10-01", [1, 7], "done"),
    );
    expect(toPilotChallenge({ pk: "USER#u1", sk: "CH#c2", startDate: "2026-10-01" })).toEqual(pc("u1", "2026-10-01"));
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
    expect((await stats()).pilot).toEqual({ starters: 0, eligible7: 0, retained7: 0, started: 0, reflected: 0 });

    const a = await api.createSession("A");
    const b = await api.createSession("B");
    const c = await api.createSession("C"); // only a reservation
    await api.createSession("D"); // no challenge at all
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
    expect(s.pilot).toEqual({ starters: 3, eligible7: 3, retained7: 2, started: 5, reflected: 2 });
    // Nothing private leaks into the response.
    expect(JSON.stringify(s)).not.toContain("ひみつ");

    // A deleted challenge drops out.
    const gone = await seed(a, challenge("2026-10-01", [1, 2, 3, 4, 5, 6]));
    expect((await stats()).pilot).toMatchObject({ started: 6, eligible7: 4, retained7: 3 });
    expect((await api.request(`/api/challenges/${gone.id}`, { method: "DELETE", token: a.token })).status).toBe(204);
    expect((await stats()).pilot).toEqual({ starters: 3, eligible7: 3, retained7: 2, started: 5, reflected: 2 });

    // Time moves on: the 10-04 challenge reaches day 8, the reservation starts.
    api.clock.set("2026-11-01T03:00:00.000Z");
    expect((await stats()).pilot).toEqual({ starters: 3, eligible7: 5, retained7: 3, started: 6, reflected: 2 });
  });

  it("paginates the scan and stops at the cap", async () => {
    api.clock.set(NOW);
    const full = await computePilotStats(api.deps);
    expect(await computePilotStats(api.deps, { pageSize: 2 })).toEqual(full);
    const capped = await computePilotStats(api.deps, { pageSize: 2, cap: 2 });
    expect(capped.started).toBeLessThanOrEqual(2);
    expect(full.started).toBeGreaterThan(2);
  });
});
