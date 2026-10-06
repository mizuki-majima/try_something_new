import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  newId,
  type ApiError,
  type BackupFile,
  type Challenge,
  type ImportResponse,
  type MeResponse,
  type SessionResponse,
} from "@thirty/shared";
import { getChallengeItem, listUserChallenges, toChallengeItem } from "../src/db/challenges";
import {
  pushKey,
  recipeAuthorGsi2,
  recipeKey,
  recipeListGsi1,
  recipeStatsKey,
  shareAuthorGsi2,
  shareKey,
  shareMediaKey,
  storyAuthorGsi2,
  storyKey,
} from "../src/db/keys";
import { getStats } from "../src/db/stats";
import type { Item } from "../src/db/util";
import { json, setupApi } from "./helpers";

const api = setupApi();

function challenge(overrides: Partial<Challenge> = {}): Challenge {
  const now = api.clock.now().getTime();
  return {
    id: newId(16),
    recipeId: "photo",
    title: "毎日1枚、写真を撮る",
    seal: "写",
    startDate: "2026-10-01",
    status: "active",
    stamps: { "1": { at: now, note: "初日" } },
    verdict: null,
    reflection: null,
    finishedAt: null,
    finishedDay: null,
    cheers: 0,
    shareId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function put(item: Item) {
  await api.deps.db.send(new PutCommand({ TableName: api.deps.tableName, Item: item }));
}

async function seedChallenge(s: SessionResponse, c: Challenge, extra: { hiddenFromCohort?: boolean } = {}) {
  await put(toChallengeItem(s.user.id, s.user, c, extra));
  await put({ pk: `CHREF#${c.id}`, sk: "REF", userId: s.user.id });
}

async function seedPush(uid: string, hash: string) {
  await put({ ...pushKey(uid, hash), type: "push", endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: { p256dh: "p".repeat(20), auth: "a".repeat(10) } });
}

const getItem = async (pk: string, sk: string) =>
  (await api.deps.db.send(new GetCommand({ TableName: api.deps.tableName, Key: { pk, sk } }))).Item;

describe("GET /api/me", () => {
  it("returns today's date in the user's time zone", async () => {
    api.clock.set("2026-10-06T16:30:00.000Z");
    const tokyo = await api.createSession("東京", "Asia/Tokyo");
    const la = await api.createSession("LA", "America/Los_Angeles");
    expect((await json<MeResponse>(await api.request("/api/me", { token: tokyo.token }))).today).toBe("2026-10-07");
    expect((await json<MeResponse>(await api.request("/api/me", { token: la.token }))).today).toBe("2026-10-06");
  });

  it("is 401 without a valid token", async () => {
    expect((await api.request("/api/me")).status).toBe(401);
    const res = await api.request("/api/me", { token: "x".repeat(43) });
    expect(res.status).toBe(401);
    expect((await json<ApiError>(res)).error.code).toBe("unauthorized");
  });
});

describe("PATCH /api/me", () => {
  it("rewrites the nickname on challenges and toggles the cohort projection", async () => {
    const s = await api.createSession("まえ");
    const visible = challenge();
    const hidden = challenge();
    await seedChallenge(s, visible);
    await seedChallenge(s, hidden, { hiddenFromCohort: true });
    expect((await getChallengeItem(api.deps, s.user.id, visible.id))?.gsi1pk).toBe("COHORT#2026-10");
    expect((await getChallengeItem(api.deps, s.user.id, hidden.id))?.gsi1pk).toBeUndefined();

    const res = await api.request("/api/me", { method: "PATCH", token: s.token, body: { nickname: "あと", shareProgress: false } });
    expect(res.status).toBe(200);
    expect((await json<MeResponse>(res)).user).toMatchObject({ nickname: "あと", shareProgress: false });
    const off = await getChallengeItem(api.deps, s.user.id, visible.id);
    expect(off?.nickname).toBe("あと");
    expect(off?.gsi1pk).toBeUndefined();
    expect(off?.gsi1sk).toBeUndefined();

    await api.request("/api/me", { method: "PATCH", token: s.token, body: { shareProgress: true } });
    const on = await getChallengeItem(api.deps, s.user.id, visible.id);
    expect(on?.gsi1pk).toBe("COHORT#2026-10");
    expect(on?.gsi1sk).toBe(`${String(visible.updatedAt).padStart(13, "0")}#${visible.id}`);
    // Moderation wins over shareProgress.
    expect((await getChallengeItem(api.deps, s.user.id, hidden.id))?.gsi1pk).toBeUndefined();
  });

  it("puts push subscriptions on the UTC reminder slot (floored to 15 minutes)", async () => {
    api.clock.set("2026-10-06T03:00:00.000Z");
    const s = await api.createSession("通知", "Asia/Tokyo");
    await seedPush(s.user.id, "h1");

    const res = await api.request("/api/me", { method: "PATCH", token: s.token, body: { reminder: { enabled: true, time: "21:07" } } });
    expect((await json<MeResponse>(res)).user.reminder).toEqual({ enabled: true, time: "21:00" });
    let item = await getItem(`USER#${s.user.id}`, "PUSH#h1");
    expect(item?.gsi3pk).toBe("SLOT#12:00");
    expect(item?.gsi3sk).toBe(`${s.user.id}#h1`);

    await api.request("/api/me", { method: "PATCH", token: s.token, body: { tz: "America/New_York" } });
    item = await getItem(`USER#${s.user.id}`, "PUSH#h1");
    expect(item?.gsi3pk).toBe("SLOT#01:00"); // 21:00 EDT (UTC-4)

    await api.request("/api/me", { method: "PATCH", token: s.token, body: { reminder: { enabled: false, time: "21:00" } } });
    item = await getItem(`USER#${s.user.id}`, "PUSH#h1");
    expect(item?.gsi3pk).toBeUndefined();
  });

  it("rejects an empty or invalid patch", async () => {
    const s = await api.createSession();
    expect((await api.request("/api/me", { method: "PATCH", token: s.token, body: {} })).status).toBe(400);
    const res = await api.request("/api/me", { method: "PATCH", token: s.token, body: { nickname: "あ".repeat(17) } });
    expect(res.status).toBe(400);
    expect((await json<ApiError>(res)).error.fields?.nickname).toContain("16文字");
  });
});

describe("DELETE /api/me", () => {
  it("removes everything the user owns or authored, and nothing else", async () => {
    const victim = await api.createSession("消える");
    const other = await api.createSession("残る");
    const uid = victim.user.id;
    const now = api.clock.now().getTime();

    // Challenges, a second device's token, a transfer code, a push subscription.
    const ch = challenge();
    await seedChallenge(victim, ch);
    const transfer = await api.request("/api/me/transfer-code", { method: "POST", token: victim.token });
    const { code } = await json<{ code: string }>(transfer);
    const device2 = await json<SessionResponse>(await api.request("/api/session/transfer", { body: { code } }));
    await api.request("/api/me/transfer-code", { method: "POST", token: victim.token });
    await seedPush(uid, "victimpush");

    // A recipe by the victim with a story by someone else, a story by the victim on another recipe, a share card.
    const rid = newId(16);
    await put({ ...recipeKey(rid), ...recipeListGsi1(now, rid), ...recipeAuthorGsi2(uid, rid), title: "消えるレシピ" });
    await put({ ...recipeStatsKey(rid), startCount: 2, storyCount: 1 });
    await put({ ...storyKey(rid, now, "s1"), ...storyAuthorGsi2(other.user.id, rid, "s1"), body: "他人の体験談" });
    const otherRid = newId(16);
    await put({ ...recipeKey(otherRid), ...recipeAuthorGsi2(other.user.id, otherRid), title: "残るレシピ" });
    await put({ ...recipeStatsKey(otherRid), storyCount: 2 });
    await put({ ...storyKey(otherRid, now, "s2"), ...storyAuthorGsi2(uid, otherRid, "s2"), body: "消える体験談" });
    await put({ ...storyKey(otherRid, now, "s3"), ...storyAuthorGsi2(other.user.id, otherRid, "s3"), body: "残る体験談" });
    const sid = newId(16);
    await put({ ...shareKey(sid), ...shareAuthorGsi2(uid, sid), challengeId: ch.id });
    await api.deps.media.put(shareMediaKey(sid), new Uint8Array([1, 2, 3]), "image/png");
    await seedChallenge(other, challenge());

    const usersBefore = (await getStats(api.deps)).users;
    const res = await api.request("/api/me", { method: "DELETE", token: victim.token });
    expect(res.status).toBe(204);

    expect((await api.request("/api/me", { token: victim.token })).status).toBe(401);
    expect((await api.request("/api/me", { token: device2.token })).status).toBe(401);

    const remaining = JSON.stringify(await api.scanAll());
    expect(remaining).not.toContain(uid);
    expect(remaining).not.toContain(ch.id);
    expect(remaining).not.toContain(rid);
    expect(remaining).not.toContain(sid);
    expect(remaining).not.toContain("TRANSFER#");
    expect(api.media.objects.has(shareMediaKey(sid))).toBe(false);

    // The other user's things survive; the story count of their recipe drops by one.
    expect(remaining).toContain("残るレシピ");
    expect(remaining).toContain("残る体験談");
    expect((await api.request("/api/me", { token: other.token })).status).toBe(200);
    expect(await listUserChallenges(api.deps, other.user.id)).toHaveLength(1);
    expect((await getItem("RSTATS", otherRid))?.storyCount).toBe(1);
    expect((await getStats(api.deps)).users).toBe(usersBefore - 1);
  });
});

describe("export / import", () => {
  it("exports the account as a BackupFile", async () => {
    const s = await api.createSession("書き出し");
    const c = challenge();
    await seedChallenge(s, c);
    const res = await api.request("/api/me/export", { token: s.token });
    expect(res.status).toBe(200);
    const file = await json<BackupFile>(res);
    expect(file).toMatchObject({ format: "thirty-days-backup", version: 1, user: { nickname: "書き出し", shareProgress: true } });
    expect(file.challenges).toEqual([c]);
  });

  it("merges: newer wins for own ids, foreign ids get a new id, unknown ids are kept, bad items are skipped", async () => {
    const me = await api.createSession("わたし");
    const someone = await api.createSession("だれか");
    const t = api.clock.now().getTime();

    const mine = challenge({ updatedAt: t - 1000, title: "古いタイトル" });
    const mineStale = challenge({ updatedAt: t, title: "サーバ側が新しい", cheers: 4 });
    await seedChallenge(me, mine);
    await seedChallenge(me, mineStale);
    const theirs = challenge({ title: "他人のもの" });
    await seedChallenge(someone, theirs);

    const fresh = challenge({ title: "新しく入る", status: "done", verdict: "continue", reflection: "よかった", finishedAt: t, finishedDay: 30 });
    const file: BackupFile = {
      format: "thirty-days-backup",
      version: 1,
      exportedAt: t,
      user: { nickname: "わたし", shareProgress: true, reminder: { enabled: false, time: "21:00" } },
      challenges: [
        { ...mine, title: "新しいタイトル", updatedAt: t },
        { ...mineStale, title: "古い版", updatedAt: t - 5000 },
        { ...theirs, title: "乗っ取り" },
        fresh,
        challenge({ title: "https://spam.example.com" }),
        challenge({ seal: "ab" }),
      ],
    };

    const res = await api.request("/api/me/import", { token: me.token, body: file });
    expect(res.status).toBe(200);
    expect(await json<ImportResponse>(res)).toEqual({ imported: 3, skipped: 3 });

    const list = await listUserChallenges(api.deps, me.user.id);
    const byTitle = new Map(list.map((c) => [c.title, c]));
    expect(byTitle.get("新しいタイトル")?.id).toBe(mine.id);
    expect(byTitle.get("サーバ側が新しい")?.cheers).toBe(4);
    expect(byTitle.has("古い版")).toBe(false);
    const copied = byTitle.get("乗っ取り");
    expect(copied?.id).toBeDefined();
    expect(copied?.id).not.toBe(theirs.id);
    expect(byTitle.get("新しく入る")).toMatchObject({ id: fresh.id, verdict: "continue", status: "done" });
    expect(list).toHaveLength(4);

    // The other user's challenge is untouched.
    expect((await listUserChallenges(api.deps, someone.user.id))[0]?.title).toBe("他人のもの");
  });

  it("clamps timestamps from the future", async () => {
    const s = await api.createSession();
    const future = api.clock.now().getTime() + 365 * 86_400_000;
    const c = challenge({ updatedAt: future, createdAt: future });
    const file: BackupFile = {
      format: "thirty-days-backup",
      version: 1,
      exportedAt: future,
      user: { nickname: "x", shareProgress: true, reminder: { enabled: false, time: "21:00" } },
      challenges: [c],
    };
    await api.request("/api/me/import", { token: s.token, body: file });
    const [saved] = await listUserChallenges(api.deps, s.user.id);
    expect(saved?.updatedAt).toBe(api.clock.now().getTime());
  });

  it("rejects a file that is not a backup", async () => {
    const s = await api.createSession();
    const res = await api.request("/api/me/import", { token: s.token, body: { format: "other" } });
    expect(res.status).toBe(400);
  });
});
