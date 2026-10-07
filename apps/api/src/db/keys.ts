/**
 * Key builders for every item in SPEC "Data Model". Keep all key strings here so the
 * layout can be read (and changed) in one place.
 */

export type Key = { pk: string; sk: string };

/** Zero-padded 13-digit epoch milliseconds, so string order == time order. */
export function ts13(ms: number): string {
  return String(Math.max(0, Math.floor(ms))).padStart(13, "0");
}

/** DynamoDB TTL value (epoch seconds) `seconds` from `nowMs`. */
export function ttlIn(nowMs: number, seconds: number): number {
  return Math.floor(nowMs / 1000) + seconds;
}

export const PREFIX = {
  user: "USER#",
  token: "TOKEN#",
  challenge: "CH#",
  push: "PUSH#",
  transfer: "TRANSFER#",
  recipe: "RECIPE#",
  story: "STORY#",
  share: "SHARE#",
  author: "AUTHOR#",
  cohort: "COHORT#",
  slot: "SLOT#",
} as const;

// ---------- users & tokens ----------

export const userKey = (uid: string): Key => ({ pk: `USER#${uid}`, sk: "PROFILE" });
export const userPk = (uid: string) => `USER#${uid}`;

export const tokenKey = (hash: string): Key => ({ pk: `TOKEN#${hash}`, sk: "TOKEN" });
/** Reverse lookup so account deletion can find a user's tokens. */
export const tokenRefKey = (uid: string, hash: string): Key => ({ pk: `USER#${uid}`, sk: `TOKEN#${hash}` });

// ---------- device transfer ----------

export const transferKey = (code: string): Key => ({ pk: `TRANSFER#${code}`, sk: "META" });
/** Reverse lookup so a new code (or account deletion) can revoke the old one. */
export const transferRefKey = (uid: string, code: string): Key => ({ pk: `USER#${uid}`, sk: `TRANSFER#${code}` });

// ---------- challenges & cohorts ----------

export const challengeKey = (uid: string, chId: string): Key => ({ pk: `USER#${uid}`, sk: `CH#${chId}` });
export const challengeRefKey = (chId: string): Key => ({ pk: `CHREF#${chId}`, sk: "REF" });

export const cohortGsi1 = (month: string, updatedAt: number, chId: string) => ({
  gsi1pk: `COHORT#${month}`,
  gsi1sk: `${ts13(updatedAt)}#${chId}`,
});
export const cohortPk = (month: string) => `COHORT#${month}`;

export const cheerKey = (chId: string, date: string, uid: string): Key => ({ pk: `CHEER#${chId}#${date}`, sk: `BY#${uid}` });

// ---------- recipes & stories ----------

export const recipeKey = (rid: string): Key => ({ pk: `RECIPE#${rid}`, sk: "META" });
export const recipePk = (rid: string) => `RECIPE#${rid}`;
export const recipeListGsi1 = (createdAt: number, rid: string) => ({ gsi1pk: "RECIPES", gsi1sk: `${ts13(createdAt)}#${rid}` });
export const recipeAuthorGsi2 = (uid: string, rid: string) => ({ gsi2pk: `AUTHOR#${uid}`, gsi2sk: `RECIPE#${rid}` });

export const recipeStatsKey = (rid: string): Key => ({ pk: "RSTATS", sk: rid });
export const RECIPE_STATS_PK = "RSTATS";

export const storyKey = (rid: string, createdAt: number, sid: string): Key => ({
  pk: `RECIPE#${rid}`,
  sk: `STORY#${ts13(createdAt)}#${sid}`,
});
export const storyAuthorGsi2 = (uid: string, rid: string, sid: string) => ({
  gsi2pk: `AUTHOR#${uid}`,
  gsi2sk: `STORY#${rid}#${sid}`,
});

// ---------- share cards ----------

export const shareKey = (sid: string): Key => ({ pk: `SHARE#${sid}`, sk: "META" });
export const shareAuthorGsi2 = (uid: string, sid: string) => ({ gsi2pk: `AUTHOR#${uid}`, gsi2sk: `SHARE#${sid}` });
/** Object key of the card image in the media store (served at /media/share/<id>.png). */
export const shareMediaKey = (sid: string) => `share/${sid}.png`;
/**
 * Where a card hidden by moderation keeps its image: outside share/, the only prefix CloudFront
 * (and local.ts) serve, so it stops being public; "restore" moves it back.
 */
export const hiddenShareMediaKey = (sid: string) => `hidden/share/${sid}.png`;

export const authorPk = (uid: string) => `AUTHOR#${uid}`;

// ---------- push ----------

export const pushKey = (uid: string, endpointHash: string): Key => ({ pk: `USER#${uid}`, sk: `PUSH#${endpointHash}` });
export const pushSlotGsi3 = (slot: string, uid: string, endpointHash: string) => ({
  gsi3pk: `SLOT#${slot}`,
  gsi3sk: `${uid}#${endpointHash}`,
});
export const slotPk = (slot: string) => `SLOT#${slot}`;

// ---------- rate limits ----------

export const rateKey = (scope: string, key: string, window: string): Key => ({ pk: `RATE#${scope}#${key}#${window}`, sk: "RATE" });

// ---------- moderation & contact ----------

export const reportKey = (type: string, id: string): Key => ({ pk: `REPORT#${type}#${id}`, sk: "META" });
export const reporterKey = (type: string, id: string, uid: string): Key => ({ pk: `REPORT#${type}#${id}`, sk: `BY#${uid}` });
export const reportListGsi1 = (lastAt: number) => ({ gsi1pk: "REPORTS", gsi1sk: ts13(lastAt) });

export const contactKey = (id: string): Key => ({ pk: `CONTACT#${id}`, sk: "META" });
export const contactListGsi1 = (createdAt: number) => ({ gsi1pk: "CONTACTS", gsi1sk: ts13(createdAt) });

// ---------- stats ----------

export const statsKey = (): Key => ({ pk: "STATS", sk: "GLOBAL" });
