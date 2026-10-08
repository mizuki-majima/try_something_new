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
  /** Challenges one account can hold in total (checked by backup import; excess items are skipped). */
  challengesPerUser: 200,
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
  /** Per client: an IPv4 address or an IPv6 /56 (a Japanese IPoE home gets a /56). */
  sessionsPerIpPerHour: 20,
  /**
   * Per network: an IPv4 /16 or an IPv6 /48 (what one actor can easily hold: a VPS range, a free
   * tunnel broker's /48 = 256 /56s). Keeps one network from using up the global ceiling (R11).
   */
  sessionsPerNetworkPerHour: 60,
  /**
   * New anonymous accounts per hour across ALL clients: a cost bound only (a session is a few writes),
   * far above real sign-ups. The API logs ALARMED_LOGS.sessionCeiling when it trips, and an alarm
   * mails the operator (R7, R11).
   */
  sessionsGlobalPerHour: 2000,
  /**
   * PATCH /api/me requests that change the nickname or shareProgress. Each one rewrites the user's
   * cohort projection, so it is bounded (cost: NF-1).
   */
  profileChangesPerUserPerDay: 10,
  transferCodesPerUserPerHour: 5,
  transferRedeemPerIpPerHour: 10,
  pushTestsPerUserPerDay: 5,
  /** POST /api/me/import (backup restore). */
  importsPerUserPerDay: 3,
  /**
   * Day notes turned from private to shown in 「みんな」 (#17). Turning one back to private is a
   * privacy action and is never counted (like R13), nor is showing one that is already shown.
   */
  noteShowsPerUserPerDay: 30,
} as const;

/**
 * A public item is hidden automatically when this many distinct users report it. Only reporters
 * whose account is REPORTER_MIN_ACCOUNT_AGE_HOURS old and holds a challenge count towards it, and
 * those reporters must come from at least AUTO_HIDE_MIN_NETWORKS different networks (an IPv4 /24
 * or an IPv6 /48), so one person's accounts on one connection cannot hide anything.
 */
export const AUTO_HIDE_REPORTS = 3;
export const REPORTER_MIN_ACCOUNT_AGE_HOURS = 24;
export const AUTO_HIDE_MIN_NETWORKS = 2;

/** Transfer codes (device hand-over) expire after this many minutes. */
export const TRANSFER_CODE_TTL_MINUTES = 15;

/** Reminder times are rounded to this many minutes (the scheduler runs on the same grid). */
export const REMINDER_STEP_MINUTES = 15;

export const DEFAULT_TIMEZONE = "Asia/Tokyo";
