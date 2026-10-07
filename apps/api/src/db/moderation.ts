/**
 * Moderation that outlives the challenge item (NF-2): MOD#<chId> / META.
 *   shareModerated  moderation hid or deleted this challenge's card: no new card (POST /api/shares 403)
 *   memberHidden    moderation took this challenge out of the cohort ("1日組")
 * The owner can delete the challenge item and import it again from a backup (same id); the flags on
 * the item go with it, this marker does not. The import path and POST /api/shares read it. A moderator's
 * restore clears the flag it covers.
 *
 * The marker also outlives the owner's ACCOUNT (R12): it holds the challenge id and the flags only,
 * nothing personal, and is not indexed under the owner (no gsi2 AUTHOR#). Otherwise deleting the account
 * and importing the backup into a new one would bring back what moderation stopped (R3-API-3).
 */
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DbDeps } from "../ports";
import { moderationKey } from "./keys";
import { isConditionFailed } from "./util";

type D = Pick<DbDeps, "db" | "tableName" | "now">;

export type ModerationFlag = "shareModerated" | "memberHidden";
export type Moderation = Record<ModerationFlag, boolean>;

/**
 * Set flags on the marker (created when missing). Written before the moderation itself, so a failure
 * leaves nothing to bypass. A marker from before R12 loses its owner index here too.
 */
export async function markModeration(deps: D, chId: string, flags: ModerationFlag[]): Promise<void> {
  if (flags.length === 0) return;
  const names: Record<string, string> = {};
  const sets = ["#type = :type", "challengeId = :chId", "updatedAt = :now"];
  flags.forEach((f, i) => {
    names[`#f${i}`] = f;
    sets.push(`#f${i} = :t`);
  });
  await deps.db.send(
    new UpdateCommand({
      TableName: deps.tableName,
      Key: moderationKey(chId),
      UpdateExpression: `SET ${sets.join(", ")} REMOVE gsi2pk, gsi2sk`,
      ExpressionAttributeNames: { "#type": "type", ...names },
      ExpressionAttributeValues: { ":type": "moderation", ":chId": chId, ":now": deps.now().getTime(), ":t": true },
    }),
  );
}

/**
 * Account deletion found a marker written before R12 (indexed under the owner with gsi2 AUTHOR#):
 * keep it, and drop the owner index so nothing links it to the deleted account.
 */
export async function detachModeration(deps: Pick<DbDeps, "db" | "tableName">, chId: string): Promise<void> {
  try {
    await deps.db.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: moderationKey(chId),
        UpdateExpression: "REMOVE gsi2pk, gsi2sk",
        ConditionExpression: "attribute_exists(pk)",
      }),
    );
  } catch (err) {
    if (!isConditionFailed(err)) throw err;
  }
}

/** Clear one flag (a moderator's restore). Nothing happens when there is no marker. */
export async function clearModeration(deps: D, chId: string, flag: ModerationFlag): Promise<void> {
  try {
    await deps.db.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: moderationKey(chId),
        UpdateExpression: "REMOVE #f SET updatedAt = :now",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#f": flag },
        ExpressionAttributeValues: { ":now": deps.now().getTime() },
      }),
    );
  } catch (err) {
    if (!isConditionFailed(err)) throw err;
  }
}

export async function getModeration(deps: Pick<DbDeps, "db" | "tableName">, chId: string): Promise<Moderation> {
  const res = await deps.db.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: moderationKey(chId),
      ProjectionExpression: "shareModerated, memberHidden",
    }),
  );
  return { shareModerated: res.Item?.shareModerated === true, memberHidden: res.Item?.memberHidden === true };
}
