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
   * Kept as given (not trimmed to "unset"): a value that is set but holds no usable entry refuses
   * every request instead of turning the check off.
   */
  originVerify?: string;
  /** Secret for the HMAC of client IPs in rate-limit keys (local runs and tests; AWS uses the parameter). */
  ipHashKey?: string;
  /**
   * SSM SecureString name holding the IP hash key (used when ipHashKey is unset). When it is set,
   * a missing, empty or unreadable parameter fails loadSecrets: the API never runs with a known key.
   */
  ipHashKeyParam?: string;
  logLevel: LogLevel;
};

export type Secrets = { adminToken?: string; vapidPrivateKey?: string; ipHashKey?: string };

/**
 * A key that is public in this repository: only for local runs (local.ts passes it explicitly) and
 * tests (NODE_ENV=test). Never used on AWS: see loadSecrets and auth.ts ipHashSecret.
 */
export const DEFAULT_IP_HASH_KEY = "local-ip-hash-key";

/** Vitest sets NODE_ENV=test; the Lambda runtime never does. */
export function isTestEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "test";
}

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
    // Not str(): "set but blank" must stay visible so originVerify can fail closed (app.ts).
    originVerify: env.ORIGIN_VERIFY,
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
   * The IP hash key parameter must exist and hold a value (security, NF-4): rate-limit keys made with
   * a key that is public in the repository could be reversed by enumerating addresses, and the
   * privacy policy promises a secret key. So a missing, empty or unreadable parameter fails the
   * cold start: every request answers 500, the ApiErrors alarm fires, and the next request retries.
   */
  const ipHashKeyFromSsm = async (): Promise<string | undefined> => {
    const param = config.ipHashKeyParam;
    if (!param) return undefined;
    let value: string | undefined;
    try {
      value = await fromSsm(param);
    } catch (err) {
      log.error("ip hash key parameter could not be read; refusing to start (run scripts/setup-secrets.mjs)", { param, err });
      throw err;
    }
    if (!value) {
      log.error("ip hash key parameter is empty; refusing to start (run scripts/setup-secrets.mjs)", { param });
      throw new Error(`SSM parameter ${param} (IP hash key) is empty`);
    }
    return value;
  };
  const [adminToken, vapidPrivateKey, ipHashKey] = await Promise.all([
    config.adminToken ?? fromSsm(config.adminTokenParam),
    config.vapidPrivateKey ?? fromSsm(config.vapidPrivateKeyParam),
    config.ipHashKey ?? ipHashKeyFromSsm(),
  ]);
  // No key configured at all (the reminder Lambda, local runs): none here. auth.ts refuses to hash
  // IPs without one outside tests, and local.ts passes DEFAULT_IP_HASH_KEY itself.
  return { adminToken, vapidPrivateKey, ipHashKey };
}

/** Tests only. */
export function resetSecretsCache(): void {
  secretsPromise = undefined;
}
