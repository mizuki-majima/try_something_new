import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { Hono } from "hono";
import { API, QUOTAS, SuggestRequestSchema, type SuggestResponse } from "@thirty/shared";
import { requireUser } from "../auth";
import { statsKey } from "../db/keys";
import { enforceQuota } from "../db/rate";
import { log } from "../log";
import type { Deps } from "../ports";
import type { AppEnv } from "../types";
import { readJson } from "../validate";
import { suggestionsStatKey } from "./admin";

/** STATS/GLOBAL suggestions_<YYYYMMDD JST> += 1 (read by the admin stats as suggestionsToday). */
async function countSuggestion(deps: Deps): Promise<void> {
  await deps.db.send(
    new UpdateCommand({
      TableName: deps.tableName,
      Key: statsKey(),
      UpdateExpression: "ADD #k :one",
      ExpressionAttributeNames: { "#k": suggestionsStatKey(deps.now()) },
      ExpressionAttributeValues: { ":one": 1 },
    }),
  );
}

/**
 * "ひらめき提案" (FR-13). No generative AI (ADR 0003).
 *   POST /api/suggestions  SuggestRequest → SuggestResponse (requireUser)
 *
 * The hint is passed to the provider in memory only: it is never stored, logged or counted.
 * The quota counts a use once the request is valid (QUOTAS.suggestionsPerUserPerDay, per JST day).
 */
export function suggestionRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();

  r.post(API.suggestions, requireUser(deps), async (c) => {
    const input = await readJson(c, SuggestRequestSchema);
    const quota = await enforceQuota(deps, "suggestions", c.var.uid, QUOTAS.suggestionsPerUserPerDay, "day");
    const suggestions = await deps.suggestions.suggest(input);
    await countSuggestion(deps);
    log.debug("suggested", {
      uid: c.var.uid,
      count: suggestions.length,
      category: input.category,
      place: input.place,
      maxMinutes: input.maxMinutes,
      withHint: Boolean(input.hint),
    });
    return c.json<SuggestResponse>({ suggestions, remainingToday: quota.remaining });
  });

  return r;
}
