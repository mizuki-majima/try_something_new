/**
 * Test harness: one in-memory dynalite per test file, the real app with injected deps and a
 * controllable clock. Requests go through app.request() (no HTTP server for the API itself).
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import dynalite from "dynalite";
import { afterAll, beforeAll } from "vitest";
import type { SessionResponse } from "@thirty/shared";
import { createApp } from "../src/app";
import { loadConfig, type Config } from "../src/config";
import { createDocClient, createDynamoClient } from "../src/db/client";
import { createTableIfMissing } from "../src/db/table";
import type { Item } from "../src/db/util";
import { setLogLevel } from "../src/log";
import { MemoryMediaStore } from "../src/media";
import type { Deps } from "../src/ports";
import { NoopPushSender } from "../src/providers/push";
import { UnavailableSuggestionProvider } from "../src/providers/suggestions";

export const ADMIN_TOKEN = "test-admin-token";

export class Clock {
  private t: number;
  constructor(iso = "2026-10-06T03:00:00.000Z") {
    this.t = Date.parse(iso);
  }
  now = (): Date => new Date(this.t);
  set(iso: string): void {
    this.t = Date.parse(iso);
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export type RequestOptions = {
  method?: string;
  body?: unknown;
  /** Raw body (sent as-is instead of JSON). */
  raw?: string;
  token?: string;
  /** Content-Type to send; default application/json for POST/PUT/PATCH and for any body. null = none. */
  contentType?: string | null;
  /** Client IP (x-viewer-ip). Defaults to a fresh address per request so IP quotas don't collide. */
  ip?: string;
  headers?: Record<string, string>;
};

export type TestApi = {
  deps: Deps;
  clock: Clock;
  media: MemoryMediaStore;
  push: NoopPushSender;
  app: ReturnType<typeof createApp>;
  /** A separate app on the same table with config overrides (e.g. originVerify). */
  makeApp(config: Partial<Config>): ReturnType<typeof createApp>;
  request(path: string, opts?: RequestOptions, app?: ReturnType<typeof createApp>): Promise<Response>;
  createSession(nickname?: string, tz?: string): Promise<SessionResponse>;
  scanAll(): Promise<Item[]>;
};

let ipCounter = 0;
export const freshIp = () => {
  ipCounter++;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
};

/** Registers beforeAll/afterAll for the calling test file and returns the (lazily filled) harness. */
export function setupApi(): TestApi {
  setLogLevel(process.env.LOG_LEVEL === "debug" ? "debug" : "silent");
  const api = {} as TestApi;
  let server: Server;
  let raw: DynamoDBClient;

  beforeAll(async () => {
    server = dynalite({ createTableMs: 0, deleteTableMs: 0, updateTableMs: 0 });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const config = loadConfig({ TABLE_NAME: "test", DYNAMO_ENDPOINT: endpoint, LOG_LEVEL: "silent" });
    raw = createDynamoClient({ region: config.region, endpoint });
    await createTableIfMissing(raw, config.tableName);

    const clock = new Clock();
    const media = new MemoryMediaStore();
    const push = new NoopPushSender();
    const deps: Deps = {
      db: createDocClient(raw),
      tableName: config.tableName,
      config,
      now: clock.now,
      media,
      suggestions: new UnavailableSuggestionProvider(),
      push,
      secrets: { adminToken: ADMIN_TOKEN },
    };
    const app = createApp(deps);

    Object.assign(api, {
      deps,
      clock,
      media,
      push,
      app,
      makeApp: (overrides: Partial<Config>) => createApp({ ...deps, config: { ...config, ...overrides } }),
      request: (path: string, opts: RequestOptions = {}, target = app) => {
        const hasBody = opts.body !== undefined || opts.raw !== undefined;
        const method = opts.method ?? (hasBody ? "POST" : "GET");
        const headers: Record<string, string> = { "x-viewer-ip": opts.ip ?? freshIp(), ...opts.headers };
        const defaultType = hasBody || ["POST", "PUT", "PATCH"].includes(method) ? "application/json" : null;
        const type = opts.contentType === undefined ? defaultType : opts.contentType;
        if (type) headers["content-type"] = type;
        if (opts.token) headers.authorization = `Bearer ${opts.token}`;
        const body = opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
        // Real clients always send it with a body; the API relies on it (DELETE with/without body).
        if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
        return Promise.resolve(target.request(path, { method, headers, body }));
      },
      createSession: async (nickname?: string, tz = "Asia/Tokyo") => {
        const res = await api.request("/api/session", { body: nickname === undefined ? { tz } : { tz, nickname } });
        if (res.status !== 201) throw new Error(`createSession failed: ${res.status} ${await res.text()}`);
        return (await res.json()) as SessionResponse;
      },
      scanAll: async () => {
        const items: Item[] = [];
        let start: Record<string, unknown> | undefined;
        do {
          const res = await deps.db.send(new ScanCommand({ TableName: deps.tableName, ExclusiveStartKey: start }));
          items.push(...((res.Items ?? []) as Item[]));
          start = res.LastEvaluatedKey;
        } while (start);
        return items;
      },
    } satisfies TestApi);
  });

  afterAll(async () => {
    raw?.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  return api;
}

export async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
