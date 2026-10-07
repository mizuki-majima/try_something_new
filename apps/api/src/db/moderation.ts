/**
 * Moderation that outlives the challenge item (NF-2): MOD#<chId> / META.
 *   shareModerated  moderation hid or deleted this challenge's card: no new card (POST /api/shares 403)
 *   memberHidden    moderation took this challenge out of the cohort ("1日組")
 * The owner can delete the challenge item and import it again from a backup (same id); the flags on
 * the item go with it, this marker does not. The import path and POST /api/shares read it. A moderator's
 * restore clears the flag it covers. gsi2 AUTHOR#<owner> so it goes with the owner's account.
 */
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DbDeps } from "../ports";
import { moderationAuthorGsi2, moderationKey } from "./keys";
import { isConditionFailed } from "./util";

type D = Pick<DbDeps, "db" | "tableName" | "now">;

export type ModerationFlag = "shareModerated" | "memberHidden";
export type Moderation = Record<ModerationFlag, boolean>;

/** Set flags on the marker (created when missing). Written before the moderation itself, so a failure leaves nothing to bypass. */
export async function markModeration(deps: D, chId: string, ownerUid: string, flags: ModerationFlag[]): Promise<void> {
  if (flags.length === 0) return;
  const gsi2 = moderationAuthorGsi2(ownerUid, chId);
  const names: Record<string, string> = {};
  const sets = ["#type = :type", "challengeId = :chId", "gsi2pk = :g2pk", "gsi2sk = :g2sk", "updatedAt = :now"];
  flags.forEach((f, i) => {
    names[`#f${i}`] = f;
    sets.push(`#f${i} = :t`);
  });
  await deps.db.send(
    new UpdateCommand({
      TableName: deps.tableName,
      Key: moderationKey(chId),
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: { "#type": "type", ...names },
      ExpressionAttributeValues: {
        ":type": "moderation",
        ":chId": chId,
        ":g2pk": gsi2.gsi2pk,
        ":g2sk": gsi2.gsi2sk,
        ":now": deps.now().getTime(),
        ":t": true,
      },
    }),
  );
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
