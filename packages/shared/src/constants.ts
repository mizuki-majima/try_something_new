/** The whole service is built around this number. */
export const TOTAL_DAYS = 30;

/** "ここで区切る" (finish early and reflect) becomes available from this day. */
export const EARLY_REFLECT_FROM_DAY = 7;

export const CATEGORIES = {
  body: "からだ",
  mind: "あたま",
  hands: "手しごと",
  people: "人と",
  quit: "やめる",
} as const;
export type Category = keyof typeof CATEGORIES;
export const CATEGORY_KEYS = Object.keys(CATEGORIES) as [Category, ...Category[]];

export const PLACES = {
  any: "どこでも",
  home: "家で",
  out: "外で",
} as const;
export type Place = keyof typeof PLACES;
export const PLACE_KEYS = Object.keys(PLACES) as [Place, ...Place[]];

export const VERDICTS = {
  continue: { label: "続ける", desc: "生活に残す。もう「挑戦」ではなく習慣に" },
  stop: { label: "やめる", desc: "試せたことに意味がある。合わなかった、も収穫" },
  modify: { label: "形を変える", desc: "量や頻度を変えて、もう30日" },
} as const;
export type Verdict = keyof typeof VERDICTS;
export const VERDICT_KEYS = Object.keys(VERDICTS) as [Verdict, ...Verdict[]];

/** Text length limits shared by the client forms and the API validation. */
export const LIMITS = {
  nickname: 16,
  challengeTitle: 30,
  note: 120,
  reflection: 140,
  recipeTitle: 30,
  recipeSummary: 80,
  recipeHowItem: 60,
  recipeHowItems: 5,
  recipeAfter: 200,
  story: 500,
  reportReason: 200,
  aiHint: 100,
  contactMessage: 1000,
  contactReplyTo: 100,
  /** Concurrent challenges that are not finished yet (waiting + active + ended-but-not-reflected). */
  openChallenges: 5,
  /** Max PNG size for a share card upload (bytes, decoded). */
  shareImageBytes: 600_000,
  /** Items in an imported backup. */
  importChallenges: 100,
} as const;

/** Per-user and global quotas (per JST day unless noted). Enforced server-side. */
export const QUOTAS = {
  /** ひらめき提案（AI は使わない。ADR 0003）. */
  suggestionsPerUserPerDay: 10,
  /**
   * New challenges (POST /api/challenges that actually creates; idempotent replays do not count).
   * Stops create → delete loops from inflating a recipe's startCount (the "人気" order).
   */
  challengesPerUserPerDay: 10,
  recipesPerUserPerDay: 5,
  storiesPerUserPerDay: 10,
  sharesPerUserPerDay: 10,
  reportsPerUserPerDay: 20,
  cheersPerUserPerDay: 100,
  contactPerUserPerDay: 3,
  sessionsPerIpPerHour: 20,
  transferCodesPerUserPerHour: 5,
  transferRedeemPerIpPerHour: 10,
  pushTestsPerUserPerDay: 5,
} as const;

/** A public item is hidden automatically when this many distinct users report it. */
export const AUTO_HIDE_REPORTS = 3;

/** Transfer codes (device hand-over) expire after this many minutes. */
export const TRANSFER_CODE_TTL_MINUTES = 15;

/** Reminder times are rounded to this many minutes (the scheduler runs on the same grid). */
export const REMINDER_STEP_MINUTES = 15;

export const DEFAULT_TIMEZONE = "Asia/Tokyo";
