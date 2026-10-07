import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  AUTO_HIDE_REPORTS,
  newId,
  type AdminContactsResponse,
  type AdminReportItem,
  type AdminReportsResponse,
  type AdminStats,
  type Challenge,
  type ChallengeListResponse,
  type CohortResponse,
  type Recipe,
  type RecipeDetailResponse,
  type RecipeListResponse,
  type SessionResponse,
  type Story,
} from "@thirty/shared";
import { createApp } from "../src/app";
import { getChallengeItem, toChallengeItem } from "../src/db/challenges";
import { contactKey, contactListGsi1, shareAuthorGsi2, shareKey, shareMediaKey, statsKey } from "../src/db/keys";
import { suggestionsStatKey } from "../src/routes/admin";
import { ADMIN_TOKEN, json, setupApi } from "./helpers";

const api = setupApi();
const adminHeaders = { "x-admin-token": ADMIN_TOKEN };

const recipeInput = {
  seal: "跳",
  title: "毎朝なわとび",
  category: "body",
  minutes: 5,
  place: "out",
  difficulty: 1,
  summary: "朝に100回跳ぶ。",
  how: [],
  after: "",
};

async function put(item: Record<string, unknown>) {
  await api.deps.db.send(new PutCommand({ TableName: api.deps.tableName, Item: item }));
}

const getItem = async (pk: string, sk: string) =>
  (await api.deps.db.send(new GetCommand({ TableName: api.deps.tableName, Key: { pk, sk } }))).Item;

async function postRecipe(s: SessionResponse, title = recipeInput.title): Promise<Recipe> {
  const res = await api.request("/api/recipes", { token: s.token, body: { ...recipeInput, title } });
  if (res.status !== 201) throw new Error(`postRecipe: ${res.status} ${await res.text()}`);
  return (await json<{ recipe: Recipe }>(res)).recipe;
}

async function postStory(s: SessionResponse, rid: string, body = "よかった"): Promise<Story> {
  const res = await api.request(`/api/recipes/${rid}/stories`, { token: s.token, body: { body } });
  if (res.status !== 201) throw new Error(`postStory: ${res.status} ${await res.text()}`);
  return (await json<{ story: Story }>(res)).story;
}

function challenge(overrides: Partial<Challenge> = {}): Challenge {
  const now = api.clock.now().getTime();
  return {
    id: newId(16),
    recipeId: null,
    title: "毎日スクワット",
    seal: "筋",
    startDate: "2026-10-01",
    status: "active",
    stamps: { "1": { at: now, note: "ひみつ" } },
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

async function seedMember(s: SessionResponse, c: Challenge = challenge()): Promise<Challenge> {
  await put(toChallengeItem(s.user.id, s.user, c));
  await put({ pk: `CHREF#${c.id}`, sk: "REF", userId: s.user.id });
  return c;
}

async function seedShare(s: SessionResponse, challengeId: string): Promise<string> {
  const sid = newId(16);
  await put({ ...shareKey(sid), ...shareAuthorGsi2(s.user.id, sid), id: sid, userId: s.user.id, challengeId, title: "共有カード", nickname: "ゆう", reflection: "楽しかった", status: "published" });
  await api.deps.media.put(shareMediaKey(sid), new Uint8Array([137, 80, 78, 71]), "image/png");
  await api.deps.db.send(
    new UpdateCommand({
      TableName: api.deps.tableName,
      Key: { pk: `USER#${s.user.id}`, sk: `CH#${challengeId}` },
      UpdateExpression: "SET shareId = :s",
      ExpressionAttributeValues: { ":s": sid },
    }),
  );
  return sid;
}

const moderate = (targetType: string, targetId: string, action: string) =>
  api.request("/api/admin/moderate", { headers: adminHeaders, body: { targetType, targetId, action } });

async function reportItems(): Promise<AdminReportItem[]> {
  const res = await api.request("/api/admin/reports", { headers: adminHeaders });
  expect(res.status).toBe(200);
  return (await json<AdminReportsResponse>(res)).items;
}

async function reportBy(n: number, targetType: string, targetId: string, reason?: string) {
  for (let i = 0; i < n; i++) {
    const s = await api.createSession();
    const res = await api.request("/api/reports", { token: s.token, body: { targetType, targetId, ...(reason ? { reason } : {}) } });
    expect(res.status).toBe(204);
  }
}

const recipeVisible = async (rid: string) => (await api.request(`/api/recipes/${rid}`)).status === 200;
const listed = async (rid: string) =>
  (await json<RecipeListResponse>(await api.request("/api/recipes"))).recipes.some((r) => r.id === rid);

describe("admin auth", () => {
  it("every admin route is 403 without the right token", async () => {
    const routes: [string, string, unknown?][] = [
      ["GET", "/api/admin/reports"],
      ["POST", "/api/admin/moderate", { targetType: "recipe", targetId: "photo", action: "hide" }],
      ["PATCH", "/api/admin/recipes/photo", { featured: true }],
      ["GET", "/api/admin/stats"],
      ["GET", "/api/admin/contacts"],
    ];
    const s = await api.createSession();
    for (const [method, path, body] of routes) {
      const variants: Record<string, string>[] = [{}, { "x-admin-token": "wrong" }, { "x-admin-token": "" }];
      for (const headers of variants) {
        const res = await api.request(path, { method, body, headers });
        expect(res.status, `${method} ${path}`).toBe(403);
        expect((await json<{ error: { code: string } }>(res)).error.code).toBe("forbidden");
      }
      // A user token is not an admin token.
      expect((await api.request(path, { method, body, token: s.token })).status).toBe(403);
    }
  });

  it("is 403 for everyone when no admin token is configured", async () => {
    const app = createApp({ ...api.deps, secrets: {} });
    expect((await api.request("/api/admin/stats", { headers: adminHeaders }, app)).status).toBe(403);
    expect((await api.request("/api/admin/stats", { headers: { "x-admin-token": "" } }, app)).status).toBe(403);
    expect((await api.request("/api/admin/stats", { headers: adminHeaders })).status).toBe(200);
  });
});

describe("GET /api/admin/reports", () => {
  it("lists reported targets newest first with status, reasons and a preview", async () => {
    const author = await api.createSession("作者");
    const recipe = await postRecipe(author, "宣伝っぽいレシピ");
    api.clock.advance(1000);
    await reportBy(1, "recipe", recipe.id, "宣伝です");
    const story = await postStory(author, "photo", "とても長い体験談。".repeat(20));
    api.clock.advance(1000);
    await reportBy(1, "story", `photo:${story.id}`);

    const items = await reportItems();
    const iStory = items.findIndex((i) => i.targetId === `photo:${story.id}`);
    const iRecipe = items.findIndex((i) => i.targetId === recipe.id);
    expect(iStory).toBeGreaterThanOrEqual(0);
    expect(iStory).toBeLessThan(iRecipe);
    expect(items[iRecipe]).toEqual({
      targetType: "recipe",
      targetId: recipe.id,
      count: 1,
      reasons: ["宣伝です"],
      lastAt: api.clock.now().getTime() - 1000,
      status: "published",
      preview: "宣伝っぽいレシピ：朝に100回跳ぶ。",
    });
    expect(items[iStory]?.preview.length).toBeLessThanOrEqual(61);
    expect(items[iStory]?.preview.endsWith("…")).toBe(true);
    expect(JSON.stringify(items)).not.toContain(author.user.id);
  });
});

describe("POST /api/admin/moderate", () => {
  it("recipe: hide → restore (back in the list, count reset) → delete", async () => {
    const author = await api.createSession();
    const recipe = await postRecipe(author);
    const story = await postStory(author, recipe.id);
    await reportBy(AUTO_HIDE_REPORTS, "recipe", recipe.id);
    expect(await recipeVisible(recipe.id)).toBe(false);
    expect((await reportItems()).find((i) => i.targetId === recipe.id)?.status).toBe("hidden");

    expect((await moderate("recipe", recipe.id, "restore")).status).toBe(204);
    expect(await recipeVisible(recipe.id)).toBe(true);
    expect(await listed(recipe.id)).toBe(true);
    expect((await getItem(`RECIPE#${recipe.id}`, "META"))?.gsi1sk).toBe(`${String(recipe.createdAt).padStart(13, "0")}#${recipe.id}`);
    expect((await reportItems()).find((i) => i.targetId === recipe.id)).toMatchObject({ status: "published", count: 0 });
    // One new report does not hide it again.
    await reportBy(1, "recipe", recipe.id);
    expect(await recipeVisible(recipe.id)).toBe(true);

    expect((await moderate("recipe", recipe.id, "hide")).status).toBe(204);
    expect(await recipeVisible(recipe.id)).toBe(false);
    expect(await listed(recipe.id)).toBe(false);

    expect((await moderate("recipe", recipe.id, "delete")).status).toBe(204);
    expect(await getItem(`RECIPE#${recipe.id}`, "META")).toBeUndefined();
    expect((await api.scanAll()).some((i) => i.pk === `RECIPE#${recipe.id}` && i.id === story.id)).toBe(false);
    expect((await reportItems()).find((i) => i.targetId === recipe.id)).toMatchObject({ status: "deleted", preview: "" });
    // Deleting again is fine; hiding something that is gone is 404.
    expect((await moderate("recipe", recipe.id, "delete")).status).toBe(204);
    expect((await moderate("recipe", recipe.id, "hide")).status).toBe(404);
  });

  it("story: hide / restore keep storyCount in step; delete removes it", async () => {
    const author = await api.createSession();
    const story = await postStory(author, "diary");
    const id = `diary:${story.id}`;
    const count = async () => Number((await getItem("RSTATS", "diary"))?.storyCount);
    const shown = async () => (await json<RecipeDetailResponse>(await api.request("/api/recipes/diary"))).stories.some((s) => s.id === story.id);
    const base = await count();

    expect((await moderate("story", id, "hide")).status).toBe(204);
    expect(await shown()).toBe(false);
    expect(await count()).toBe(base - 1);
    expect((await moderate("story", id, "hide")).status).toBe(204); // idempotent
    expect(await count()).toBe(base - 1);

    expect((await moderate("story", id, "restore")).status).toBe(204);
    expect(await shown()).toBe(true);
    expect(await count()).toBe(base);

    expect((await moderate("story", id, "delete")).status).toBe(204);
    expect(await shown()).toBe(false);
    expect(await count()).toBe(base - 1);
  });

  it("share: hide / restore / delete (image removed, challenge unlinked)", async () => {
    const owner = await api.createSession();
    const c = await seedMember(owner, challenge({ status: "done", verdict: "stop" }));
    const sid = await seedShare(owner, c.id);

    expect((await moderate("share", sid, "hide")).status).toBe(204);
    expect((await api.request(`/s/${sid}`)).status).toBe(404);
    expect((await moderate("share", sid, "restore")).status).toBe(204);
    expect((await api.request(`/s/${sid}`)).status).toBe(200);

    expect((await moderate("share", sid, "delete")).status).toBe(204);
    expect(await getItem(`SHARE#${sid}`, "META")).toBeUndefined();
    expect(api.media.objects.has(shareMediaKey(sid))).toBe(false);
    expect((await getChallengeItem(api.deps, owner.user.id, c.id))?.shareId).toBeUndefined();
  });

  it("member: hide / restore (only back in the cohort while the owner shares progress)", async () => {
    const owner = await api.createSession("メンバー");
    const c = await seedMember(owner);
    const item = () => getChallengeItem(api.deps, owner.user.id, c.id);

    expect((await moderate("member", c.id, "hide")).status).toBe(204);
    expect(await item()).toMatchObject({ hiddenFromCohort: true });
    expect((await item())?.gsi1pk).toBeUndefined();
    expect((await reportItems()).some((i) => i.targetId === c.id)).toBe(false); // never reported

    expect((await moderate("member", c.id, "restore")).status).toBe(204);
    expect((await item())?.hiddenFromCohort).toBeUndefined();
    expect((await item())?.gsi1pk).toBe("COHORT#2026-10");

    // Owner turns progress sharing off: restore lifts the flag but keeps it out of the cohort.
    await moderate("member", c.id, "hide");
    await api.request("/api/me", { method: "PATCH", token: owner.token, body: { shareProgress: false } });
    expect((await moderate("member", c.id, "restore")).status).toBe(204);
    expect((await item())?.hiddenFromCohort).toBeUndefined();
    expect((await item())?.gsi1pk).toBeUndefined();
  });

  it("member: delete removes it from the cohort for good but keeps the owner's private record", async () => {
    const owner = await api.createSession("メンバー");
    const c = await seedMember(owner, challenge({ stamps: { "1": { at: 1, note: "ひみつ" }, "2": { at: 2 } } }));
    const sid = await seedShare(owner, c.id);
    const item = () => getChallengeItem(api.deps, owner.user.id, c.id);
    const inCohort = async () =>
      (await json<CohortResponse>(await api.request("/api/cohorts/2026-10"))).members.some((m) => m.challengeId === c.id);
    await reportBy(1, "member", c.id, "不適切なタイトル");
    expect(await inCohort()).toBe(true);

    expect((await moderate("member", c.id, "delete")).status).toBe(204);
    // Out of the cohort, and its public card is hidden (not deleted).
    expect(await inCohort()).toBe(false);
    expect(await item()).toMatchObject({ hiddenFromCohort: true, shareId: sid });
    expect((await item())?.gsi1pk).toBeUndefined();
    expect((await getItem(`SHARE#${sid}`, "META"))?.status).toBe("hidden");
    expect(api.media.objects.has(shareMediaKey(sid))).toBe(true);
    expect((await api.request(`/s/${sid}`)).status).toBe(404);
    // The report is marked deleted (preview kept: the record still exists).
    const listedItem = (await reportItems()).find((i) => i.targetId === c.id);
    expect(listedItem).toMatchObject({ targetType: "member", status: "deleted", count: 1, reasons: ["不適切なタイトル"] });
    expect(listedItem?.preview).toContain(c.title);
    expect(typeof (await getItem(`REPORT#member#${c.id}`, "META"))?.deletedAt).toBe("number");

    // The owner's private data is untouched and still works.
    expect(await getItem(`CHREF#${c.id}`, "REF")).toMatchObject({ userId: owner.user.id });
    const mine = (await json<ChallengeListResponse>(await api.request("/api/challenges", { token: owner.token }))).challenges;
    expect(mine.find((x) => x.id === c.id)?.stamps).toEqual({ "1": { at: 1, note: "ひみつ" }, "2": { at: 2 } });
    const stamped = await api.request(`/api/challenges/${c.id}/stamps/3`, { method: "PUT", token: owner.token, body: {} });
    expect(stamped.status).toBe(200);
    // Activity (and the owner's settings) never put it back in the cohort.
    await api.request("/api/me", { method: "PATCH", token: owner.token, body: { nickname: "改名", shareProgress: true } });
    expect(await inCohort()).toBe(false);

    // Permanent: restore is refused, repeated deletes and hides are harmless.
    const restore = await moderate("member", c.id, "restore");
    expect(restore.status).toBe(409);
    expect((await item())?.hiddenFromCohort).toBe(true);
    expect((await moderate("member", c.id, "delete")).status).toBe(204);
    expect((await moderate("member", c.id, "hide")).status).toBe(204);
    expect(await inCohort()).toBe(false);
    expect((await reportItems()).find((i) => i.targetId === c.id)?.status).toBe("deleted");
  });

  it("member: deleting one that was never reported keeps it out of the list until someone reports it", async () => {
    const owner = await api.createSession("メンバー");
    const c = await seedMember(owner);
    expect((await moderate("member", c.id, "delete")).status).toBe(204);
    expect((await reportItems()).some((i) => i.targetId === c.id)).toBe(false);
    expect((await moderate("member", c.id, "restore")).status).toBe(409);
    await reportBy(1, "member", c.id);
    expect((await reportItems()).find((i) => i.targetId === c.id)).toMatchObject({ status: "deleted", count: 1 });
  });

  it("delete marks the report deleted for every type, and restore is refused afterwards", async () => {
    const owner = await api.createSession();
    const c = await seedMember(owner, challenge({ status: "done", verdict: "stop" }));
    const sid = await seedShare(owner, c.id);
    await reportBy(1, "share", sid);
    expect((await moderate("share", sid, "delete")).status).toBe(204);
    expect(typeof (await getItem(`REPORT#share#${sid}`, "META"))?.deletedAt).toBe("number");
    expect((await reportItems()).find((i) => i.targetId === sid)).toMatchObject({ status: "deleted", preview: "" });
    expect((await moderate("share", sid, "restore")).status).toBe(404); // gone for real
  });

  it("validates the input and 404s unknown targets", async () => {
    expect((await moderate("recipe", "photo", "hide")).status).toBe(404); // official recipes are not moderated
    expect((await moderate("member", newId(16), "restore")).status).toBe(404);
    expect((await moderate("recipe", newId(16), "explode")).status).toBe(400);
    expect((await moderate("user", newId(16), "hide")).status).toBe(400);
  });
});

describe("PATCH /api/admin/recipes/:id", () => {
  it("features official and community recipes", async () => {
    const author = await api.createSession();
    const recipe = await postRecipe(author);
    const patch = (id: string, body: unknown) => api.request(`/api/admin/recipes/${id}`, { method: "PATCH", headers: adminHeaders, body });

    expect((await patch("walk", { featured: true })).status).toBe(204);
    expect((await patch(recipe.id, { featured: true })).status).toBe(204);
    let recipes = (await json<RecipeListResponse>(await api.request("/api/recipes"))).recipes;
    expect(recipes.find((r) => r.id === "walk")?.featured).toBe(true);
    expect(recipes.find((r) => r.id === recipe.id)?.featured).toBe(true);
    expect(recipes.find((r) => r.id === "photo")?.featured).toBe(false);

    expect((await patch("walk", { featured: false })).status).toBe(204);
    recipes = (await json<RecipeListResponse>(await api.request("/api/recipes"))).recipes;
    expect(recipes.find((r) => r.id === "walk")?.featured).toBe(false);

    expect((await patch(newId(16), { featured: true })).status).toBe(404);
    expect((await patch("BAD!", { featured: true })).status).toBe(404);
    expect((await patch("walk", { featured: "yes" })).status).toBe(400);
  });
});

describe("GET /api/admin/stats", () => {
  it("returns AdminStats from STATS/GLOBAL", async () => {
    api.clock.set("2026-10-06T16:00:00.000Z"); // 01:00 JST on the 7th
    expect(suggestionsStatKey(api.clock.now())).toBe("suggestions_20261007");
    await api.deps.db.send(
      new UpdateCommand({
        TableName: api.deps.tableName,
        Key: statsKey(),
        UpdateExpression: "ADD verdict_continue :a, verdict_modify :b, challengesStarted :c, suggestions_20261007 :d, suggestions_20261006 :e",
        ExpressionAttributeValues: { ":a": 2, ":b": 1, ":c": 5, ":d": 4, ":e": 9 },
      }),
    );
    await api.request("/api/metrics/share", { body: { channel: "webshare" } });

    const res = await api.request("/api/admin/stats", { headers: adminHeaders });
    expect(res.status).toBe(200);
    const stats = await json<AdminStats>(res);
    expect(Object.keys(stats).sort()).toEqual(
      [
        "users",
        "challengesStarted",
        "challengesDone",
        "verdicts",
        "communityRecipes",
        "stories",
        "shares",
        "shareActions",
        "suggestionsToday",
        "pushSubscriptions",
        "pilot",
      ].sort(),
    );
    expect(Object.keys(stats.pilot).sort()).toEqual(["eligible7", "reflected", "retained7", "started", "starters"]);
    // The members seeded above (startDate 2026-10-01, day 7 on 10-07 JST) count as started.
    expect(stats.pilot.started).toBeGreaterThan(0);
    expect(stats.pilot.starters).toBeGreaterThan(0);
    expect(stats.pilot.reflected).toBeLessThanOrEqual(stats.pilot.started);
    expect(stats.pilot.retained7).toBeLessThanOrEqual(stats.pilot.eligible7);
    expect(stats.verdicts).toEqual({ continue: 2, stop: 0, modify: 1 });
    expect(stats.suggestionsToday).toBe(4);
    expect(stats.challengesStarted).toBeGreaterThanOrEqual(5);
    expect(stats.users).toBeGreaterThan(0);
    expect(stats.communityRecipes).toBeGreaterThan(0);
    expect(stats.shareActions).toMatchObject({ link: 0, image: 0, x: 0, line: 0, copy: 0 });
    expect(stats.shareActions.webshare).toBe(1);
    for (const v of [...Object.values(stats), ...Object.values(stats.pilot)]) {
      if (typeof v === "number") expect(Number.isFinite(v)).toBe(true);
    }
    api.clock.set("2026-10-06T03:00:00.000Z");
  });
});

describe("GET /api/admin/contacts", () => {
  it("lists contacts newest first and skips expired ones", async () => {
    api.clock.set("2026-10-06T03:00:00.000Z");
    expect((await api.request("/api/contact", { body: { message: "古いほう" } })).status).toBe(204);
    api.clock.advance(60_000);
    expect((await api.request("/api/contact", { body: { message: "新しいほう", replyTo: "@yu" } })).status).toBe(204);
    const old = api.clock.now().getTime() - 200 * 86_400_000;
    await put({ ...contactKey("expired000000000"), ...contactListGsi1(old), id: "expired000000000", message: "期限切れ", replyTo: null, createdAt: old, ttl: Math.floor(old / 1000) + 180 * 86_400 });

    const res = await api.request("/api/admin/contacts", { headers: adminHeaders });
    expect(res.status).toBe(200);
    const { items } = await json<AdminContactsResponse>(res);
    expect(items.map((i) => i.message).slice(0, 2)).toEqual(["新しいほう", "古いほう"]);
    expect(items[0]).toMatchObject({ replyTo: "@yu", createdAt: api.clock.now().getTime() });
    expect(items[1]?.replyTo).toBeNull();
    expect(items.some((i) => i.message === "期限切れ")).toBe(false);
  });
});
