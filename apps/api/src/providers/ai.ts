import type { Config } from "../config";
import { HttpError, MESSAGES } from "../errors";
import type { AiProvider } from "../ports";

/** AI_PROVIDER=off: the button is disabled on the client; calls fail with 503 ai_unavailable. */
export class OffAiProvider implements AiProvider {
  async suggest(): Promise<never> {
    throw new HttpError(503, "ai_unavailable", MESSAGES.aiUnavailable);
  }
}

/**
 * Hook for the AI implementation: map config.aiProvider to a provider.
 * TODO(ai): "bedrock" → Bedrock (Claude) provider, "mock" → deterministic offline provider
 * (local dev / E2E). Until then every kind falls back to "off".
 */
export function createAiProvider(config: Config): AiProvider {
  switch (config.aiProvider) {
    case "bedrock":
    case "mock":
    case "off":
    default:
      return new OffAiProvider();
  }
}
