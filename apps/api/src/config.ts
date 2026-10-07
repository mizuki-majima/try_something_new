import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { log } from "./log";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export type Config = {
  tableName: string;
  /** Local DynamoDB-compatible endpoint (dynalite). Unset on AWS. */
  dynamoEndpoint?: string;
  region: string;
  /** S3 bucket for public media (share cards). Takes precedence over mediaDir. */
  mediaBucket?: string;
  /** Local directory for media when there is no bucket. */
  mediaDir?: string;
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  /** SSM SecureString name holding the VAPID private key (used when vapidPrivateKey is unset). */
  vapidPrivateKeyParam?: string;
  vapidSubject: string;
  adminToken?: string;
  /** SSM SecureString name holding the admin token (used when adminToken is unset). */
  adminTokenParam?: string;
  /**
   * When set, every request must carry one of these values in `x-origin-verify` (added by CloudFront).
   * Comma-separated, so a rotation can accept the new and the old value for one deploy (see app.ts).
   */
  originVerify?: string;
  /** Secret for the HMAC of client IPs in rate-limit keys (local runs and tests; AWS uses the parameter). */
  ipHashKey?: string;
  /** SSM SecureString name holding the IP hash key (used when ipHashKey is unset). */
  ipHashKeyParam?: string;
  logLevel: LogLevel;
};

export type Secrets = { adminToken?: string; vapidPrivateKey?: string; ipHashKey?: string };

/** Used when neither IP_HASH_KEY nor its parameter is configured (local runs, tests). */
export const DEFAULT_IP_HASH_KEY = "local-ip-hash-key";

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error", "silent"];

function str(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, name: string): T {
  if (value === undefined) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${name} must be one of ${allowed.join(", ")} (got "${value}")`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    tableName: str(env, "TABLE_NAME") ?? "thirty-days-local",
    dynamoEndpoint: str(env, "DYNAMO_ENDPOINT"),
    region: str(env, "AWS_REGION") ?? "ap-northeast-1",
    mediaBucket: str(env, "MEDIA_BUCKET"),
    mediaDir: str(env, "MEDIA_DIR"),
    vapidPublicKey: str(env, "VAPID_PUBLIC_KEY"),
    vapidPrivateKey: str(env, "VAPID_PRIVATE_KEY"),
    vapidPrivateKeyParam: str(env, "VAPID_PRIVATE_KEY_PARAM"),
    vapidSubject: str(env, "VAPID_SUBJECT") ?? "https://github.com/mizuki-majima/try_something_new",
    adminToken: str(env, "ADMIN_TOKEN"),
    adminTokenParam: str(env, "ADMIN_TOKEN_PARAM"),
    originVerify: str(env, "ORIGIN_VERIFY"),
    ipHashKey: str(env, "IP_HASH_KEY"),
    ipHashKeyParam: str(env, "IP_HASH_KEY_PARAM"),
    logLevel: oneOf(str(env, "LOG_LEVEL"), LOG_LEVELS, "info", "LOG_LEVEL"),
  };
}

let secretsPromise: Promise<Secrets> | undefined;

/**
 * Secrets from env or SSM SecureStrings, fetched in parallel once per cold start.
 * A failed load is not cached, so the next request retries.
 */
export function loadSecrets(config: Config, ssm?: Pick<SSMClient, "send">): Promise<Secrets> {
  if (!secretsPromise) {
    secretsPromise = fetchSecrets(config, ssm).catch((err: unknown) => {
      secretsPromise = undefined;
      throw err;
    });
  }
  return secretsPromise;
}

async function fetchSecrets(config: Config, ssm?: Pick<SSMClient, "send">): Promise<Secrets> {
  let client = ssm;
  const fromSsm = async (name: string | undefined): Promise<string | undefined> => {
    if (!name) return undefined;
    client ??= new SSMClient({ region: config.region });
    const res = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    return res.Parameter?.Value || undefined;
  };
  /**
   * A missing IP hash key parameter (a deploy before scripts/setup-secrets.mjs created it) must not
   * take the whole API down: rate limiting still works with the built-in key, and the error is logged.
   */
  const ipHashKeyFromSsm = async (): Promise<string | undefined> => {
    try {
      return await fromSsm(config.ipHashKeyParam);
    } catch (err) {
      if ((err as { name?: string } | null)?.name !== "ParameterNotFound") throw err;
      log.error("ip hash key parameter not found; using the built-in key", { param: config.ipHashKeyParam });
      return undefined;
    }
  };
  const [adminToken, vapidPrivateKey, ipHashKey] = await Promise.all([
    config.adminToken ?? fromSsm(config.adminTokenParam),
    config.vapidPrivateKey ?? fromSsm(config.vapidPrivateKeyParam),
    config.ipHashKey ?? ipHashKeyFromSsm(),
  ]);
  return { adminToken, vapidPrivateKey, ipHashKey: ipHashKey ?? DEFAULT_IP_HASH_KEY };
}

/** Tests only. */
export function resetSecretsCache(): void {
  secretsPromise = undefined;
}
