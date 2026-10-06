/**
 * Community recipes (RECIPE#<rid> / META), their stories (RECIPE#<rid> / STORY#<createdAt13>#<sid>)
 * and the per-recipe counters (RSTATS / <rid>) shared with official recipes (SPEC Data Model).
 * Stories on official recipes live in RECIPE#<officialId> partitions without a META item.
 * Every authored item carries gsi2 AUTHOR#<uid> so DELETE /api/me (db/account.ts) finds it.
 */
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  OFFICIAL_RECIPES,
  newId,
  type OfficialRecipe,
  type Recipe,
  type RecipeInputSchema,
  type Story,
  type StoryInputSchema,
  type User,
} from "@thirty/shared";
import type { z } from "zod";
import type { DbDeps } from "../ports";
import {
  RECIPE_STATS_PK,
  recipeAuthorGsi2,
  recipeKey,
  recipeListGsi1,
  recipePk,
  recipeStatsKey,
  storyAuthorGsi2,
  storyKey,
} from "./keys";
import { GSI1 } from "./table";
import { batchDelete, isConditionFailed, keyOf, queryAll, queryPrefix, type Item } from "./util";

type D = Pick<DbDeps, "db" | "tableName">;

export type PublicStatus = "published" | "hidden";

/** Community recipes listed by GET /api/recipes (newest first). */
export const MAX_LISTED_RECIPES = 500;
/** Stories returned with a recipe (newest first). */
export const MAX_LISTED_STORIES = 50;

export type RecipeStats = { startCount: number; storyCount: number; featured: boolean };
const EMPTY_STATS: RecipeStats = { startCount: 0, storyCount: 0, featured: false };

function toStats(item: Item | undefined): RecipeStats {
  if (!item) return { ...EMPTY_STATS };
  return {
    startCount: Math.max(0, Number(item.startCount ?? 0) || 0),
    // Clamped: account deletion decrements without looking at the story's status.
    storyCount: Math.max(0, Number(item.storyCount ?? 0) || 0),
    featured: item.featured === true,
  };
}

const statusOf = (item: Item): PublicStatus => (item.status === "hidden" ? "hidden" : "published");

// ---------- counters (RSTATS) ----------

export async function listRecipeStats(deps: D): Promise<Map<string, RecipeStats>> {
  const items = await queryAll(deps, {
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": RECIPE_STATS_PK },
  });
  return new Map(items.map((i) => [String(i.sk), toStats(i)]));
}

export async function getRecipeStats(deps: D, rid: string): Promise<RecipeStats> {
  const res = await deps.db.send(new GetCommand({ TableName: deps.tableName, Key: recipeStatsKey(rid) }));
  return toStats(res.Item);
}

/** ADD storyCount (creates the row on first use). */
export async function addStoryCount(deps: D, rid: string, delta: number): Promise<void> {
  if (delta === 0) return;
  await deps.db.send(
    new UpdateCommand({
      TableName: deps.tableName,
      Key: recipeStatsKey(rid),
      UpdateExpression: "ADD storyCount :d",
      ExpressionAttributeValues: { ":d": delta },
    }),
  );
}

export async function setFeatured(deps: D, rid: string, featured: boolean): Promise<void> {
  await deps.db.send(
    new UpdateCommand({
      TableName: deps.tableName,
      Key: recipeStatsKey(rid),
      UpdateExpression: "SET featured = :f",
      ExpressionAttributeValues: { ":f": featured },
    }),
  );
}

// ---------- recipes ----------

export function officialToRecipe(r: OfficialRecipe, stats: RecipeStats): Recipe {
  return {
    ...r,
    how: [...r.how],
    source: "official",
    authorName: null,
    isMine: false,
    featured: stats.featured,
    startCount: stats.startCount,
    storyCount: stats.storyCount,
    createdAt: null,
  };
}

/** Community recipe item → public shape. The author's id is only compared, never returned. */
export function communityToRecipe(item: Item, stats: RecipeStats, viewerId: string | undefined): Recipe {
  return {
    id: String(item.id),
    seal: String(item.seal ?? ""),
    title: String(item.title ?? ""),
    category: item.category as Recipe["category"],
    minutes: Number(item.minutes ?? 0),
    place: item.place as Recipe["place"],
    difficulty: Number(item.difficulty ?? 1) as Recipe["difficulty"],
    summary: String(item.summary ?? ""),
    how: Array.isArray(item.how) ? item.how.map(String) : [],
    after: String(item.after ?? ""),
    source: "community",
    authorName: typeof item.authorName === "string" ? item.authorName : null,
    isMine: viewerId !== undefined && item.userId === viewerId,
    featured: stats.featured,
    startCount: stats.startCount,
    storyCount: stats.storyCount,
    createdAt: Number(item.createdAt ?? 0),
  };
}

export async function getRecipeItem(deps: D, rid: string): Promise<Item | undefined> {
  const res = await deps.db.send(new GetCommand({ TableName: deps.tableName, Key: recipeKey(rid) }));
  return res.Item;
}

export function isPublished(item: Item): boolean {
  return statusOf(item) === "published";
}

/** Published community recipes, newest first (gsi1 RECIPES only holds published ones). */
export async function listCommunityRecipeItems(deps: D, max = MAX_LISTED_RECIPES): Promise<Item[]> {
  const items: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await deps.db.send(
      new QueryCommand({
        TableName: deps.tableName,
        IndexName: GSI1,
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": "RECIPES" },
        ScanIndexForward: false,
        Limit: max - items.length,
        ExclusiveStartKey: start,
      }),
    );
    items.push(...((res.Items ?? []) as Item[]));
    start = res.LastEvaluatedKey;
  } while (start && items.length < max);
  return items.filter(isPublished).slice(0, max);
}

export type RecipeCreateInput = z.output<typeof RecipeInputSchema>;

export async function createRecipe(deps: DbDeps, user: User, input: RecipeCreateInput): Promise<Item> {
  const now = deps.now().getTime();
  const id = newId(16);
  const { authorName, ...fields } = input;
  const item: Item = {
    ...recipeKey(id),
    ...recipeListGsi1(now, id),
    ...recipeAuthorGsi2(user.id, id),
    type: "recipe",
    id,
    ...fields,
    authorName: authorName || user.nickname,
    userId: user.id,
    status: "published",
    createdAt: now,
    updatedAt: now,
  };
  await deps.db.send(new PutCommand({ TableName: deps.tableName, Item: item, ConditionExpression: "attribute_not_exists(pk)" }));
  return item;
}

/**
 * Show or hide a community recipe. Hidden recipes leave the gsi1 list; restoring puts them back
 * at their original position. Returns false when the recipe does not exist.
 */
export async function setRecipeStatus(deps: D, item: Item, status: PublicStatus): Promise<boolean> {
  const rid = String(item.id);
  const list = recipeListGsi1(Number(item.createdAt ?? 0), rid);
  try {
    await deps.db.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: recipeKey(rid),
        UpdateExpression: status === "hidden" ? "SET #s = :s REMOVE gsi1pk, gsi1sk" : "SET #s = :s, gsi1pk = :g1pk, gsi1sk = :g1sk",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: status === "hidden" ? { ":s": status } : { ":s": status, ":g1pk": list.gsi1pk, ":g1sk": list.gsi1sk },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionFailed(err)) return false;
    throw err;
  }
}

/** The recipe, every story on it (anyone's) and its counters. */
export async function deleteRecipeAndStories(deps: D, rid: string): Promise<void> {
  const partition = await queryAll(deps, {
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": recipePk(rid) },
  });
  // META last: if anything fails midway, the recipe is still there to delete again.
  const stories = partition.filter((i) => i.sk !== "META").map(keyOf);
  await batchDelete(deps, [...stories, recipeStatsKey(rid)]);
  await deps.db.send(new DeleteCommand({ TableName: deps.tableName, Key: recipeKey(rid) }));
}

/** Official recipes plus published community ones, with counters. */
export async function listRecipes(deps: D, viewerId: string | undefined): Promise<Recipe[]> {
  const [stats, community] = await Promise.all([listRecipeStats(deps), listCommunityRecipeItems(deps)]);
  const statsOf = (id: string) => stats.get(id) ?? EMPTY_STATS;
  return [
    ...OFFICIAL_RECIPES.map((r) => officialToRecipe(r, statsOf(r.id))),
    ...community.map((item) => communityToRecipe(item, statsOf(String(item.id)), viewerId)),
  ];
}

// ---------- stories ----------

export type StoryCreateInput = z.output<typeof StoryInputSchema>;

export function toStory(item: Item, viewerId: string | undefined): Story {
  return {
    id: String(item.id),
    recipeId: String(item.recipeId),
    authorName: String(item.authorName ?? ""),
    body: String(item.body ?? ""),
    days: typeof item.days === "number" ? item.days : null,
    verdict: (typeof item.verdict === "string" ? item.verdict : null) as Story["verdict"],
    createdAt: Number(item.createdAt ?? 0),
    isMine: viewerId !== undefined && item.userId === viewerId,
  };
}

/** Published stories of a recipe, newest first. */
export async function listStories(deps: D, rid: string, viewerId: string | undefined, max = MAX_LISTED_STORIES): Promise<Story[]> {
  const out: Story[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await deps.db.send(
      new QueryCommand({
        TableName: deps.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
        ExpressionAttributeValues: { ":pk": recipePk(rid), ":sk": "STORY#" },
        ScanIndexForward: false,
        Limit: 100,
        ExclusiveStartKey: start,
      }),
    );
    for (const item of (res.Items ?? []) as Item[]) {
      if (isPublished(item)) out.push(toStory(item, viewerId));
      if (out.length >= max) return out;
    }
    start = res.LastEvaluatedKey;
  } while (start);
  return out;
}

/** A story by id. Its sort key starts with the creation time, so the partition is searched. */
export async function findStoryItem(deps: D, rid: string, sid: string): Promise<Item | undefined> {
  const items = await queryPrefix(deps, recipePk(rid), "STORY#");
  return items.find((i) => i.id === sid && String(i.sk).endsWith(`#${sid}`));
}

export async function createStory(deps: DbDeps, user: User, rid: string, input: StoryCreateInput): Promise<Item> {
  const now = deps.now().getTime();
  const id = newId(16);
  const item: Item = {
    ...storyKey(rid, now, id),
    ...storyAuthorGsi2(user.id, rid, id),
    type: "story",
    id,
    recipeId: rid,
    authorName: input.authorName || user.nickname,
    userId: user.id,
    body: input.body,
    days: input.days ?? null,
    verdict: input.verdict ?? null,
    status: "published",
    createdAt: now,
  };
  await deps.db.send(new PutCommand({ TableName: deps.tableName, Item: item, ConditionExpression: "attribute_not_exists(pk)" }));
  await addStoryCount(deps, rid, 1);
  return item;
}

/**
 * Change a story's status. storyCount follows the published stories, so it only moves when the
 * status really changes. Returns false when the story is gone.
 */
export async function setStoryStatus(deps: D, item: Item, status: PublicStatus): Promise<boolean> {
  const rid = String(item.recipeId);
  try {
    await deps.db.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: keyOf(item),
        UpdateExpression: "SET #s = :s",
        ConditionExpression: "attribute_exists(pk) AND (#s <> :s)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": status },
      }),
    );
  } catch (err) {
    if (!isConditionFailed(err)) throw err;
    // Already in that state, or deleted.
    const res = await deps.db.send(new GetCommand({ TableName: deps.tableName, Key: keyOf(item) }));
    return res.Item !== undefined;
  }
  await addStoryCount(deps, rid, status === "hidden" ? -1 : 1);
  return true;
}

/** Delete a story; a published one also leaves storyCount. */
export async function deleteStoryItem(deps: D, item: Item): Promise<void> {
  const res = await deps.db.send(new DeleteCommand({ TableName: deps.tableName, Key: keyOf(item), ReturnValues: "ALL_OLD" }));
  if (res.Attributes && isPublished(res.Attributes)) {
    try {
      await deps.db.send(
        new UpdateCommand({
          TableName: deps.tableName,
          Key: recipeStatsKey(String(item.recipeId)),
          UpdateExpression: "ADD storyCount :d",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeValues: { ":d": -1 },
        }),
      );
    } catch (err) {
      if (!isConditionFailed(err)) throw err; // the recipe's counters are already gone
    }
  }
}
