import { BatchWriteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIMITS,
  QUOTAS,
  newId,
  type ApiError,
  type Challenge,
  type ChallengeCreate,
  type ChallengeListResponse,
  type ChallengeResponse,
  type SessionResponse,
} from "@thirty/shared";
import { claimChallengeId, toChallengeItem } from "../src/db/challenges";
import { getQuotaUsage } from "../src/db/rate";
import { getStats } from "../src/db/stats";
import { CHALLENGE_MESSAGES, CREATE_QUOTA_SCOPE } from "../src/routes/challenges";
import { json, setupApi } from "./helpers";

const api = setupApi();

/** 12:00 in Tokyo: "today" is 2026-10-06, the next 1st is 2026-11-01. */
const BASE = "2026-10-06T03:00:00.000Z";
const TODAY = "2026-10-06";
const NEXT_FIRST = "2026-11-01";
const DAY_MS = 86_400_000;

beforeEach(() => api.clock.set(BASE));

const getItem = async (pk: string, sk: string) =>
  (await api.deps.db.send(new GetCommand({ TableName: api.deps.tableName, Key: { pk, sk } }))).Item;

function createBody(overrides: Partial<ChallengeCreate> = {}): ChallengeCreate {
  return { id: newId(16), recipeId: "photo", title: "毎日1枚、写真を撮る", seal: "写", startDate: TODAY, ...overrides };
}

function postChallenge(s: SessionResponse, body: ChallengeCreate) {
  return api.request("/api/challenges", { token: s.token, body });
}

async function create(s: SessionResponse, overrides: Partial<ChallengeCreate> = {}): Promise<Challenge> {
  const res = await postChallenge(s, createBody(overrides));
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return (await json<ChallengeResponse>(res)).challenge;
}

const stamp = (s: SessionResponse, id: string, day: number | string, body?: unknown) =>
  api.request(`/api/challenges/${id}/stamps/${day}`, { method: "PUT", token: s.token, body });
const unstamp = (s: SessionResponse, id: string, day: number | string) =>
  api.request(`/api/challenges/${id}/stamps/${day}`, { method: "DELETE", token: s.token });
const reflect = (s: SessionResponse, id: string, body: unknown) =>
  api.request(`/api/challenges/${id}/reflect`, { token: s.token, body });
const patch = (s: SessionResponse, id: string, body: unknown) =>
  api.request(`/api/challenges/${id}`, { method: "PATCH", token: s.token, body });
const remove = (s: SessionResponse, id: string) => api.request(`/api/challenges/${id}`, { method: "DELETE", token: s.token });

const challengeOf = async (res: Response) => (await json<ChallengeResponse>(res)).challenge;
const errorOf = async (res: Response) => (await json<ApiError>(res)).error;

async function list(s: SessionResponse): Promise<ChallengeListResponse> {
  return json<ChallengeListResponse>(await api.request("/api/challenges", { token: s.token }));
}

describe("POST /api/challenges", () => {
  it("creates a challenge with its cohort projection, lists it, and replays idempotently", async () => {
    const s = await api.createSession("はじめ");
    const statsBefore = await getStats(api.deps);
    const startsBefore = Number((await getItem("RSTATS", "photo"))?.startCount ?? 0);
    const body = createBody();

    const res = await postChallenge(s, body);
    expect(res.status).toBe(201);
    const created = await challengeOf(res);
    const now = api.clock.now().getTime();
    expect(created).toEqual({
      id: body.id,
      recipeId: "photo",
      title: "毎日1枚、写真を撮る",
      seal: "写",
      startDate: TODAY,
      status: "active",
      stamps: {},
      verdict: null,
      reflection: null,
      finishedAt: null,
      finishedDay: null,
      cheers: 0,
      shareId: null,
      createdAt: now,
      updatedAt: now,
    });

    const item = await getItem(`USER#${s.user.id}`, `CH#${body.id}`);
    expect(item).toMatchObject({ userId: s.user.id, nickname: "はじめ", gsi1pk: "COHORT#2026-10" });
    expect(item?.gsi1sk).toBe(`${String(now).padStart(13, "0")}#${body.id}`);
    expect((await getItem(`CHREF#${body.id}`, "REF"))?.userId).toBe(s.user.id);

    // Replay (offline outbox): same answer, nothing counted twice.
    api.clock.advance(5_000);
    const replay = await postChallenge(s, { ...body, title: "別のタイトル" });
    expect(replay.status).toBe(200);
    expect(await challengeOf(replay)).toEqual(created);
    expect((await getStats(api.deps)).challengesStarted).toBe(statsBefore.challengesStarted + 1);
    expect((await getItem("RSTATS", "photo"))?.startCount).toBe(startsBefore + 1);

    // Newest first.
    const second = await create(s, { recipeId: "walk", title: "毎日20分歩く", seal: "歩" });
    const listed = await list(s);
    expect(listed.today).toBe(TODAY);
    expect(listed.challenges.map((c) => c.id)).toEqual([second.id, created.id]);
  });

  it("is 409 when the id already belongs to someone else", async () => {
    const a = await api.createSession("A");
    const b = await api.createSession("B");
    const mine = await create(a);
    const res = await postChallenge(b, createBody({ id: mine.id, title: "乗っ取り" }));
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("conflict");
    expect((await list(b)).challenges).toHaveLength(0);
    expect((await list(a)).challenges[0]?.title).toBe("毎日1枚、写真を撮る");
  });

  it("accepts the last 7 days (offline replays), today, tomorrow or the next 1st, in the user's time zone", async () => {
    const s = await api.createSession("日付");
    for (const startDate of ["2026-09-29", "2026-10-05", TODAY, "2026-10-07", NEXT_FIRST]) {
      const res = await postChallenge(s, createBody({ startDate }));
      expect(res.status, startDate).toBe(201);
      await remove(s, (await challengeOf(res)).id); // stay under the open limit
    }
    for (const startDate of ["2026-09-28", "2026-10-08", "2026-10-31", "2026-12-01", "2026-02-30"]) {
      const res = await postChallenge(s, createBody({ startDate }));
      expect(res.status, startDate).toBe(400);
    }
    const bad = await errorOf(await postChallenge(s, createBody({ startDate: "2026-10-20" })));
    expect(bad.message).toBe(CHALLENGE_MESSAGES.startDate);
    expect(bad.fields?.startDate).toBe(CHALLENGE_MESSAGES.startDate);

    // 03:00 UTC is still Oct 5 in Los Angeles.
    const la = await api.createSession("LA", "America/Los_Angeles");
    expect((await postChallenge(la, createBody({ startDate: "2026-10-07" }))).status).toBe(400);
    expect((await postChallenge(la, createBody({ startDate: "2026-09-28" }))).status).toBe(201);
    expect((await postChallenge(la, createBody({ startDate: "2026-09-27" }))).status).toBe(400);
  });

  it("keeps a create made offline and replayed days later, with the stamps queued behind it", async () => {
    const s = await api.createSession("オフライン");
    // Started 「今日から」 on 10-03 without a connection, stamped days 1 and 2, back online on 10-06.
    const body = createBody({ startDate: "2026-10-03" });
    const res = await postChallenge(s, body);
    expect(res.status).toBe(201);
    expect((await stamp(s, body.id, 1)).status).toBe(200);
    expect((await stamp(s, body.id, 2)).status).toBe(200);
    const [saved] = (await list(s)).challenges;
    expect(saved).toMatchObject({ id: body.id, startDate: "2026-10-03" });
    expect(Object.keys(saved!.stamps).sort()).toEqual(["1", "2"]);
  });

  /** Done challenges written straight to the table (as an account full of records would have). */
  async function putDone(s: SessionResponse, n: number, offset = 0): Promise<void> {
    const now = api.clock.now().getTime();
    const items = Array.from({ length: n }, (_, k): Challenge => {
      const i = offset + k;
      return {
        ...createBody({ title: `終わった${i}`, startDate: "2026-08-01" }),
        recipeId: "photo",
        status: "done",
        stamps: { "1": { at: now, note: "メモ" } },
        verdict: "stop",
        reflection: null,
        finishedAt: now,
        finishedDay: 30,
        cheers: 0,
        shareId: null,
        createdAt: now - i,
        updatedAt: now - i,
      };
    });
    for (let i = 0; i < items.length; i += 25) {
      await api.deps.db.send(
        new BatchWriteCommand({
          RequestItems: { [api.deps.tableName]: items.slice(i, i + 25).map((c) => ({ PutRequest: { Item: toChallengeItem(s.user.id, s.user, c) } })) },
        }),
      );
    }
  }

  it(`refuses a create once the account holds ${LIMITS.challengesPerUser} challenges in total (R15)`, async () => {
    const s = await api.createSession("ためこむ");
    await putDone(s, LIMITS.challengesPerUser - 1);
    expect((await postChallenge(s, createBody({ title: "200件め" }))).status).toBe(201);
    // The total is a limit like the open one (before: 201, and the account kept growing).
    const res = await postChallenge(s, createBody({ title: "201件め" }));
    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toBe(CHALLENGE_MESSAGES.totalLimit);
    expect(CHALLENGE_MESSAGES.totalLimit).toContain(String(LIMITS.challengesPerUser));
  });

  it(`never reads more than ${LIMITS.challengesPerUser} challenge items for the list or the export (R15)`, async () => {
    const s = await api.createSession("読みすぎない");
    // Even an account over the limit (written before it, or some other way) is read up to it only.
    await putDone(s, LIMITS.challengesPerUser + 5);
    const db = api.deps.db;
    const original = db.send.bind(db) as (cmd: unknown) => Promise<{ Count?: number }>;
    let read = 0;
    const send = vi.spyOn(db, "send").mockImplementation((async (cmd: unknown) => {
      const out = await original(cmd);
      if (cmd instanceof QueryCommand && cmd.input.ExpressionAttributeValues?.[":pk"] === `USER#${s.user.id}`) read += out.Count ?? 0;
      return out;
    }) as typeof db.send);
    try {
      expect((await list(s)).challenges).toHaveLength(LIMITS.challengesPerUser); // before: 205
      expect(read).toBeLessThanOrEqual(LIMITS.challengesPerUser);
      read = 0;
      const exported = await json<{ challenges: Challenge[] }>(await api.request("/api/me/export", { token: s.token }));
      expect(exported.challenges).toHaveLength(LIMITS.challengesPerUser);
      expect(read).toBeLessThanOrEqual(LIMITS.challengesPerUser);
    } finally {
      send.mockRestore();
    }
  });

  it("allows at most 5 open challenges; finished ones do not count", async () => {
    const s = await api.createSession("上限");
    const made: Challenge[] = [];
    for (let i = 0; i < 5; i++) made.push(await create(s, { title: `チャレンジ${i + 1}` }));

    const sixth = createBody({ title: "6つめ" });
    const res = await postChallenge(s, sixth);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toBe(CHALLENGE_MESSAGES.openLimit);
    expect((await getItem(`CHREF#${sixth.id}`, "REF"))).toBeUndefined();
    // A replay of an existing one is still fine at the limit.
    expect((await postChallenge(s, createBody({ id: made[0]!.id }))).status).toBe(200);

    // Reflect one on day 7 → a slot opens.
    api.clock.advance(6 * DAY_MS);
    expect((await reflect(s, made[0]!.id, { verdict: "continue" })).status).toBe(200);
    expect((await postChallenge(s, { ...sixth, startDate: "2026-10-12" })).status).toBe(201);
    expect((await postChallenge(s, createBody({ startDate: "2026-10-12" }))).status).toBe(409);

    // Deleting one opens a slot too.
    expect((await remove(s, made[1]!.id)).status).toBe(204);
    expect((await postChallenge(s, createBody({ startDate: "2026-10-12" }))).status).toBe(201);
  });

  it("keeps official and published community recipe ids, drops unknown or hidden ones", async () => {
    const s = await api.createSession("レシピ");
    const published = newId(16);
    const hidden = newId(16);
    const put = (rid: string, status: string) =>
      api.deps.db.send(new PutCommand({ TableName: api.deps.tableName, Item: { pk: `RECIPE#${rid}`, sk: "META", status, title: "x" } }));
    await put(published, "published");
    await put(hidden, "hidden");

    expect((await create(s, { recipeId: published })).recipeId).toBe(published);
    expect((await getItem("RSTATS", published))?.startCount).toBe(1);
    expect((await create(s, { recipeId: hidden })).recipeId).toBeNull();
    expect(await getItem("RSTATS", hidden)).toBeUndefined();
    expect((await create(s, { recipeId: "no-such-recipe" })).recipeId).toBeNull();
    expect((await create(s, { recipeId: null, title: "自分で決めた", seal: "自" })).recipeId).toBeNull();
  });

  it("projects into next month's cohort for a reservation, and not at all when progress is private", async () => {
    const s = await api.createSession("予約");
    const reserved = await create(s, { startDate: NEXT_FIRST });
    expect((await getItem(`USER#${s.user.id}`, `CH#${reserved.id}`))?.gsi1pk).toBe("COHORT#2026-11");

    await api.request("/api/me", { method: "PATCH", token: s.token, body: { shareProgress: false } });
    const quiet = await create(s);
    const item = await getItem(`USER#${s.user.id}`, `CH#${quiet.id}`);
    expect(item?.gsi1pk).toBeUndefined();
    expect(item?.gsi1sk).toBeUndefined();
  });

  it("validates the body and requires a session", async () => {
    const s = await api.createSession();
    const badSeal = await postChallenge(s, createBody({ seal: "ab" }));
    expect(badSeal.status).toBe(400);
    expect((await errorOf(badSeal)).fields?.seal).toBeDefined();
    expect((await postChallenge(s, createBody({ title: "見て https://spam.example.com" }))).status).toBe(400);
    expect((await postChallenge(s, createBody({ id: "BAD-ID" }))).status).toBe(400);
    expect((await api.request("/api/challenges", { body: createBody() })).status).toBe(401);
    expect((await api.request("/api/challenges")).status).toBe(401);
  });
});

describe(`creation quota (${QUOTAS.challengesPerUserPerDay} per JST day)`, () => {
  const quota = QUOTAS.challengesPerUserPerDay;
  const usage = (s: SessionResponse) => getQuotaUsage(api.deps, CREATE_QUOTA_SCOPE, s.user.id, quota, "day");

  /** Create `n` challenges, deleting each right away so the open limit (5) never gets in the way. */
  async function churn(s: SessionResponse, n: number): Promise<Challenge[]> {
    const out: Challenge[] = [];
    for (let i = 0; i < n; i++) {
      const c = await create(s);
      expect((await remove(s, c.id)).status).toBe(204);
      out.push(c);
    }
    return out;
  }

  it("counts real creates only, then answers 429 until the next JST day", async () => {
    const s = await api.createSession("たくさん");
    const startsBefore = Number((await getItem("RSTATS", "photo"))?.startCount ?? 0);
    await churn(s, quota - 1);
    const last = await create(s);
    expect((await usage(s)).count).toBe(quota);

    // Replays of an existing id are idempotent and free, even at the limit.
    const replay = await postChallenge(s, createBody({ id: last.id }));
    expect(replay.status).toBe(200);
    expect((await challengeOf(replay)).id).toBe(last.id);

    const limited = await postChallenge(s, createBody());
    expect(limited.status).toBe(429);
    expect((await errorOf(limited)).code).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await usage(s)).count).toBe(quota);
    // The ranking counter moved once per real create.
    expect((await getItem("RSTATS", "photo"))?.startCount).toBe(startsBefore + quota);

    // Per user.
    const other = await api.createSession("別の人");
    expect((await postChallenge(other, createBody())).status).toBe(201);

    // 2026-10-06T15:00Z is midnight in Tokyo: a new day. (Today is the 7th now.)
    api.clock.set("2026-10-06T15:00:00.000Z");
    expect((await postChallenge(s, createBody({ startDate: "2026-10-07" }))).status).toBe(201);
    expect((await usage(s)).count).toBe(1);
  });

  it("does not count requests that are refused or do not create", async () => {
    const s = await api.createSession("失敗");
    const owner = await api.createSession("持ち主");
    const taken = await create(owner);
    expect((await postChallenge(s, createBody({ id: taken.id }))).status).toBe(409); // someone else's id
    expect((await postChallenge(s, createBody({ startDate: "2026-12-01" }))).status).toBe(400); // bad start date
    expect((await postChallenge(s, createBody({ title: "" }))).status).toBe(400); // invalid body
    for (let i = 0; i < LIMITS.openChallenges; i++) await create(s);
    expect((await postChallenge(s, createBody())).status).toBe(409); // open limit
    expect((await usage(s)).count).toBe(LIMITS.openChallenges);
  });

  it("gives the use back when a concurrent replay of the same create wins the race", async () => {
    const s = await api.createSession("同時");
    const body = createBody();
    const [a, b] = await Promise.all([postChallenge(s, body), postChallenge(s, body)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect((await list(s)).challenges.map((c) => c.id)).toEqual([body.id]);
    expect((await usage(s)).count).toBe(1);
  });
});

describe("PATCH /api/challenges/:id", () => {
  it("edits title and seal and keeps the cohort projection current", async () => {
    const s = await api.createSession("編集");
    const c = await create(s);
    api.clock.advance(60_000);
    const res = await patch(s, c.id, { title: "  朝の写真  ", seal: "朝" });
    expect(res.status).toBe(200);
    const updated = await challengeOf(res);
    const now = api.clock.now().getTime();
    expect(updated).toMatchObject({ title: "朝の写真", seal: "朝", startDate: TODAY, updatedAt: now, createdAt: c.createdAt });
    const item = await getItem(`USER#${s.user.id}`, `CH#${c.id}`);
    expect(item?.gsi1sk).toBe(`${String(now).padStart(13, "0")}#${c.id}`);
    expect((await patch(s, c.id, {})).status).toBe(400);
    expect((await patch(s, c.id, { seal: "二文字" })).status).toBe(400);
  });

  it("moves the start date only while waiting, and only to today or the next 1st", async () => {
    const s = await api.createSession("移動");
    const c = await create(s, { startDate: NEXT_FIRST });

    const bad = await patch(s, c.id, { startDate: "2026-10-20" });
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).message).toBe(CHALLENGE_MESSAGES.startDate);

    // Unchanged start date is a no-op, even with other fields.
    expect((await patch(s, c.id, { startDate: NEXT_FIRST, title: "同じ日" })).status).toBe(200);

    const moved = await patch(s, c.id, { startDate: TODAY });
    expect(moved.status).toBe(200);
    expect((await challengeOf(moved)).startDate).toBe(TODAY);
    expect((await getItem(`USER#${s.user.id}`, `CH#${c.id}`))?.gsi1pk).toBe("COHORT#2026-10");

    // Started now: the date is fixed.
    const again = await patch(s, c.id, { startDate: NEXT_FIRST });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe(CHALLENGE_MESSAGES.started);
  });

  it("is locked after the reflection", async () => {
    const s = await api.createSession("確定");
    const c = await create(s);
    api.clock.advance(6 * DAY_MS);
    expect((await reflect(s, c.id, { verdict: "stop" })).status).toBe(200);
    const res = await patch(s, c.id, { title: "あとから" });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toBe(CHALLENGE_MESSAGES.done);
  });
});

describe("DELETE /api/challenges/:id", () => {
  it("removes the challenge and its reference", async () => {
    const s = await api.createSession("削除");
    const c = await create(s);
    expect((await remove(s, c.id)).status).toBe(204);
    expect(await getItem(`USER#${s.user.id}`, `CH#${c.id}`)).toBeUndefined();
    expect(await getItem(`CHREF#${c.id}`, "REF")).toBeUndefined();
    expect((await list(s)).challenges).toHaveLength(0);
    expect((await remove(s, c.id)).status).toBe(404);
  });

  it("recovers a half-finished create on replay, and account deletion removes an orphaned reference", async () => {
    const s = await api.createSession("途中");
    // A create that claimed the id but never wrote the challenge item.
    const id = newId(16);
    expect(await claimChallengeId(api.deps, id, s.user.id)).toBe(true);
    expect((await postChallenge(s, createBody({ id }))).status).toBe(201);
    const orphan = newId(16);
    expect(await claimChallengeId(api.deps, orphan, s.user.id)).toBe(true);

    expect((await api.request("/api/me", { method: "DELETE", token: s.token })).status).toBe(204);
    const dump = JSON.stringify(await api.scanAll());
    expect(dump).not.toContain(s.user.id);
    expect(dump).not.toContain(id);
    expect(dump).not.toContain(orphan);
  });
});

describe("ownership", () => {
  it("answers 404 for someone else's challenge on every route and changes nothing", async () => {
    const owner = await api.createSession("持ち主");
    const other = await api.createSession("他人");
    const c = await create(owner);
    await stamp(owner, c.id, 1, { note: "本人のメモ" });
    api.clock.advance(6 * DAY_MS);

    const responses = [
      await patch(other, c.id, { title: "書き換え" }),
      await remove(other, c.id),
      await stamp(other, c.id, 2),
      await unstamp(other, c.id, 1),
      await reflect(other, c.id, { verdict: "stop" }),
    ];
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).not.toContain("本人のメモ");
    }
    const [mine] = (await list(owner)).challenges;
    expect(mine).toMatchObject({ id: c.id, title: "毎日1枚、写真を撮る", status: "active" });
    expect(Object.keys(mine!.stamps)).toEqual(["1"]);
    expect(await getItem(`CHREF#${c.id}`, "REF")).toBeDefined();

    expect((await patch(other, "nosuchchallenge1", { title: "x" })).status).toBe(404);
    expect((await patch(other, "BAD!", { title: "x" })).status).toBe(400);
  });
});

describe("stamps", () => {
  it("allows days 1..today+1, keeps the first stamp time, and edits or clears the note", async () => {
    const s = await api.createSession("印");
    const c = await create(s);
    const t0 = api.clock.now().getTime();

    const first = await stamp(s, c.id, 1, { note: "  初日  " });
    expect(first.status).toBe(200);
    expect((await challengeOf(first)).stamps).toEqual({ "1": { at: t0, note: "初日" } });
    expect((await stamp(s, c.id, 2)).status).toBe(200); // +1 day of slack
    const future = await stamp(s, c.id, 3);
    expect(future.status).toBe(400);
    expect((await errorOf(future)).message).toBe(CHALLENGE_MESSAGES.futureDay);
    for (const day of [0, 31, "x", "1.5"]) expect((await stamp(s, c.id, day)).status, String(day)).toBe(400);
    expect((await stamp(s, c.id, 1, { note: "あ".repeat(121) })).status).toBe(400);

    // Ten days later: missed days can be filled in, the future still cannot.
    api.clock.advance(10 * DAY_MS);
    const t1 = api.clock.now().getTime();
    expect((await stamp(s, c.id, 5)).status).toBe(200);
    expect((await stamp(s, c.id, 12)).status).toBe(200);
    expect((await stamp(s, c.id, 13)).status).toBe(400);

    // Idempotent re-put without a body keeps `at` and the note.
    let res = await stamp(s, c.id, 1);
    expect((await challengeOf(res)).stamps["1"]).toEqual({ at: t0, note: "初日" });
    res = await stamp(s, c.id, 1, { note: "書き直し" });
    expect((await challengeOf(res)).stamps["1"]).toEqual({ at: t0, note: "書き直し" });
    res = await stamp(s, c.id, 1, { note: "" });
    const updated = await challengeOf(res);
    expect(updated.stamps["1"]).toEqual({ at: t0 });
    expect(updated.stamps["5"]).toEqual({ at: t1 });
    expect(updated.updatedAt).toBe(t1);
    expect((await getItem(`USER#${s.user.id}`, `CH#${c.id}`))?.gsi1sk).toBe(`${String(t1).padStart(13, "0")}#${c.id}`);

    // Remove, twice (idempotent).
    res = await unstamp(s, c.id, 2);
    expect(res.status).toBe(200);
    expect(Object.keys((await challengeOf(res)).stamps).sort()).toEqual(["1", "12", "5"]);
    res = await unstamp(s, c.id, 2);
    expect(res.status).toBe(200);
    expect(Object.keys((await challengeOf(res)).stamps).sort()).toEqual(["1", "12", "5"]);
  });

  it("refuses a note that is one 'character' of combining marks: the stored size is capped in UTF-8 bytes (NF-1)", async () => {
    const s = await api.createSession();
    const c = await create(s);
    // 'a' + 495 × U+20DD: 1 grapheme, 496 UTF-16 units (the old cap), ~1.5 KB of UTF-8.
    const fat = "a" + String.fromCodePoint(0x20dd).repeat(LIMITS.note * 4 + 15);
    const res = await stamp(s, c.id, 1, { note: fat });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).fields?.note).toBe("ひとことが長すぎます（絵文字などが多いため、あと1文字減らしてください）");
    expect((await stamp(s, c.id, 1, { note: "あ".repeat(LIMITS.note) })).status).toBe(200);
  });

  it("accepts day 1 the day before the start (slack) but not for a reservation further away", async () => {
    const s = await api.createSession("予約の印");
    const tomorrow = await create(s, { startDate: "2026-10-07" });
    expect((await stamp(s, tomorrow.id, 1)).status).toBe(200);
    expect((await stamp(s, tomorrow.id, 2)).status).toBe(400);
    const reserved = await create(s, { startDate: NEXT_FIRST });
    expect((await stamp(s, reserved.id, 1)).status).toBe(400);
  });

  it("caps at day 30 after the end and is locked once reflected", async () => {
    const s = await api.createSession("終わり");
    const c = await create(s);
    api.clock.advance(40 * DAY_MS);
    expect((await stamp(s, c.id, 30)).status).toBe(200);
    expect((await reflect(s, c.id, { verdict: "modify" })).status).toBe(200);
    const put = await stamp(s, c.id, 29);
    expect(put.status).toBe(409);
    expect((await errorOf(put)).message).toBe(CHALLENGE_MESSAGES.done);
    expect((await unstamp(s, c.id, 30)).status).toBe(409);
    expect(Object.keys((await list(s)).challenges[0]!.stamps)).toEqual(["30"]);
  });
});

describe("POST /api/challenges/:id/reflect", () => {
  it("opens on day 7, closes the record once, and counts stats once", async () => {
    const s = await api.createSession("振り返り");
    const c = await create(s);
    await stamp(s, c.id, 1);

    api.clock.advance(5 * DAY_MS); // day 6
    const early = await reflect(s, c.id, { verdict: "continue" });
    expect(early.status).toBe(400);
    expect((await errorOf(early)).message).toBe(CHALLENGE_MESSAGES.tooEarly);

    api.clock.advance(DAY_MS); // day 7
    const before = await getStats(api.deps);
    const res = await reflect(s, c.id, { verdict: "continue", reflection: "  思ったより\n続いた  " });
    expect(res.status).toBe(200);
    const now = api.clock.now().getTime();
    const done = await challengeOf(res);
    expect(done).toMatchObject({
      status: "done",
      verdict: "continue",
      reflection: "思ったより\n続いた",
      finishedAt: now,
      finishedDay: 7,
      stamps: { "1": { at: c.createdAt } },
    });
    let stats = await getStats(api.deps);
    expect(stats.challengesDone).toBe(before.challengesDone + 1);
    expect(stats.verdict_continue).toBe(before.verdict_continue + 1);

    // Changing one's mind later updates verdict / reflection only, and moves the verdict counters.
    api.clock.advance(DAY_MS);
    let again = await challengeOf(await reflect(s, c.id, { verdict: "modify" }));
    expect(again).toMatchObject({ verdict: "modify", reflection: "思ったより\n続いた", finishedAt: now, finishedDay: 7 });
    again = await challengeOf(await reflect(s, c.id, { verdict: "modify", reflection: "" }));
    expect(again.reflection).toBeNull();
    stats = await getStats(api.deps);
    expect(stats.challengesDone).toBe(before.challengesDone + 1);
    expect(stats.verdict_continue).toBe(before.verdict_continue);
    expect(stats.verdict_modify).toBe(before.verdict_modify + 1);
  });

  it("moves the verdict counters on a change of mind only for a challenge whose verdict was counted (NF-3)", async () => {
    const s = await api.createSession("読み込んだ人");
    // A done challenge from a backup: its verdict never went into STATS.
    const imported: Challenge = {
      id: newId(16),
      recipeId: null,
      title: "読み込んだ記録",
      seal: "読",
      startDate: "2026-09-01",
      status: "done",
      stamps: {},
      verdict: "continue",
      reflection: null,
      finishedAt: 1,
      finishedDay: 30,
      cheers: 0,
      shareId: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const file = { format: "thirty-days-backup", version: 1, exportedAt: 1, user: { nickname: "x", shareProgress: true, reminder: { enabled: false, time: "21:00" } }, challenges: [imported] };
    expect((await api.request("/api/me/import", { token: s.token, body: file })).status).toBe(200);
    expect(await getItem(`USER#${s.user.id}`, `CH#${imported.id}`)).toMatchObject({ imported: true });
    expect((await getItem(`USER#${s.user.id}`, `CH#${imported.id}`))?.counted).toBeUndefined();

    const before = await getStats(api.deps);
    for (const verdict of ["stop", "modify", "stop", "continue", "stop"]) {
      expect((await reflect(s, imported.id, { verdict })).status).toBe(200);
    }
    const after = await getStats(api.deps);
    expect([after.verdict_continue, after.verdict_stop, after.verdict_modify]).toEqual([
      before.verdict_continue,
      before.verdict_stop,
      before.verdict_modify,
    ]);

    // A live reflection records `counted` in the same write, and its changes do move the counters.
    const live = await create(s);
    api.clock.advance(7 * DAY_MS);
    expect((await reflect(s, live.id, { verdict: "continue" })).status).toBe(200);
    expect((await getItem(`USER#${s.user.id}`, `CH#${live.id}`))?.counted).toBe(true);
    expect((await reflect(s, live.id, { verdict: "stop" })).status).toBe(200);
    const moved = await getStats(api.deps);
    expect(moved.verdict_continue).toBe(after.verdict_continue);
    expect(moved.verdict_stop).toBe(after.verdict_stop + 1);
    expect(Math.min(moved.verdict_continue, moved.verdict_stop, moved.verdict_modify)).toBeGreaterThanOrEqual(0);
  });

  it("records day 30 for a challenge reflected after its end, and rejects reservations and bad input", async () => {
    const s = await api.createSession("あとで");
    const c = await create(s);
    const reserved = await create(s, { startDate: NEXT_FIRST });
    expect((await reflect(s, reserved.id, { verdict: "stop" })).status).toBe(400);
    api.clock.advance(45 * DAY_MS);
    expect((await reflect(s, c.id, { verdict: "maybe" })).status).toBe(400);
    expect((await reflect(s, c.id, { verdict: "stop", reflection: "あ".repeat(141) })).status).toBe(400);
    expect((await reflect(s, c.id, { verdict: "stop", reflection: "www.example.com を見て" })).status).toBe(400);
    const done = await challengeOf(await reflect(s, c.id, { verdict: "stop" }));
    expect(done).toMatchObject({ status: "done", verdict: "stop", reflection: null, finishedDay: 30 });
  });
});
