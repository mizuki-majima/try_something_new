import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  OFFICIAL_RECIPES,
  QUOTAS,
  type ApiError,
  type Recipe,
  type RecipeDetailResponse,
  type RecipeInput,
  type RecipeListResponse,
  type SessionResponse,
  type Story,
} from "@thirty/shared";
import { recipeKey, recipeStatsKey } from "../src/db/keys";
import { getStats } from "../src/db/stats";
import { json, setupApi } from "./helpers";

const api = setupApi();

const input = (overrides: Partial<RecipeInput> = {}): RecipeInput => ({
  seal: "跳",
  title: "毎朝なわとび100回",
  category: "body",
  minutes: 5,
  place: "out",
  difficulty: 2,
  summary: "朝いちばんに、なわとびを100回だけ跳ぶ。",
  how: ["前の晩に玄関へ置いておく", "数えずに2分跳ぶでもOK"],
  after: "朝の目覚めが変わるかもしれません。",
  ...overrides,
});

const getItem = async (pk: string, sk: string) =>
  (await api.deps.db.send(new GetCommand({ TableName: api.deps.tableName, Key: { pk, sk } }))).Item;

async function postRecipe(s: SessionResponse, body: RecipeInput = input()): Promise<Recipe> {
  const res = await api.request("/api/recipes", { token: s.token, body });
  if (res.status !== 201) throw new Error(`postRecipe: ${res.status} ${await res.text()}`);
  return (await json<{ recipe: Recipe }>(res)).recipe;
}

async function postStory(s: SessionResponse, rid: string, body: Record<string, unknown> = { body: "続けてよかった" }): Promise<Story> {
  const res = await api.request(`/api/recipes/${rid}/stories`, { token: s.token, body });
  if (res.status !== 201) throw new Error(`postStory: ${res.status} ${await res.text()}`);
  return (await json<{ story: Story }>(res)).story;
}

const list = async (token?: string) => (await json<RecipeListResponse>(await api.request("/api/recipes", { token }))).recipes;
const detail = (rid: string, token?: string) => api.request(`/api/recipes/${rid}`, { token });

describe("GET /api/recipes", () => {
  it("lists the official recipes to anonymous visitors", async () => {
    const res = await api.request("/api/recipes");
    expect(res.status).toBe(200);
    const recipes = (await json<RecipeListResponse>(res)).recipes;
    const official = recipes.filter((r) => r.source === "official");
    expect(official).toHaveLength(OFFICIAL_RECIPES.length);
    expect(official[0]).toMatchObject({
      id: OFFICIAL_RECIPES[0]!.id,
      authorName: null,
      isMine: false,
      createdAt: null,
      startCount: 0,
      storyCount: 0,
      featured: false,
    });
  });

  it("merges community recipes (newest first) with RSTATS counters and isMine", async () => {
    const author = await api.createSession("作者");
    const other = await api.createSession("ほか");
    const older = await postRecipe(author, input({ title: "古いほう" }));
    api.clock.advance(1000);
    const newer = await postRecipe(author, input({ title: "新しいほう" }));
    // The challenges feature ADDs startCount; featured comes from the admin.
    await api.deps.db.send(
      new UpdateCommand({
        TableName: api.deps.tableName,
        Key: recipeStatsKey(newer.id),
        UpdateExpression: "ADD startCount :n SET featured = :t",
        ExpressionAttributeValues: { ":n": 4, ":t": true },
      }),
    );
    await api.deps.db.send(
      new UpdateCommand({
        TableName: api.deps.tableName,
        Key: recipeStatsKey("walk"),
        UpdateExpression: "ADD startCount :n",
        ExpressionAttributeValues: { ":n": 7 },
      }),
    );

    const mine = await list(author.token);
    const community = mine.filter((r) => r.source === "community");
    expect(community.findIndex((r) => r.id === newer.id)).toBeLessThan(community.findIndex((r) => r.id === older.id));
    expect(mine.find((r) => r.id === newer.id)).toMatchObject({ startCount: 4, featured: true, isMine: true, authorName: "作者" });
    expect(mine.find((r) => r.id === "walk")).toMatchObject({ startCount: 7, source: "official" });

    expect((await list(other.token)).find((r) => r.id === newer.id)?.isMine).toBe(false);
    expect((await list()).find((r) => r.id === newer.id)?.isMine).toBe(false);
    // No author ids in public responses.
    expect(JSON.stringify(await list())).not.toContain(author.user.id);
  });
});

describe("POST /api/recipes", () => {
  it("creates a published community recipe with gsi1/gsi2 and counts it", async () => {
    const s = await api.createSession("書き手");
    const before = (await getStats(api.deps)).communityRecipes;
    const res = await api.request("/api/recipes", { token: s.token, body: input() });
    expect(res.status).toBe(201);
    const { recipe } = await json<{ recipe: Recipe }>(res);
    expect(recipe).toMatchObject({
      source: "community",
      authorName: "書き手",
      isMine: true,
      title: "毎朝なわとび100回",
      startCount: 0,
      storyCount: 0,
      featured: false,
      createdAt: api.clock.now().getTime(),
    });
    expect(JSON.stringify(recipe)).not.toContain(s.user.id);

    const item = await getItem(`RECIPE#${recipe.id}`, "META");
    expect(item).toMatchObject({
      status: "published",
      gsi1pk: "RECIPES",
      gsi1sk: `${String(recipe.createdAt).padStart(13, "0")}#${recipe.id}`,
      gsi2pk: `AUTHOR#${s.user.id}`,
      gsi2sk: `RECIPE#${recipe.id}`,
    });
    expect((await getStats(api.deps)).communityRecipes).toBe(before + 1);
  });

  it("uses the given authorName", async () => {
    const s = await api.createSession("本名");
    const recipe = await postRecipe(s, input({ authorName: "ペンネーム" }));
    expect(recipe.authorName).toBe("ペンネーム");
  });

  it("requires a session and validates the input", async () => {
    expect((await api.request("/api/recipes", { body: input() })).status).toBe(401);
    const s = await api.createSession();
    const res = await api.request("/api/recipes", { token: s.token, body: input({ title: "詳しくは example.com で" }) });
    expect(res.status).toBe(400);
    expect((await json<ApiError>(res)).error.fields?.title).toContain("URL");
    const many = await api.request("/api/recipes", { token: s.token, body: input({ how: ["1", "2", "3", "4", "5", "6"] }) });
    expect(many.status).toBe(400);
  });

  it("allows recipesPerUserPerDay per JST day", async () => {
    api.clock.set("2026-10-06T03:00:00.000Z");
    const s = await api.createSession();
    for (let i = 0; i < QUOTAS.recipesPerUserPerDay; i++) await postRecipe(s, input({ title: `レシピ${i}` }));
    const res = await api.request("/api/recipes", { token: s.token, body: input() });
    expect(res.status).toBe(429);
    expect((await json<ApiError>(res)).error.code).toBe("rate_limited");
    api.clock.set("2026-10-06T15:00:00.000Z"); // 00:00 JST on the 7th
    expect((await api.request("/api/recipes", { token: s.token, body: input() })).status).toBe(201);
    api.clock.set("2026-10-06T03:00:00.000Z");
  });
});

describe("GET /api/recipes/:id", () => {
  it("serves official recipes with their stories", async () => {
    const s = await api.createSession("語り手");
    await postStory(s, "photo", { body: "30枚並べたら楽しかった", days: 28, verdict: "continue" });
    const res = await detail("photo");
    expect(res.status).toBe(200);
    const body = await json<RecipeDetailResponse>(res);
    expect(body.recipe).toMatchObject({ id: "photo", source: "official", authorName: null });
    expect(body.recipe.storyCount).toBeGreaterThanOrEqual(1);
    expect(body.stories[0]).toMatchObject({ recipeId: "photo", authorName: "語り手", days: 28, verdict: "continue", isMine: false });
  });

  it("is 404 for unknown, malformed and hidden recipes", async () => {
    expect((await detail("nosuchrecipe0000")).status).toBe(404);
    expect((await detail("Bad_ID!")).status).toBe(404);
    const s = await api.createSession();
    const recipe = await postRecipe(s);
    await api.deps.db.send(
      new UpdateCommand({
        TableName: api.deps.tableName,
        Key: recipeKey(recipe.id),
        UpdateExpression: "SET #s = :h REMOVE gsi1pk, gsi1sk",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":h": "hidden" },
      }),
    );
    expect((await detail(recipe.id, s.token)).status).toBe(404);
    expect((await list()).some((r) => r.id === recipe.id)).toBe(false);
  });

  it("lists published stories newest first, with isMine", async () => {
    const author = await api.createSession("作者");
    const a = await api.createSession("Aさん");
    const b = await api.createSession("Bさん");
    const recipe = await postRecipe(author);
    const first = await postStory(a, recipe.id, { body: "一つめ" });
    api.clock.advance(1000);
    const second = await postStory(b, recipe.id, { body: "二つめ", authorName: "びー" });
    api.clock.advance(1000);
    const hidden = await postStory(b, recipe.id, { body: "隠れる" });
    await api.deps.db.send(
      new PutCommand({
        TableName: api.deps.tableName,
        Item: { ...(await findStory(recipe.id, hidden.id)), status: "hidden" },
      }),
    );

    const body = await json<RecipeDetailResponse>(await detail(recipe.id, a.token));
    expect(body.recipe).toMatchObject({ id: recipe.id, source: "community", isMine: false, storyCount: 3 });
    expect(body.stories.map((s) => s.id)).toEqual([second.id, first.id]);
    expect(body.stories[0]).toMatchObject({ authorName: "びー", isMine: false, days: null, verdict: null });
    expect(body.stories[1]?.isMine).toBe(true);
    expect(JSON.stringify(body)).not.toContain(a.user.id);
    expect(JSON.stringify(body)).not.toContain(author.user.id);
  });
});

async function findStory(rid: string, sid: string) {
  const items = await api.scanAll();
  const item = items.find((i) => i.pk === `RECIPE#${rid}` && i.id === sid);
  if (!item) throw new Error("story not found");
  return item;
}

describe("stories", () => {
  it("POST counts the story, carries gsi2 and validates", async () => {
    const s = await api.createSession("ストーリー");
    const before = (await getStats(api.deps)).stories;
    const story = await postStory(s, "walk", { body: "雨の日もがんばった", days: 30, verdict: "modify" });
    expect(story).toMatchObject({ recipeId: "walk", authorName: "ストーリー", isMine: true, days: 30, verdict: "modify" });
    const item = await findStory("walk", story.id);
    expect(item.gsi2pk).toBe(`AUTHOR#${s.user.id}`);
    expect(item.gsi2sk).toBe(`STORY#walk#${story.id}`);
    expect((await getStats(api.deps)).stories).toBe(before + 1);

    const bad = await api.request("/api/recipes/walk/stories", { token: s.token, body: { body: "https://spam.example" } });
    expect(bad.status).toBe(400);
    expect((await api.request("/api/recipes/walk/stories", { body: { body: "x" } })).status).toBe(401);
  });

  it("POST is 404 for unknown and hidden recipes", async () => {
    const s = await api.createSession();
    expect((await api.request("/api/recipes/nosuchrecipe0000/stories", { token: s.token, body: { body: "a" } })).status).toBe(404);
    const recipe = await postRecipe(s);
    await api.deps.db.send(
      new UpdateCommand({
        TableName: api.deps.tableName,
        Key: recipeKey(recipe.id),
        UpdateExpression: "SET #s = :h",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":h": "hidden" },
      }),
    );
    expect((await api.request(`/api/recipes/${recipe.id}/stories`, { token: s.token, body: { body: "a" } })).status).toBe(404);
  });

  it("allows storiesPerUserPerDay", async () => {
    const s = await api.createSession();
    for (let i = 0; i < QUOTAS.storiesPerUserPerDay; i++) await postStory(s, "read", { body: `その${i}` });
    expect((await api.request("/api/recipes/read/stories", { token: s.token, body: { body: "多すぎ" } })).status).toBe(429);
  });

  it("DELETE is author-only and decrements storyCount", async () => {
    const author = await api.createSession();
    const other = await api.createSession();
    const story = await postStory(author, "tidy");
    const countBefore = Number((await getItem("RSTATS", "tidy"))?.storyCount);
    expect((await api.request(`/api/recipes/tidy/stories/${story.id}`, { method: "DELETE", token: other.token })).status).toBe(404);
    expect((await api.request(`/api/recipes/tidy/stories/${story.id}`, { method: "DELETE" })).status).toBe(401);
    expect((await api.request(`/api/recipes/tidy/stories/${story.id}`, { method: "DELETE", token: author.token })).status).toBe(204);
    expect(Number((await getItem("RSTATS", "tidy"))?.storyCount)).toBe(countBefore - 1);
    const body = await json<RecipeDetailResponse>(await detail("tidy"));
    expect(body.stories.some((s) => s.id === story.id)).toBe(false);
    expect((await api.request(`/api/recipes/tidy/stories/${story.id}`, { method: "DELETE", token: author.token })).status).toBe(404);
  });
});

describe("DELETE /api/recipes/:id", () => {
  it("is author-only and removes the recipe, its stories and counters", async () => {
    const author = await api.createSession();
    const other = await api.createSession();
    const recipe = await postRecipe(author);
    await postStory(other, recipe.id, { body: "他の人の体験談" });

    expect((await api.request(`/api/recipes/${recipe.id}`, { method: "DELETE", token: other.token })).status).toBe(404);
    expect((await api.request(`/api/recipes/photo`, { method: "DELETE", token: author.token })).status).toBe(404);
    expect((await api.request(`/api/recipes/${recipe.id}`, { method: "DELETE", token: author.token })).status).toBe(204);

    const remaining = (await api.scanAll()).filter((i) => i.pk === `RECIPE#${recipe.id}` || (i.pk === "RSTATS" && i.sk === recipe.id));
    expect(remaining).toEqual([]);
    expect((await detail(recipe.id)).status).toBe(404);
    expect((await list()).some((r) => r.id === recipe.id)).toBe(false);
  });

  it("recipes and stories go with the author's account (gsi2)", async () => {
    const author = await api.createSession();
    const recipe = await postRecipe(author);
    const story = await postStory(author, "diary");
    expect((await api.request("/api/me", { method: "DELETE", token: author.token })).status).toBe(204);
    const remaining = JSON.stringify(await api.scanAll());
    expect(remaining).not.toContain(recipe.id);
    expect(remaining).not.toContain(story.id);
  });
});
