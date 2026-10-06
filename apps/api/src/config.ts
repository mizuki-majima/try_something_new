import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

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
  /** When set, every request must carry this value in `x-origin-verify` (added by CloudFront). */
  originVerify?: string;
  logLevel: LogLevel;
};

export type Secrets = { adminToken?: string; vapidPrivateKey?: string };

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
  const [adminToken, vapidPrivateKey] = await Promise.all([
    config.adminToken ?? fromSsm(config.adminTokenParam),
    config.vapidPrivateKey ?? fromSsm(config.vapidPrivateKeyParam),
  ]);
  return { adminToken, vapidPrivateKey };
}

/** Tests only. */
export function resetSecretsCache(): void {
  secretsPromise = undefined;
}
