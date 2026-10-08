import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it } from "vitest";
import {
  QUOTAS,
  newId,
  type ApiError,
  type Challenge,
  type ChallengeCreate,
  type ChallengeListResponse,
  type ChallengeResponse,
  type CheerResponse,
  type CohortMember,
  type CohortResponse,
  type SessionResponse,
  type UpcomingResponse,
} from "@thirty/shared";
import { toChallengeItem } from "../src/db/challenges";
import { cheerKey } from "../src/db/keys";
import { COHORT_MESSAGES } from "../src/routes/cohorts";
import { json, setupApi } from "./helpers";

const api = setupApi();

/** 12:00 in Tokyo on 2026-10-06. */
const BASE = "2026-10-06T03:00:00.000Z";
const TODAY = "2026-10-06";
const DAY_MS = 86_400_000;

beforeEach(() => api.clock.set(BASE));

const getItem = async (pk: string, sk: string) =>
  (await api.deps.db.send(new GetCommand({ TableName: api.deps.tableName, Key: { pk, sk } }))).Item;

async function create(s: SessionResponse, overrides: Partial<ChallengeCreate> = {}): Promise<Challenge> {
  const body: ChallengeCreate = { id: newId(16), recipeId: "photo", title: "毎日1枚、写真を撮る", seal: "写", startDate: TODAY, ...overrides };
  const res = await api.request("/api/challenges", { token: s.token, body });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return (await json<ChallengeResponse>(res)).challenge;
}

const stamp = (s: SessionResponse, id: string, day: number, body?: unknown) =>
  api.request(`/api/challenges/${id}/stamps/${day}`, { method: "PUT", token: s.token, body });
const cheer = (s: SessionResponse | undefined, id: string) =>
  api.request(`/api/cheers/${id}`, { method: "POST", token: s?.token });
const setMe = (s: SessionResponse, body: unknown) => api.request("/api/me", { method: "PATCH", token: s.token, body });

async function cohort(month: string, viewer?: SessionResponse): Promise<{ raw: string; data: CohortResponse }> {
  const res = await api.request(`/api/cohorts/${month}`, { token: viewer?.token });
  expect(res.status).toBe(200);
  const raw = await res.text();
  return { raw, data: JSON.parse(raw) as CohortResponse };
}

async function memberOf(month: string, id: string, viewer?: SessionResponse): Promise<CohortMember | undefined> {
  return (await cohort(month, viewer)).data.members.find((m) => m.challengeId === id);
}

describe("CUF-3: cohort list and cheers (API level)", () => {
  it("shows A to B without notes or ids, counts one cheer per day, and hides A when A turns sharing off", async () => {
    const a = await api.createSession("Aさん");
    const b = await api.createSession("Bさん");
    const ch = await create(a);
    await stamp(a, ch.id, 2, { note: "ひみつのメモ" });
    await stamp(a, ch.id, 1);

    // 2. B sees A's nickname, seal and mini card.
    const { raw, data } = await cohort("2026-10", b);
    expect(data.month).toBe("2026-10");
    const m = data.members.find((x) => x.challengeId === ch.id);
    expect(m).toEqual({
      challengeId: ch.id,
      nickname: "Aさん",
      seal: "写",
      title: "毎日1枚、写真を撮る",
      recipeId: "photo",
      startDate: TODAY,
      stampDays: [1, 2],
      done: false,
      verdict: null,
      cheers: 0,
      cheeredToday: false,
      isMine: false,
      updatedAt: api.clock.now().getTime(),
    });
    expect(raw).not.toContain("note");
    expect(raw).not.toContain("ひみつのメモ");
    expect(raw).not.toContain(a.user.id);
    expect(raw).not.toContain(b.user.id);
    expect(raw).not.toContain("userId");
    expect(raw).not.toContain(a.token);

    // 3. B cheers: +1, and not again today.
    const res = await cheer(b, ch.id);
    expect(res.status).toBe(200);
    expect(await json<CheerResponse>(res)).toEqual({ cheers: 1, cheeredToday: true });
    const twice = await cheer(b, ch.id);
    expect(twice.status).toBe(409);
    expect((await json<ApiError>(twice)).error.message).toBe("今日はもう応援しました");
    expect(await memberOf("2026-10", ch.id, b)).toMatchObject({ cheers: 1, cheeredToday: true, isMine: false });
    expect(await memberOf("2026-10", ch.id, a)).toMatchObject({ cheers: 1, cheeredToday: false, isMine: true });
    const owned = await json<ChallengeListResponse>(await api.request("/api/challenges", { token: a.token }));
    expect(owned.challenges.find((c) => c.id === ch.id)?.cheers).toBe(1);

    // 4. A turns sharing off: gone from B's list, and cannot be cheered.
    expect((await setMe(a, { shareProgress: false })).status).toBe(200);
    expect(await memberOf("2026-10", ch.id, b)).toBeUndefined();
    expect((await cheer(b, ch.id)).status).toBe(404);
    // Stamping while private does not bring it back.
    await stamp(a, ch.id, 2);
    expect(await memberOf("2026-10", ch.id, b)).toBeUndefined();

    await setMe(a, { shareProgress: true });
    expect(await memberOf("2026-10", ch.id, b)).toMatchObject({ cheers: 1 });
  });

  it("lets the same person cheer again the next day (in the viewer's calendar)", async () => {
    const a = await api.createSession("毎日");
    const b = await api.createSession("応援団");
    const ch = await create(a);
    expect((await json<CheerResponse>(await cheer(b, ch.id))).cheers).toBe(1);
    api.clock.set("2026-10-06T14:59:00.000Z"); // 23:59 JST, same day
    expect((await cheer(b, ch.id)).status).toBe(409);
    api.clock.set("2026-10-06T15:00:00.000Z"); // 00:00 JST next day
    expect((await json<CheerResponse>(await cheer(b, ch.id))).cheers).toBe(2);
    expect(await memberOf("2026-10", ch.id, b)).toMatchObject({ cheers: 2, cheeredToday: true });
  });

  it("refuses cheering one's own challenge, unknown or hidden ones, and anonymous cheers", async () => {
    const a = await api.createSession("自分");
    const b = await api.createSession("だれか");
    const ch = await create(a);

    const own = await cheer(a, ch.id);
    expect(own.status).toBe(400);
    expect((await json<ApiError>(own)).error.message).toBe(COHORT_MESSAGES.cheerOwn);
    expect((await cheer(b, newId(16))).status).toBe(404);
    expect((await cheer(b, "BAD!")).status).toBe(400);
    expect((await cheer(undefined, ch.id)).status).toBe(401);

    // Hidden by moderation: out of the list, cannot be cheered, and the owner's activity keeps it out.
    await api.deps.db.send(
      new UpdateCommand({
        TableName: api.deps.tableName,
        Key: { pk: `USER#${a.user.id}`, sk: `CH#${ch.id}` },
        UpdateExpression: "SET hiddenFromCohort = :t REMOVE gsi1pk, gsi1sk",
        ExpressionAttributeValues: { ":t": true },
      }),
    );
    expect(await memberOf("2026-10", ch.id, b)).toBeUndefined();
    expect((await cheer(b, ch.id)).status).toBe(404);
    await stamp(a, ch.id, 1);
    await api.request(`/api/challenges/${ch.id}`, { method: "PATCH", token: a.token, body: { title: "まだ見えない" } });
    await setMe(a, { shareProgress: true, nickname: "自分2" });
    expect(await memberOf("2026-10", ch.id, b)).toBeUndefined();
    expect((await getItem(`CHEER#${ch.id}#${TODAY}`, `BY#${b.user.id}`))).toBeUndefined();
  });

  it("deletes cheer markers with the cheerer's account", async () => {
    const a = await api.createSession("残る人");
    const b = await api.createSession("消える人");
    const ch = await create(a);
    await cheer(b, ch.id);
    const marker = await getItem(`CHEER#${ch.id}#${TODAY}`, `BY#${b.user.id}`);
    expect(marker).toMatchObject({ gsi2pk: `AUTHOR#${b.user.id}` });
    expect(typeof marker?.ttl).toBe("number");

    expect((await api.request("/api/me", { method: "DELETE", token: b.token })).status).toBe(204);
    expect(JSON.stringify(await api.scanAll())).not.toContain(b.user.id);
    // A's challenge (and its cheer count) is untouched.
    expect(await memberOf("2026-10", ch.id)).toMatchObject({ cheers: 1 });
  });
});

describe("GET /api/cohorts/:month", () => {
  it("orders by latest activity, follows nickname changes, marks the viewer's own, and works anonymously", async () => {
    const a = await api.createSession("先に始めた");
    const c = await api.createSession("あとから");
    const first = await create(a);
    api.clock.advance(1000);
    const second = await create(c, { recipeId: "walk", title: "毎日20分歩く", seal: "歩" });
    api.clock.advance(1000);
    await stamp(a, first.id, 1);

    let ids = (await cohort("2026-10")).data.members.map((m) => m.challengeId);
    expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
    api.clock.advance(1000);
    await stamp(c, second.id, 1);
    ids = (await cohort("2026-10")).data.members.map((m) => m.challengeId);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));

    await setMe(a, { nickname: "改名した" });
    const anon = await memberOf("2026-10", first.id);
    expect(anon).toMatchObject({ nickname: "改名した", isMine: false, cheeredToday: false });
    expect(await memberOf("2026-10", first.id, a)).toMatchObject({ isMine: true });

    // A bad token is ignored on this public route.
    const res = await api.request("/api/cohorts/2026-10", { token: "x".repeat(43) });
    expect(res.status).toBe(200);
  });

  it("shows done challenges with their verdict, and keeps reservations in their own month", async () => {
    const a = await api.createSession("やりきった");
    const done = await create(a);
    const reserved = await create(a, { startDate: "2026-11-01" });
    api.clock.advance(6 * DAY_MS);
    await api.request(`/api/challenges/${done.id}/reflect`, { token: a.token, body: { verdict: "stop", reflection: "ひみつの振り返り" } });

    const { raw } = await cohort("2026-10");
    expect(raw).not.toContain("ひみつの振り返り");
    expect(await memberOf("2026-10", done.id)).toMatchObject({ done: true, verdict: "stop" });
    expect(await memberOf("2026-10", reserved.id)).toBeUndefined();
    expect(await memberOf("2026-11", reserved.id)).toMatchObject({ startDate: "2026-11-01", stampDays: [] });
  });

  it("rejects malformed months", async () => {
    for (const month of ["2026-13", "2026-1", "202610", "2026-00", "latest"]) {
      const res = await api.request(`/api/cohorts/${month}`);
      expect(res.status, month).toBe(400);
      expect((await json<ApiError>(res)).error.message).toBe(COHORT_MESSAGES.month);
    }
    expect((await cohort("2031-01")).data).toEqual({ month: "2031-01", members: [] });
  });

  it("marks cheeredToday across more than 100 members and enforces the daily cheer quota", async () => {
    api.clock.set("2027-06-10T03:00:00.000Z");
    const owner = await api.createSession("たくさん");
    const viewer = await api.createSession("見る人");
    const now = api.clock.now().getTime();
    const ids: string[] = [];
    for (let i = 0; i < 105; i++) {
      const id = newId(16);
      ids.push(id);
      const c: Challenge = {
        id,
        recipeId: null,
        title: `チャレンジ${i}`,
        seal: "試",
        startDate: "2027-06-01",
        status: "active",
        stamps: {},
        verdict: null,
        reflection: null,
        finishedAt: null,
        finishedDay: null,
        cheers: 0,
        shareId: null,
        createdAt: now + i,
        updatedAt: now + i,
      };
      await api.deps.db.send(new PutCommand({ TableName: api.deps.tableName, Item: toChallengeItem(owner.user.id, owner.user, c) }));
      await api.deps.db.send(new PutCommand({ TableName: api.deps.tableName, Item: { pk: `CHREF#${id}`, sk: "REF", userId: owner.user.id } }));
    }

    const statuses: number[] = [];
    for (let i = 0; i < ids.length; i += 15) {
      statuses.push(...(await Promise.all(ids.slice(i, i + 15).map(async (id) => (await cheer(viewer, id)).status))));
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(QUOTAS.cheersPerUserPerDay);
    expect(statuses.filter((s) => s === 429)).toHaveLength(ids.length - QUOTAS.cheersPerUserPerDay);
    const cheered = new Set(ids.filter((_, i) => statuses[i] === 200));
    expect(await getItem(cheerKey(ids[statuses.indexOf(429)]!, "2027-06-10", viewer.user.id).pk, `BY#${viewer.user.id}`)).toBeUndefined();

    const { data } = await cohort("2027-06", viewer);
    expect(data.members).toHaveLength(105);
    for (const m of data.members) expect(m.cheeredToday, m.title).toBe(cheered.has(m.challengeId));
    expect(data.members.filter((m) => m.cheers === 1)).toHaveLength(QUOTAS.cheersPerUserPerDay);
  });
});

describe("GET /api/cohorts/upcoming", () => {
  it("counts next 1st reservations by recipe, in the viewer's calendar", async () => {
    api.clock.set("2027-02-10T03:00:00.000Z");
    const users = await Promise.all(["u1", "u2", "u3", "u4", "u5", "u6"].map((n) => api.createSession(n)));
    const [u1, u2, u3, u4, u5, u6] = users as [SessionResponse, ...SessionResponse[]];
    await create(u1, { startDate: "2027-03-01" });
    await create(u2!, { startDate: "2027-03-01", title: "写真（自分流）" });
    await create(u3!, { startDate: "2027-03-01", recipeId: "walk", title: "毎日20分歩く", seal: "歩" });
    await create(u4!, { startDate: "2027-03-01", recipeId: null, title: "朝ヨガ", seal: "ヨ" });
    await create(u4!, { startDate: "2027-02-10" }); // started today: not a reservation
    await setMe(u5!, { shareProgress: false });
    await create(u5!, { startDate: "2027-03-01" }); // private: not counted
    await create(u6!, { startDate: "2027-03-01", recipeId: "walk", title: "散歩", seal: "散" });

    const res = await api.request("/api/cohorts/upcoming");
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(JSON.parse(raw) as UpcomingResponse).toEqual({
      startDate: "2027-03-01",
      count: 5,
      peopleCount: 5,
      byRecipe: [
        { recipeId: "photo", title: "毎日1枚、写真を撮る", seal: "写", count: 2 },
        { recipeId: "walk", title: "毎日20分歩く", seal: "歩", count: 2 },
        { recipeId: null, title: "朝ヨガ", seal: "ヨ", count: 1 },
      ],
    });
    for (const u of users) expect(raw).not.toContain(u.user.id);

    // Feb 28, 16:00 UTC: already March 1 in Tokyo, still Feb 28 in Los Angeles.
    api.clock.set("2027-02-28T16:00:00.000Z");
    const anon = await json<UpcomingResponse>(await api.request("/api/cohorts/upcoming"));
    expect(anon).toEqual({ startDate: "2027-04-01", count: 0, peopleCount: 0, byRecipe: [] });
    const la = await api.createSession("LA", "America/Los_Angeles");
    const forLa = await json<UpcomingResponse>(await api.request("/api/cohorts/upcoming", { token: la.token }));
    expect(forLa).toMatchObject({ startDate: "2027-03-01", count: 5 });
  });

  it("keeps the top 10 recipes", async () => {
    api.clock.set("2027-08-10T03:00:00.000Z");
    const recipes = ["photo", "walk", "diary", "nosugar", "early", "cook", "meditate", "english", "sketch", "tidy", "read", "nosns"];
    const s = await Promise.all(recipes.map((_, i) => api.createSession(`r${i}`)));
    await Promise.all(recipes.map((rid, i) => create(s[i]!, { startDate: "2027-09-01", recipeId: rid })));
    await create(s[0]!, { startDate: "2027-09-01", recipeId: "read" });
    const res = await json<UpcomingResponse>(await api.request("/api/cohorts/upcoming"));
    // 13 reservations, but r0 made two of them: 12 people (never shown as 13 人).
    expect(res.count).toBe(13);
    expect(res.peopleCount).toBe(12);
    expect(res.byRecipe).toHaveLength(10);
    expect(res.byRecipe[0]).toMatchObject({ recipeId: "read", title: "毎日10ページ読む", seal: "読", count: 2 });
  });
});

describe("day notes shown in the list (#17)", () => {
  it("counts the notes a member shows (shownNoteCount, sent only when > 0) and never puts note text in the list", async () => {
    const a = await api.createSession("見せる人");
    const b = await api.createSession("見る人");
    const ch = await create(a, { startDate: "2026-10-01" });
    const notes = ["見せるメモ1", "見せるメモ2", "見せないメモ3"];
    for (const [i, note] of notes.entries()) expect((await stamp(a, ch.id, i + 1, { note })).status).toBe(200);
    const visibility = (day: number, body: unknown) =>
      api.request(`/api/challenges/${ch.id}/stamps/${day}/visibility`, { method: "PUT", token: a.token, body });
    expect(await memberOf("2026-10", ch.id, b)).not.toHaveProperty("shownNoteCount");

    expect((await visibility(1, { show: true, note: notes[0] })).status).toBe(200);
    expect((await visibility(2, { show: true, note: notes[1] })).status).toBe(200);
    for (const viewer of [undefined, b, a]) {
      const { raw } = await cohort("2026-10", viewer);
      for (const note of notes) expect(raw).not.toContain(note);
      expect(raw).not.toMatch(/"(note|notes|shownNote)"/);
      expect(await memberOf("2026-10", ch.id, viewer)).toMatchObject({ shownNoteCount: 2, stampDays: [1, 2, 3] });
    }

    expect((await visibility(1, { show: false })).status).toBe(200);
    expect(await memberOf("2026-10", ch.id, b)).toMatchObject({ shownNoteCount: 1 });
    // Rewriting a shown note makes it private: the count follows.
    expect((await stamp(a, ch.id, 2, { note: "書き換えた" })).status).toBe(200);
    expect(await memberOf("2026-10", ch.id, b)).not.toHaveProperty("shownNoteCount");
  });
});
