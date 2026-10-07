/**
 * Log messages that CloudWatch metric filters match on (infra/lib/cost-guard.ts). Changing one
 * silences its alarm: infra/test/stack.test.ts checks that the infra side uses the same text.
 * No imports, so the infra tests can read it without the API's dependencies.
 */
export const ALARMED_LOGS = {
  /** POST /api/session refused new visitors at QUOTAS.sessionsGlobalPerHour (R7, R11). */
  sessionCeiling: "global session ceiling reached",
} as const;
