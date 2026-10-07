/** Names shared by the stack, scripts/setup-secrets.mjs and docs/deploy.md. */

export const REGION = "ap-northeast-1";
export const STACK_NAME = "ThirtyDays";
/** The AWS account is shared with other projects: say which service the stack is. */
export const STACK_DESCRIPTION = "30日だけ (try_something_new)";
/** API Gateway names are not unique per account; "HttpApi" (the construct id) said nothing. */
export const HTTP_API_NAME = "ThirtyDaysApi";
export const PROJECT_TAG = "thirty-days";
/**
 * The budget's cost filter: the Project tag as a cost allocation tag. It only matches once the tag
 * is activated in Billing → Cost allocation tags (docs/deploy.md); until then the budget reads $0.
 */
export const COST_ALLOCATION_TAG = `user:Project$${PROJECT_TAG}`;

/** SSM parameters created by scripts/setup-secrets.mjs (never by CloudFormation). */
export const PARAM = {
  vapidPublicKey: "/thirty-days/vapid-public-key",
  /** SecureString; the Lambdas read it at cold start. */
  vapidPrivateKey: "/thirty-days/vapid-private-key",
  /** SecureString; the API reads it at cold start. */
  adminToken: "/thirty-days/admin-token",
  /**
   * The x-origin-verify values the API accepts, comma-separated ("old,new" while rotating).
   * String: CloudFormation resolves it at deploy time into the api Lambda's ORIGIN_VERIFY.
   */
  originVerify: "/thirty-days/origin-verify",
  /** The single x-origin-verify value CloudFront sends (String, resolved at deploy time). */
  originVerifySend: "/thirty-days/origin-verify-send",
  /** SecureString; HMAC key for client IPs in rate-limit keys. The API reads it at cold start. */
  ipHashKey: "/thirty-days/ip-hash-key",
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

/**
 * On-demand throughput cap of the table and of each GSI (request units per second), as a cost
 * circuit breaker (AI PM decisions R1, R15): DynamoDB throttles above it instead of billing without
 * limit. 100 users need a few units a second. The caps bound the hourly RATE, not a monthly total:
 * in Tokyo ($0.1425 per million RRU, $0.715 per million WRU) one table or index at its cap costs
 * about $0.51/hour in reads and $0.26/hour in writes (table + 3 GSIs all at their caps: about
 * $3.1/hour). Traffic kept just under the caps is never throttled; the budget mail is what notices
 * sustained use. Reads are cheap and every authenticated request reads the table, so the read cap is
 * well above what one client draws in ordinary use (R15). A throttled request is retried by the SDK
 * and alarmed on (cost-guard.ts DynamoThrottles).
 */
export const TABLE_MAX_THROUGHPUT = { maxReadRequestUnits: 1000, maxWriteRequestUnits: 100 } as const;

/**
 * DynamoDB operations (CloudWatch "Operation" dimension) the Lambdas use. The throttle alarm sums
 * ThrottledRequests over these; infra/test checks that every DynamoDB command in apps/api/src is
 * listed. An alarm's math expression takes at most 10 metrics.
 */
export const TABLE_OPERATIONS = [
  "GetItem",
  "PutItem",
  "UpdateItem",
  "DeleteItem",
  "Query",
  "Scan",
  "BatchGetItem",
  "BatchWriteItem",
] as const;

/**
 * The API's warning when POST /api/session turns new visitors away at the global ceiling (R11). Must
 * equal apps/api/src/log-events.ts ALARMED_LOGS.sessionCeiling (infra/test checks it): the metric
 * filter matches this phrase in the api log group.
 */
export const SESSION_CEILING_LOG = "global session ceiling reached";

/** CloudWatch namespace of the custom metrics our log metric filters publish. */
export const ALARM_METRIC_NAMESPACE = "ThirtyDays";

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

/**
 * Stale reminder events are dropped: the next 15-minute slot has its own event, and a reminder
 * that arrives late is worse than none (FR-14).
 */
export const REMINDER_MAX_EVENT_AGE_MINUTES = 15;
