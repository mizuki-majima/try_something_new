import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { Hono } from "hono";
import {
  API,
  AdminModerateSchema,
  AdminRecipePatchSchema,
  RecipeIdSchema,
  ShareMetricSchema,
  VERDICT_KEYS,
  findOfficialRecipe,
  todayIn,
  type AdminContactsResponse,
  type AdminReportsResponse,
  type AdminStats,
  type PilotStats,
  type Verdict,
} from "@thirty/shared";
import { requireAdmin } from "../auth";
import { listContacts } from "../db/contacts";
import { statsKey } from "../db/keys";
import { computePilotStats } from "../db/pilot";
import { getRecipeItem, setFeatured } from "../db/recipes";
import {
  deleteTarget,
  hideTarget,
  isReportDeleted,
  listReports,
  markReportDeleted,
  resetReportCount,
  resolveTarget,
  restoreTarget,
} from "../db/reports";
import { conflict, notFound } from "../errors";
import { log } from "../log";
import type { Deps } from "../ports";
import type { AppEnv } from "../types";
import { readJson } from "../validate";

const TARGET_NOT_FOUND = "対象が見つかりませんでした（削除済みかもしれません）";
const RECIPE_NOT_FOUND = "レシピが見つかりませんでした";
const DELETED_NOT_RESTORABLE = "削除した対象は復元できません";

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** "suggestions_<YYYYMMDD>" for today's JST date (incremented by POST /api/suggestions). */
export function suggestionsStatKey(now: Date): string {
  return `suggestions_${todayIn("Asia/Tokyo", now).replace(/-/g, "")}`;
}

/** STATS/GLOBAL (+ the pilot metrics scanned from the challenges) → AdminStats. */
export function toAdminStats(item: Record<string, unknown>, now: Date, pilot: PilotStats): AdminStats {
  const verdicts = Object.fromEntries(VERDICT_KEYS.map((v) => [v, num(item[`verdict_${v}`])])) as Record<Verdict, number>;
  const shareActions: Record<string, number> = Object.fromEntries(ShareMetricSchema.shape.channel.options.map((ch) => [ch, 0]));
  for (const [k, v] of Object.entries(item)) {
    if (k.startsWith("share_") && k.length > "share_".length) shareActions[k.slice("share_".length)] = num(v);
  }
  return {
    users: num(item.users),
    challengesStarted: num(item.challengesStarted),
    challengesDone: num(item.challengesDone),
    verdicts,
    communityRecipes: num(item.communityRecipes),
    stories: num(item.stories),
    shares: num(item.shares),
    shareActions,
    suggestionsToday: num(item[suggestionsStatKey(now)]),
    pushSubscriptions: num(item.pushSubscriptions),
    pilot,
  };
}

/**
 * Admin (FR-18). Every route uses requireAdmin (X-Admin-Token, constant-time compare).
 *   GET   /api/admin/reports       → AdminReportsResponse (newest first, max 100)
 *   POST  /api/admin/moderate      AdminModerate → 204. "delete" really deletes recipes, stories
 *                                  and share cards; a member (someone's challenge, private data)
 *                                  is only removed from the cohort for good and its card hidden.
 *                                  Either way the report is marked deleted and cannot be restored.
 *   PATCH /api/admin/recipes/:id   { featured } → 204 (official or community)
 *   GET   /api/admin/stats         → AdminStats (STATS/GLOBAL + pilot metrics from a capped Scan)
 *   GET   /api/admin/contacts      → AdminContactsResponse (newest first, max 100)
 */
export function adminRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  const admin = requireAdmin(deps);

  r.get(API.adminReports, admin, async (c) => c.json<AdminReportsResponse>({ items: await listReports(deps) }));

  r.post(API.adminModerate, admin, async (c) => {
    const { targetType, targetId, action } = await readJson(c, AdminModerateSchema);
    const target = await resolveTarget(deps, targetType, targetId);
    if (!target) {
      if (action === "delete") return c.body(null, 204); // already gone
      throw notFound(TARGET_NOT_FOUND);
    }
    if (action === "hide") {
      if (!(await hideTarget(deps, target))) throw notFound(TARGET_NOT_FOUND);
    } else if (action === "restore") {
      // A removed member keeps existing (the owner's private record) but stays out for good.
      if (await isReportDeleted(deps, target.type, target.id)) throw conflict(DELETED_NOT_RESTORABLE);
      if (!(await restoreTarget(deps, target))) throw notFound(TARGET_NOT_FOUND);
      await resetReportCount(deps, target.type, target.id);
    } else {
      await deleteTarget(deps, target);
      await markReportDeleted(deps, target.type, target.id);
    }
    log.info("moderated", { targetType, action });
    return c.body(null, 204);
  });

  r.patch(API.adminRecipe(":id"), admin, async (c) => {
    const parsed = RecipeIdSchema.safeParse(c.req.param("id"));
    if (!parsed.success) throw notFound(RECIPE_NOT_FOUND);
    const rid = parsed.data;
    const { featured } = await readJson(c, AdminRecipePatchSchema);
    if (!findOfficialRecipe(rid) && !(await getRecipeItem(deps, rid))) throw notFound(RECIPE_NOT_FOUND);
    await setFeatured(deps, rid, featured);
    return c.body(null, 204);
  });

  r.get(API.adminStats, admin, async (c) => {
    const [res, pilot] = await Promise.all([
      deps.db.send(new GetCommand({ TableName: deps.tableName, Key: statsKey() })),
      computePilotStats(deps),
    ]);
    return c.json<AdminStats>(toAdminStats(res.Item ?? {}, deps.now(), pilot));
  });

  r.get(API.adminContacts, admin, async (c) => c.json<AdminContactsResponse>({ items: await listContacts(deps) }));

  return r;
}
