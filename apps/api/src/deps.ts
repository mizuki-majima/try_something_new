import type { Config, Secrets } from "./config";
import { createDocClient } from "./db/client";
import { LocalMediaStore, S3MediaStore } from "./media";
import type { Deps } from "./ports";
import { createPushSender } from "./providers/push";
import { createSuggestionProvider } from "./providers/suggestions";

/** Production wiring from config. Tests and local runs override pieces. */
export function buildDeps(config: Config, overrides: Partial<Deps> = {}): Deps {
  const secrets: Secrets = overrides.secrets ?? {};
  return {
    db: overrides.db ?? createDocClient({ region: config.region, endpoint: config.dynamoEndpoint }),
    tableName: config.tableName,
    config,
    now: () => new Date(),
    media: config.mediaBucket
      ? new S3MediaStore(config.mediaBucket, config.region)
      : new LocalMediaStore(config.mediaDir ?? ".local-data/media"),
    suggestions: overrides.suggestions ?? createSuggestionProvider(),
    push: overrides.push ?? createPushSender(config, secrets),
    ...overrides,
    secrets,
  };
}
