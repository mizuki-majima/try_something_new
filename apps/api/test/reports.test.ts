import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  AUTO_HIDE_MIN_NETWORKS,
  AUTO_HIDE_REPORTS,
  QUOTAS,
  newId,
  type ApiError,
  type Challenge,
  type Recipe,
  type RecipeDetailResponse,
  type RecipeListResponse,
  type SessionResponse,
  type Story,
} from "@thirty/shared";
import { getChallengeItem, toChallengeItem } from "../src/db/challenges";
import { shareAuthorGsi2, shareKey } from "../src/db/keys";
import { GSI1 } from "../src/db/table";
import { ADMIN_TOKEN, json, setupApi } from "./helpers";

const api = setupApi();

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

async function postRecipe(s: SessionResponse): Promise<Recipe> {
  const res = await api.request("/api/recipes", { token: s.token, body: recipeInput });
  if (res.status !== 201) throw new Error(`postRecipe: ${res.status} ${await res.text()}`);
  return (await json<{ recipe: Recipe }>(res)).recipe;
}

async function postStory(s: SessionResponse, rid: string): Promise<Story> {
  const res = await api.request(`/api/recipes/${rid}/stories`, { token: s.token, body: { body: "よかった" } });
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
    stamps: {},
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

async function put(item: Record<string, unknown>) {
  await api.deps.db.send(new PutCommand({ TableName: api.deps.tableName, Item: item }));
}

async function seedMember(s: SessionResponse, c: Challenge = challenge()): Promise<Challenge> {
  await put(toChallengeItem(s.user.id, s.user, c));
  await put({ pk: `CHREF#${c.id}`, sk: "REF", userId: s.user.id });
  return c;
}

async function seedShare(s: SessionResponse): Promise<string> {
  const sid = newId(16);
  await put({ ...shareKey(sid), ...shareAuthorGsi2(s.user.id, sid), id: sid, userId: s.user.id, title: "共有", nickname: "x", status: "published" });
  return sid;
}

const getItem = async (pk: string, sk: string) =>
  (await api.deps.db.send(new GetCommand({ TableName: api.deps.tableName, Key: { pk, sk } }))).Item;

const report = (s: SessionResponse, targetType: string, targetId: string, reason?: string, ip?: string) =>
  api.request("/api/reports", { token: s.token, ip, body: reason === undefined ? { targetType, targetId } : { targetType, targetId, reason } });

/** Reporters whose reports count towards auto-hide (accounts a day old that hold a challenge). */
async function reporters(n: number): Promise<SessionResponse[]> {
  const out: SessionResponse[] = [];
  for (let i = 0; i < n; i++) out.push(await api.trustedSession(`通報者${i}`));
  return out;
}

async function cohortIds(month: string): Promise<string[]> {
  const res = await api.deps.db.send(
    new QueryCommand({
      TableName: api.deps.tableName,
      IndexName: GSI1,
      KeyConditionExpression: "gsi1pk = :pk",
      ExpressionAttributeValues: { ":pk": `COHORT#${month}` },
    }),
  );
  return (res.Items ?? []).map((i) => String(i.id));
}

describe("POST /api/reports", () => {
  it("counts each reporter once and keeps the reason", async () => {
    const author = await api.createSession();
    const [a] = await reporters(1);
    const recipe = await postRecipe(author);
    api.clock.advance(1000);
    expect((await report(a!, "recipe", recipe.id, "宣伝です")).status).toBe(204);
    expect((await report(a!, "recipe", recipe.id, "もう一度")).status).toBe(204);
    const meta = await getItem(`REPORT#recipe#${recipe.id}`, "META");
    expect(meta).toMatchObject({
      count: 1,
      reasons: ["宣伝です"],
      targetType: "recipe",
      targetId: recipe.id,
      lastAt: api.clock.now().getTime(),
      gsi1pk: "REPORTS",
      gsi1sk: String(api.clock.now().getTime()).padStart(13, "0"),
    });
    const marker = await getItem(`REPORT#recipe#${recipe.id}`, `BY#${a!.user.id}`);
    expect(marker?.gsi2pk).toBe(`AUTHOR#${a!.user.id}`);
    // The recipe is still visible.
    expect((await api.request(`/api/recipes/${recipe.id}`)).status).toBe(200);
  });

  it(`hides a recipe after ${AUTO_HIDE_REPORTS} distinct reporters`, async () => {
    const author = await api.createSession();
    const recipe = await postRecipe(author);
    const rs = await reporters(AUTO_HIDE_REPORTS);
    for (const [i, r] of rs.entries()) {
      expect((await report(r, "recipe", recipe.id)).status).toBe(204);
      const visible = (await api.request(`/api/recipes/${recipe.id}`)).status === 200;
      expect(visible).toBe(i < AUTO_HIDE_REPORTS - 1);
    }
    const item = await getItem(`RECIPE#${recipe.id}`, "META");
    expect(item?.status).toBe("hidden");
    expect(item?.gsi1pk).toBeUndefined();
    const list = await json<RecipeListResponse>(await api.request("/api/recipes"));
    expect(list.recipes.some((r) => r.id === recipe.id)).toBe(false);
  });

  it("hides a story at the threshold and takes it out of storyCount", async () => {
    const author = await api.createSession();
    const story = await postStory(author, "walk");
    const countBefore = Number((await getItem("RSTATS", "walk"))?.storyCount);
    for (const r of await reporters(AUTO_HIDE_REPORTS)) expect((await report(r, "story", `walk:${story.id}`)).status).toBe(204);
    const body = await json<RecipeDetailResponse>(await api.request("/api/recipes/walk"));
    expect(body.stories.some((s) => s.id === story.id)).toBe(false);
    expect(Number((await getItem("RSTATS", "walk"))?.storyCount)).toBe(countBefore - 1);
  });

  it("hides a share card at the threshold", async () => {
    const owner = await api.createSession();
    const sid = await seedShare(owner);
    expect((await api.request(`/s/${sid}`)).status).toBe(200);
    for (const r of await reporters(AUTO_HIDE_REPORTS)) expect((await report(r, "share", sid)).status).toBe(204);
    expect((await getItem(`SHARE#${sid}`, "META"))?.status).toBe("hidden");
    expect((await api.request(`/s/${sid}`)).status).toBe(404);
  });

  it("takes a reported member out of the cohort query", async () => {
    const owner = await api.createSession("みんなの一人");
    const c = await seedMember(owner);
    expect(await cohortIds("2026-10")).toContain(c.id);
    for (const r of await reporters(AUTO_HIDE_REPORTS)) expect((await report(r, "member", c.id)).status).toBe(204);
    const item = await getChallengeItem(api.deps, owner.user.id, c.id);
    expect(item?.hiddenFromCohort).toBe(true);
    expect(item?.gsi1pk).toBeUndefined();
    expect(await cohortIds("2026-10")).not.toContain(c.id);
    // The owner's own record is intact.
    expect(item?.title).toBe(c.title);
  });

  it("counts only reporters whose account is a day old and holds a challenge towards auto-hide", async () => {
    const author = await api.createSession();
    const recipe = await postRecipe(author);
    const visible = async () => (await api.request(`/api/recipes/${recipe.id}`)).status === 200;

    // A troll's throwaway accounts: brand new and empty, brand new with a challenge, old but empty.
    const fresh = await api.createSession("捨て1");
    const freshWithChallenge = await api.createSession("捨て2");
    await seedMember(freshWithChallenge);
    const oldEmpty = await api.createSession("捨て3");
    await api.deps.db.send(
      new UpdateCommand({
        TableName: api.deps.tableName,
        Key: { pk: `USER#${oldEmpty.user.id}`, sk: "PROFILE" },
        UpdateExpression: "SET createdAt = :c",
        ExpressionAttributeValues: { ":c": api.clock.now().getTime() - 2 * 86_400_000 },
      }),
    );
    for (const r of [fresh, freshWithChallenge, oldEmpty]) expect((await report(r, "recipe", recipe.id, "荒らし")).status).toBe(204);

    // Recorded for the moderator, but nothing is hidden.
    expect(await visible()).toBe(true);
    const meta = await getItem(`REPORT#recipe#${recipe.id}`, "META");
    expect(meta).toMatchObject({ count: 3, trustedCount: 0, reasons: ["荒らし", "荒らし", "荒らし"] });
    expect(await getItem(`REPORT#recipe#${recipe.id}`, `BY#${fresh.user.id}`)).toBeDefined();

    // The same account a day later, once it holds a challenge, counts.
    const [a, b] = await reporters(2);
    expect((await report(a!, "recipe", recipe.id)).status).toBe(204);
    expect((await report(b!, "recipe", recipe.id)).status).toBe(204);
    expect(await visible()).toBe(true);
    const [c] = await reporters(1);
    expect((await report(c!, "recipe", recipe.id)).status).toBe(204);
    expect(await visible()).toBe(false);
    expect(await getItem(`REPORT#recipe#${recipe.id}`, "META")).toMatchObject({ count: 6, trustedCount: AUTO_HIDE_REPORTS });
  });

  it(`needs trusted reporters from at least ${AUTO_HIDE_MIN_NETWORKS} networks: one person's aged accounts on one connection hide nothing (security-4)`, async () => {
    const author = await api.createSession();
    const recipe = await postRecipe(author);
    const visible = async () => (await api.request(`/api/recipes/${recipe.id}`)).status === 200;
    // Three sleeper accounts, a day old and holding a challenge, all from one home (one IPv4 /24).
    const rs = await reporters(AUTO_HIDE_REPORTS);
    const ips = ["203.0.113.10", "203.0.113.11", "203.0.113.200"];
    for (const [i, r] of rs.entries()) expect((await report(r, "recipe", recipe.id, undefined, ips[i])).status).toBe(204);
    expect(await visible()).toBe(true); // before: hidden
    expect(await getItem(`REPORT#recipe#${recipe.id}`, "META")).toMatchObject({ trustedCount: AUTO_HIDE_REPORTS });
    const marker = await getItem(`REPORT#recipe#${recipe.id}`, `BY#${rs[0]!.user.id}`);
    expect(marker).toMatchObject({ trusted: true, net: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(JSON.stringify(marker)).not.toContain("203.0.113");
    // A trusted reporter from another network: now it is hidden.
    const [other] = await reporters(1);
    expect((await report(other!, "recipe", recipe.id, undefined, "198.51.100.5")).status).toBe(204);
    expect(await visible()).toBe(false);
  });

  it("counts an IPv6 /48 as one network, and an untrusted reporter's network is not stored", async () => {
    const owner = await api.createSession();
    const sid = await seedShare(owner);
    const rs = await reporters(AUTO_HIDE_REPORTS);
    // Three /56s (three separate clients for rate limits) of one /48, e.g. one tunnel broker allocation.
    for (const [i, r] of rs.entries()) expect((await report(r, "share", sid, undefined, `2001:db8:5:${(i + 1) * 256}::1`)).status).toBe(204);
    expect((await api.request(`/s/${sid}`)).status).toBe(200);
    const untrusted = await api.createSession();
    expect((await report(untrusted, "share", sid, undefined, "2001:db8:9::1")).status).toBe(204);
    expect(await getItem(`REPORT#share#${sid}`, `BY#${untrusted.user.id}`)).toMatchObject({ trusted: false });
    expect((await getItem(`REPORT#share#${sid}`, `BY#${untrusted.user.id}`))?.net).toBeUndefined();
    expect((await api.request(`/s/${sid}`)).status).toBe(200);
    const [other] = await reporters(1);
    expect((await report(other!, "share", sid, undefined, "2001:db8:6::1")).status).toBe(204);
    expect((await api.request(`/s/${sid}`)).status).toBe(404);
  });

  it("after a moderator's restore, only the reporters since then count, networks included", async () => {
    const author = await api.createSession();
    const recipe = await postRecipe(author);
    const visible = async () => (await api.request(`/api/recipes/${recipe.id}`)).status === 200;
    for (const r of await reporters(AUTO_HIDE_REPORTS)) expect((await report(r, "recipe", recipe.id)).status).toBe(204);
    expect(await visible()).toBe(false);
    api.clock.advance(1000);
    const restored = await api.request("/api/admin/moderate", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      body: { targetType: "recipe", targetId: recipe.id, action: "restore" },
    });
    expect(restored.status).toBe(204);
    expect(await visible()).toBe(true);
    api.clock.advance(1000);
    // Three new reporters from one network: the earlier reporters' networks do not make it diverse.
    for (const [i, r] of (await reporters(AUTO_HIDE_REPORTS)).entries()) {
      expect((await report(r, "recipe", recipe.id, undefined, `192.0.2.${i + 1}`)).status).toBe(204);
    }
    expect(await visible()).toBe(true);
  });

  it("keeps only the last 10 reasons", async () => {
    const author = await api.createSession();
    const recipe = await postRecipe(author);
    const rs = await reporters(12);
    for (const [i, r] of rs.entries()) await report(r, "recipe", recipe.id, `理由${i}`);
    const meta = await getItem(`REPORT#recipe#${recipe.id}`, "META");
    expect(meta?.count).toBe(12);
    expect(meta?.reasons).toEqual(Array.from({ length: 10 }, (_, i) => `理由${i + 2}`));
  });

  it("refuses own content (400) and unknown targets (404)", async () => {
    const me = await api.createSession();
    const recipe = await postRecipe(me);
    const story = await postStory(me, "photo");
    const sid = await seedShare(me);
    const c = await seedMember(me);
    for (const [type, id] of [
      ["recipe", recipe.id],
      ["story", `photo:${story.id}`],
      ["share", sid],
      ["member", c.id],
    ] as const) {
      const res = await report(me, type, id);
      expect(res.status).toBe(400);
      expect((await json<ApiError>(res)).error.message).toContain("通報できません");
    }
    const other = await api.createSession();
    expect((await report(other, "recipe", "photo")).status).toBe(404); // official recipes are not reportable
    expect((await report(other, "recipe", newId(16))).status).toBe(404);
    expect((await report(other, "story", "photo")).status).toBe(404);
    expect((await report(other, "story", `photo:${newId(16)}`)).status).toBe(404);
    expect((await report(other, "share", "../etc")).status).toBe(404);
    expect((await report(other, "member", newId(16))).status).toBe(404);
    expect((await api.request("/api/reports", { body: { targetType: "recipe", targetId: recipe.id } })).status).toBe(401);
    expect((await report(other, "user", recipe.id)).status).toBe(400);
  });

  it("allows reportsPerUserPerDay", async () => {
    const author = await api.createSession();
    const me = await api.createSession();
    const recipe = await postRecipe(author);
    for (let i = 0; i < QUOTAS.reportsPerUserPerDay; i++) expect((await report(me, "recipe", recipe.id)).status).toBe(204);
    expect((await report(me, "recipe", recipe.id)).status).toBe(429);
  });

  it("reporter markers go with the reporter's account", async () => {
    const author = await api.createSession();
    const reporter = await api.createSession();
    const recipe = await postRecipe(author);
    await report(reporter, "recipe", recipe.id, "気になる");
    expect((await api.request("/api/me", { method: "DELETE", token: reporter.token })).status).toBe(204);
    expect(await getItem(`REPORT#recipe#${recipe.id}`, `BY#${reporter.user.id}`)).toBeUndefined();
    expect(JSON.stringify(await api.scanAll())).not.toContain(reporter.user.id);
  });
});

describe("POST /api/contact", () => {
  it("stores the message for 180 days without linking the account", async () => {
    const s = await api.createSession();
    const res = await api.request("/api/contact", { token: s.token, body: { message: "  使いやすいです\r\nありがとう  ", replyTo: "@mizuki" } });
    expect(res.status).toBe(204);
    const items = (await api.scanAll()).filter((i) => String(i.pk).startsWith("CONTACT#"));
    const item = items.find((i) => i.message === "使いやすいです\nありがとう");
    const now = api.clock.now().getTime();
    expect(item).toMatchObject({ replyTo: "@mizuki", createdAt: now, gsi1pk: "CONTACTS", gsi1sk: String(now).padStart(13, "0") });
    expect(item?.ttl).toBe(Math.floor(now / 1000) + 180 * 86_400);
    expect(JSON.stringify(item)).not.toContain(s.user.id);
  });

  it("works without a session and validates", async () => {
    expect((await api.request("/api/contact", { body: { message: "匿名です" } })).status).toBe(204);
    const empty = await api.request("/api/contact", { body: { message: "   " } });
    expect(empty.status).toBe(400);
    expect((await json<ApiError>(empty)).error.fields?.message).toBeDefined();
    expect((await api.request("/api/contact", { body: { message: "あ".repeat(1001) } })).status).toBe(400);
  });

  it(`allows ${QUOTAS.contactPerUserPerDay} per day per user or IP`, async () => {
    const ip = "198.51.100.20";
    for (let i = 0; i < QUOTAS.contactPerUserPerDay; i++) expect((await api.request("/api/contact", { body: { message: `その${i}` }, ip })).status).toBe(204);
    expect((await api.request("/api/contact", { body: { message: "多すぎ" }, ip })).status).toBe(429);

    const s = await api.createSession();
    for (let i = 0; i < QUOTAS.contactPerUserPerDay; i++) expect((await api.request("/api/contact", { token: s.token, body: { message: `u${i}` } })).status).toBe(204);
    expect((await api.request("/api/contact", { token: s.token, body: { message: "多すぎ" } })).status).toBe(429);
  });
});
