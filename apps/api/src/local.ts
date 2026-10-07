/**
 * Local API for `npm run dev` and E2E: dynalite (in-memory DynamoDB) + the Hono app on Node.
 * Run directly with `npx tsx apps/api/src/local.ts` (PORT, DYNAMO_ENDPOINT, ... from env).
 */
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import dynalite from "dynalite";
import { Hono } from "hono";
import webpush from "web-push";
import { createApp } from "./app";
import { DEFAULT_IP_HASH_KEY, loadConfig } from "./config";
import { createDocClient, createDynamoClient } from "./db/client";
import { createTableIfMissing } from "./db/table";
import { buildDeps } from "./deps";
import { onError, onNotFound } from "./errors";
import { log, setLogLevel } from "./log";
import { LocalMediaStore, assertMediaKey } from "./media";
import type { Deps } from "./ports";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const LOCAL_ADMIN_TOKEN = "local-admin-token";

export type LocalOptions = {
  /** API port (0 = any free port). */
  port?: number;
  /** dynalite port (0/undefined = any free port). Ignored when DYNAMO_ENDPOINT is set. */
  dynamoPort?: number;
  /** Where media (share card images) are written; relative paths are resolved against the repo root. */
  mediaDir?: string;
  /** Runs after the table exists and before the server listens (E2E fixtures). */
  seed?: (deps: Deps) => Promise<void>;
  /** Extra environment on top of process.env. */
  env?: NodeJS.ProcessEnv;
  hostname?: string;
};

export type LocalServer = {
  url: string;
  port: number;
  dynamoEndpoint: string;
  deps: Deps;
  close: () => Promise<void>;
};

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function closeServer(server: { close(cb: (err?: Error) => void): unknown }): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const MEDIA_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" };

/** Only these media keys are public (hidden/share/* holds cards hidden by moderation). */
const PUBLIC_MEDIA_PREFIX = "share/";

/** GET /media/share/<key> from the local media directory (CloudFront + S3 do this in production). */
export function mediaRoutes(dir: string) {
  const r = new Hono();
  r.get("/media/*", async (c) => {
    const key = c.req.path.slice("/media/".length);
    try {
      assertMediaKey(key);
    } catch {
      return c.text("Not Found", 404);
    }
    if (!key.startsWith(PUBLIC_MEDIA_PREFIX)) return c.text("Not Found", 404);
    try {
      const bytes = await readFile(path.join(dir, ...key.split("/")));
      const type = MEDIA_TYPES[path.extname(key).toLowerCase()] ?? "application/octet-stream";
      return c.body(new Uint8Array(bytes), 200, { "Content-Type": type, "Cache-Control": "no-cache" });
    } catch {
      return c.text("Not Found", 404);
    }
  });
  return r;
}

export async function startLocal(opts: LocalOptions = {}): Promise<LocalServer> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };

  let dynamoEndpoint = env.DYNAMO_ENDPOINT;
  let dynaliteServer: Server | undefined;
  if (!dynamoEndpoint) {
    dynaliteServer = dynalite({ createTableMs: 0, deleteTableMs: 0, updateTableMs: 0 });
    const port = await listen(dynaliteServer, opts.dynamoPort ?? 0);
    dynamoEndpoint = `http://127.0.0.1:${port}`;
  }

  let vapidPublicKey = env.VAPID_PUBLIC_KEY;
  let vapidPrivateKey = env.VAPID_PRIVATE_KEY;
  if (!vapidPublicKey || !vapidPrivateKey) {
    const keys = webpush.generateVAPIDKeys();
    vapidPublicKey = keys.publicKey;
    vapidPrivateKey = keys.privateKey;
  }

  const mediaDir = path.resolve(REPO_ROOT, opts.mediaDir ?? env.MEDIA_DIR ?? ".local-data/media");
  const config = loadConfig({
    ...env,
    DYNAMO_ENDPOINT: dynamoEndpoint,
    MEDIA_BUCKET: "",
    MEDIA_DIR: mediaDir,
    VAPID_PUBLIC_KEY: vapidPublicKey,
    VAPID_PRIVATE_KEY: vapidPrivateKey,
    VAPID_PRIVATE_KEY_PARAM: "",
    ADMIN_TOKEN: env.ADMIN_TOKEN ?? LOCAL_ADMIN_TOKEN,
    ADMIN_TOKEN_PARAM: "",
  });
  setLogLevel(config.logLevel);

  const raw = createDynamoClient({ region: config.region, endpoint: dynamoEndpoint });
  await createTableIfMissing(raw, config.tableName);
  const deps = buildDeps(config, {
    db: createDocClient(raw),
    media: new LocalMediaStore(mediaDir),
    secrets: { adminToken: config.adminToken, vapidPrivateKey: config.vapidPrivateKey, ipHashKey: config.ipHashKey ?? DEFAULT_IP_HASH_KEY },
  });
  if (opts.seed) await opts.seed(deps);

  const app = createApp(deps);
  const root = new Hono();
  root.route("/", mediaRoutes(mediaDir));
  root.all("*", (c) => app.fetch(c.req.raw, c.env));
  root.onError(onError);
  root.notFound(onNotFound);

  const hostname = opts.hostname ?? env.HOST ?? "127.0.0.1";
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: root.fetch, port: opts.port ?? 8787, hostname }, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://${hostname === "0.0.0.0" ? "127.0.0.1" : hostname}:${port}`,
    port,
    dynamoEndpoint,
    deps,
    close: async () => {
      await closeServer(server);
      raw.destroy();
      if (dynaliteServer) await closeServer(dynaliteServer);
    },
  };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const local = await startLocal({ port: Number(process.env.PORT ?? 8787) });
  log.info("local api ready", { url: local.url, dynamo: local.dynamoEndpoint });
  process.stdout.write(`\n  API      ${local.url}/api/health\n  Admin    token "${local.deps.secrets.adminToken === LOCAL_ADMIN_TOKEN ? LOCAL_ADMIN_TOKEN : "(from ADMIN_TOKEN)"}"\n\n`);
  const stop = () => {
    local.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
