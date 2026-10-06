/**
 * Everything the routes need from the outside world, injected so that tests and local runs
 * can swap implementations (dynalite instead of DynamoDB, a directory instead of S3, ...).
 */
import type { SuggestRequestSchema, Suggestion } from "@thirty/shared";
import type { z } from "zod";
import type { Config, Secrets } from "./config";
import type { Db } from "./db/client";

export interface MediaStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export type SuggestInput = z.output<typeof SuggestRequestSchema>;

/**
 * "ひらめき提案" (FR-13). Rule-based over built-in data, no generative AI (ADR 0003); kept behind
 * this interface so it could be swapped later (a CEO decision).
 */
export interface SuggestionProvider {
  /** At most 3, each valid against SuggestionSchema. */
  suggest(input: SuggestInput): Promise<Suggestion[]>;
}

export type PushTarget = { endpoint: string; keys: { p256dh: string; auth: string } };

export interface PushSender {
  /** `gone` = the push service answered 404/410 and the subscription should be deleted. */
  send(sub: PushTarget, payload: object): Promise<{ ok: boolean; gone: boolean }>;
}

export type Deps = {
  db: Db;
  tableName: string;
  config: Config;
  now: () => Date;
  media: MediaStore;
  suggestions: SuggestionProvider;
  push: PushSender;
  /** Filled before the first request is handled (see lambda.ts / local.ts). */
  secrets: Secrets;
};

/** The subset most db/* helpers need. */
export type DbDeps = Pick<Deps, "db" | "tableName" | "now">;
