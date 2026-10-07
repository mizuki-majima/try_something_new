/**
 * "すべてのデータを削除" (SPEC FR-17): everything the user authored or owns.
 */
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { log } from "../log";
import type { Deps } from "../ports";
import { GSI2 } from "./table";
import {
  authorPk,
  challengeRefKey,
  recipePk,
  recipeStatsKey,
  tokenKey,
  transferKey,
  userKey,
  userPk,
  type Key,
} from "./keys";
import { detachModeration } from "./moderation";
import { shareMediaKeys } from "./shares";
import { bumpStats } from "./stats";
import { batchDelete, isConditionFailed, keyOf, queryAll, type Item } from "./util";

export type DeleteAccountResult = { tokenHashes: string[]; deletedItems: number };

const after = (s: string, prefix: string) => s.slice(prefix.length);

export async function deleteAccount(deps: Deps, uid: string): Promise<DeleteAccountResult> {
  const keys: Key[] = [];
  const deletedRecipes = new Set<string>();
  const storyDecrements = new Map<string, number>();
  const mediaKeys: string[] = [];
  /** MOD#<chId> markers from before R12 (indexed under the owner): kept, only detached. */
  const markers: string[] = [];

  // 1. Public things the user authored (recipes, stories, share cards, ...), found through gsi2.
  const authored = await queryAll(deps, {
    IndexName: GSI2,
    KeyConditionExpression: "gsi2pk = :pk",
    ExpressionAttributeValues: { ":pk": authorPk(uid) },
  });
  for (const item of authored) {
    const pk = String(item.pk);
    const sk = String(item.sk);
    if (pk.startsWith("SHARE#") && sk === "META") {
      keys.push(keyOf(item));
      // Public and hidden-by-moderation image alike.
      mediaKeys.push(...shareMediaKeys(after(pk, "SHARE#")));
    } else if (pk.startsWith("RECIPE#") && sk === "META") {
      const rid = after(pk, "RECIPE#");
      deletedRecipes.add(rid);
      // The whole partition: the recipe and every story on it (including other people's).
      const partition = await queryAll(deps, {
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": recipePk(rid) },
      });
      keys.push(...partition.map(keyOf), recipeStatsKey(rid));
    } else if (pk.startsWith("RECIPE#") && sk.startsWith("STORY#")) {
      keys.push(keyOf(item));
      // A hidden story already left storyCount when it was hidden (setStoryStatus).
      if (item.status !== "hidden") {
        const rid = after(pk, "RECIPE#");
        storyDecrements.set(rid, (storyDecrements.get(rid) ?? 0) + 1);
      }
    } else if (pk.startsWith("MOD#")) {
      // Moderation outlives the account (R12): a new account importing the same id stays stopped.
      markers.push(after(pk, "MOD#"));
    } else {
      keys.push(keyOf(item));
    }
  }

  // 2. Everything in the user's own partition, plus the items those point to.
  const own: Item[] = await queryAll(deps, {
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": userPk(uid) },
  });
  const lastKeys: Key[] = [userKey(uid)];
  const tokenHashes: string[] = [];
  let pushCount = 0;
  for (const item of own) {
    const sk = String(item.sk);
    if (sk === "PROFILE") continue;
    if (sk.startsWith("TOKEN#")) {
      const hash = after(sk, "TOKEN#");
      tokenHashes.push(hash);
      lastKeys.push(keyOf(item), tokenKey(hash));
      continue;
    }
    keys.push(keyOf(item));
    if (sk.startsWith("CH#")) keys.push(challengeRefKey(after(sk, "CH#")));
    else if (sk.startsWith("TRANSFER#")) keys.push(transferKey(after(sk, "TRANSFER#")));
    else if (sk.startsWith("PUSH#")) pushCount++;
  }

  // 3. Media first (an orphaned image is worse than an orphaned row), then rows. A failed image
  //    delete fails the request before any row goes, so the client can retry with the same token
  //    (once the rows are gone nothing would point at the image any more).
  let mediaFailures = 0;
  for (const key of mediaKeys) {
    try {
      await deps.media.delete(key);
    } catch (err) {
      mediaFailures++;
      log.warn("account delete: media delete failed", { uid, key, err });
    }
  }
  if (mediaFailures > 0) throw new Error(`account delete: ${mediaFailures} media object(s) could not be deleted`);
  for (const chId of markers) await detachModeration(deps, chId);
  await batchDelete(deps, keys);

  for (const [rid, n] of storyDecrements) {
    if (deletedRecipes.has(rid)) continue;
    try {
      await deps.db.send(
        new UpdateCommand({
          TableName: deps.tableName,
          Key: recipeStatsKey(rid),
          UpdateExpression: "ADD storyCount :d",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeValues: { ":d": -n },
        }),
      );
    } catch (err) {
      if (!isConditionFailed(err)) throw err;
    }
  }

  // 4. Profile and tokens last, so a failure above can be retried with the same token.
  await batchDelete(deps, lastKeys);
  await bumpStats(deps, { users: -1, pushSubscriptions: -pushCount });

  return { tokenHashes, deletedItems: keys.length + lastKeys.length };
}
