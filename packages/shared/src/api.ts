/**
 * Route table of the HTTP API (all JSON, all under /api).
 * Auth: "Authorization: Bearer <token>" from POST /api/session. Admin: "X-Admin-Token".
 * Errors: ApiError { error: { code, message, fields? } } with a matching HTTP status.
 */
export const API = {
  session: "/api/session", // POST create anonymous user → SessionResponse
  sessionTransfer: "/api/session/transfer", // POST { code } → SessionResponse (new token, same user)
  me: "/api/me", // GET MeResponse / PATCH MePatch → MeResponse / DELETE (all data)
  meTransferCode: "/api/me/transfer-code", // POST → TransferCodeResponse
  meExport: "/api/me/export", // GET → BackupFile
  meImport: "/api/me/import", // POST BackupFile → ImportResponse
  challenges: "/api/challenges", // GET → ChallengeListResponse / POST ChallengeCreate → ChallengeResponse (201, idempotent on id)
  challenge: (id: string) => `/api/challenges/${id}`, // PATCH ChallengePatch / DELETE
  stamp: (id: string, day: number) => `/api/challenges/${id}/stamps/${day}`, // PUT StampPut / DELETE → ChallengeResponse
  reflect: (id: string) => `/api/challenges/${id}/reflect`, // POST Reflect → ChallengeResponse
  cohort: (month: string) => `/api/cohorts/${month}`, // GET → CohortResponse (public; token optional for isMine/cheeredToday)
  cohortUpcoming: "/api/cohorts/upcoming", // GET → UpcomingResponse
  cheer: (challengeId: string) => `/api/cheers/${challengeId}`, // POST → CheerResponse
  recipes: "/api/recipes", // GET → RecipeListResponse / POST RecipeInput → { recipe }
  recipe: (id: string) => `/api/recipes/${id}`, // GET → RecipeDetailResponse / DELETE (author)
  stories: (recipeId: string) => `/api/recipes/${recipeId}/stories`, // POST StoryInput → { story }
  story: (recipeId: string, storyId: string) => `/api/recipes/${recipeId}/stories/${storyId}`, // DELETE (author)
  aiSuggest: "/api/ai/suggest", // POST AiSuggestRequest → AiSuggestResponse (503 ai_unavailable when off)
  shares: "/api/shares", // POST ShareCreate → ShareResponse
  share: (id: string) => `/api/shares/${id}`, // DELETE (owner)
  shareMetric: "/api/metrics/share", // POST ShareMetric → 204 (anonymous count only, for the pilot's share-rate metric)
  pushPublicKey: "/api/push/public-key", // GET → PushPublicKeyResponse
  pushSubscriptions: "/api/push/subscriptions", // POST PushSubscriptionInput / DELETE PushUnsubscribe
  pushTest: "/api/push/test", // POST → 204
  reports: "/api/reports", // POST ReportCreate → 204
  contact: "/api/contact", // POST ContactCreate → 204
  health: "/api/health", // GET → { ok: true }
  adminReports: "/api/admin/reports", // GET → AdminReportsResponse
  adminModerate: "/api/admin/moderate", // POST AdminModerate → 204
  adminRecipe: (id: string) => `/api/admin/recipes/${id}`, // PATCH { featured }
  adminStats: "/api/admin/stats", // GET → AdminStats
  adminContacts: "/api/admin/contacts", // GET → AdminContactsResponse
} as const;

/** Public share page (HTML with OGP tags), served by the API Lambda behind CloudFront. */
export const sharePagePath = (id: string) => `/s/${id}`;
/** Share card image, served from the media bucket behind CloudFront. */
export const shareImagePath = (id: string) => `/media/share/${id}.png`;
