/** Names shared by the stack, scripts/setup-secrets.mjs and docs/deploy.md. */

export const REGION = "ap-northeast-1";
export const STACK_NAME = "ThirtyDays";
export const PROJECT_TAG = "thirty-days";

/** SSM parameters created once by scripts/setup-secrets.mjs (never by CloudFormation). */
export const PARAM = {
  vapidPublicKey: "/thirty-days/vapid-public-key",
  /** SecureString; the Lambdas read it at cold start. */
  vapidPrivateKey: "/thirty-days/vapid-private-key",
  /** SecureString; the API reads it at cold start. */
  adminToken: "/thirty-days/admin-token",
  /** Shared secret header CloudFront adds to API requests (String: CloudFormation resolves it at deploy time). */
  originVerify: "/thirty-days/origin-verify",
} as const;

export const VAPID_SUBJECT = "https://github.com/mizuki-majima/try_something_new";

/** Mirrors apps/api/src/db/table.ts (a unit test checks they agree). */
export const TABLE_KEYS = {
  partitionKey: "pk",
  sortKey: "sk",
  ttlAttribute: "ttl",
  indexes: [
    { name: "gsi1", partitionKey: "gsi1pk", sortKey: "gsi1sk" },
    { name: "gsi2", partitionKey: "gsi2pk", sortKey: "gsi2sk" },
    { name: "gsi3", partitionKey: "gsi3pk", sortKey: "gsi3sk" },
  ],
} as const;

/** Web files that must be revalidated on every load (they point at the hashed bundles). */
export const NO_CACHE_FILES = ["index.html", "sw.js", "registerSW.js", "manifest.webmanifest"] as const;

export const CACHE_CONTROL = {
  immutable: "public, max-age=31536000, immutable",
  noCache: "no-cache",
  /** favicon, icons, og-default.png, robots.txt: unhashed but rarely change. */
  static: "public, max-age=86400",
} as const;

/** AWS Budgets limit in USD when alertEmail is set (ADR 0001: report to the CEO above $10/month). */
export const MONTHLY_BUDGET_USD = 10;
