/**
 * API contract shared by the web client and the API. Request schemas normalise text
 * (trim, strip control characters) and enforce the limits in LIMITS; the API re-validates
 * everything it receives, the client uses the same schemas for form errors.
 */
import { z } from "zod";
import { CATEGORY_KEYS, LIMITS, PLACE_KEYS, TOTAL_DAYS, VERDICT_KEYS } from "./constants";
import { isValidDate, isValidTimeZone } from "./dates";
import { cleanLine, cleanText, containsUrl, graphemeLength, graphemesOverByteLimit, isValidSeal, utf8Length } from "./text";

// ---------- primitives ----------

export const ID_RE = /^[0-9a-z]{12,32}$/;
export const IdSchema = z.string().regex(ID_RE, "IDの形式が正しくありません");

/** Recipe IDs: community recipes use generated IDs, official ones use readable slugs ("photo"). */
export const RecipeIdSchema = z.string().regex(/^[0-9a-z][0-9a-z-]{1,40}$/, "レシピIDの形式が正しくありません");

export const DateSchema = z.string().refine(isValidDate, "日付の形式が正しくありません");
export const TimeZoneSchema = z.string().refine(isValidTimeZone, "タイムゾーンが正しくありません");
export const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "時刻は HH:MM で入力してください");
export const CategorySchema = z.enum(CATEGORY_KEYS);
export const PlaceSchema = z.enum(PLACE_KEYS);
export const VerdictSchema = z.enum(VERDICT_KEYS);
export const DifficultySchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export const DaySchema = z.coerce.number().int().min(1).max(TOTAL_DAYS);

type TextOpts = { min?: number; max: number; multiline?: boolean; noUrl?: boolean; label: string };

/**
 * Raw UTF-16 length allowed before normalisation: room for emoji sequences (a few code units per
 * grapheme) but not for one "grapheme" made of hundreds of combining marks.
 */
export const rawTextLimit = (max: number) => max * 4 + 16;

/**
 * Stored size cap in UTF-8 bytes (cost: what DynamoDB stores and bills). Japanese is 3 bytes a
 * character and most emoji 4, so `max` ordinary characters always fit; one "character" stuffed with
 * combining marks (1 grapheme, ~1.5 KB) does not.
 */
export const textByteLimit = (max: number) => max * 4 + 32;

/**
 * Normalised text with a grapheme-based length check, a UTF-16 cap on the raw input (rawTextLimit)
 * and a UTF-8 byte cap on what is stored (textByteLimit). Over the byte cap the message says how many
 * characters to remove (R14): the text is within `max` characters, so heavy emoji are the cause.
 */
export function text({ min = 1, max, multiline = false, noUrl = false, label }: TextOpts) {
  return z
    .string()
    .max(rawTextLimit(max), `${label}が長すぎます`)
    .transform((s) => (multiline ? cleanText(s) : cleanLine(s)))
    .superRefine((s, ctx) => {
      const n = graphemeLength(s);
      if (n < min) ctx.addIssue({ code: "custom", message: min === 1 ? `${label}を入力してください` : `${label}は${min}文字以上で入力してください` });
      if (n > max) ctx.addIssue({ code: "custom", message: `${label}は${max}文字以内で入力してください` });
      else if (utf8Length(s) > textByteLimit(max)) {
        const over = graphemesOverByteLimit(s, textByteLimit(max));
        ctx.addIssue({ code: "custom", message: `${label}が長すぎます（絵文字などが多いため、あと${over}文字減らしてください）` });
      }
      if (noUrl && containsUrl(s)) ctx.addIssue({ code: "custom", message: `${label}にURLは入れられません` });
    });
}

export const SealSchema = z
  .string()
  .max(32)
  .transform((s) => s.trim())
  .refine(isValidSeal, "印は1文字で入力してください");

export const NicknameSchema = text({ max: LIMITS.nickname, noUrl: true, label: "ニックネーム" });

// ---------- users & sessions ----------

export const ReminderSchema = z.object({
  enabled: z.boolean(),
  time: TimeSchema,
});
export type Reminder = z.infer<typeof ReminderSchema>;

export const UserSchema = z.object({
  id: IdSchema,
  nickname: z.string(),
  tz: z.string(),
  shareProgress: z.boolean(),
  reminder: ReminderSchema,
  createdAt: z.number(),
});
export type User = z.infer<typeof UserSchema>;

export const SessionCreateSchema = z.object({
  nickname: NicknameSchema.optional(),
  tz: TimeZoneSchema,
});
export type SessionCreate = z.input<typeof SessionCreateSchema>;

export type SessionResponse = { token: string; user: User };

export const MePatchSchema = z
  .object({
    nickname: NicknameSchema.optional(),
    tz: TimeZoneSchema.optional(),
    shareProgress: z.boolean().optional(),
    reminder: ReminderSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "変更する項目がありません");
export type MePatch = z.input<typeof MePatchSchema>;

export type MeResponse = { user: User; today: string };

export type TransferCodeResponse = { code: string; expiresAt: number };
export const TransferRedeemSchema = z.object({
  code: z
    .string()
    .max(32)
    .transform((s) => s.toUpperCase().replace(/[^0-9A-Z]/g, ""))
    .pipe(z.string().regex(/^[0-9A-Z]{8}$/, "引き継ぎコードは8文字です")),
});

// ---------- challenges ----------

export const StampSchema = z.object({
  at: z.number(),
  note: z.string().optional(),
  /**
   * Owner view only, sent only as true: the owner chose to show this day's note in 「みんな」 (#17)
   * and it still holds the text they chose. Absent means private.
   */
  shown: z.boolean().optional(),
});
export type Stamp = z.infer<typeof StampSchema>;

export const ChallengeSchema = z.object({
  id: IdSchema,
  recipeId: z.string().nullable(),
  title: z.string(),
  seal: z.string(),
  startDate: DateSchema,
  status: z.enum(["active", "done"]),
  /** Keyed by day number "1".."30". */
  stamps: z.record(z.string(), StampSchema),
  verdict: VerdictSchema.nullable(),
  reflection: z.string().nullable(),
  finishedAt: z.number().nullable(),
  /** Day number on which the challenge was closed (30, or earlier with "ここで区切る"). */
  finishedDay: z.number().nullable(),
  cheers: z.number(),
  shareId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Challenge = z.infer<typeof ChallengeSchema>;

export const ChallengeCreateSchema = z.object({
  /** Client-generated so an offline create can be replayed safely. */
  id: IdSchema,
  recipeId: RecipeIdSchema.nullable().optional(),
  title: text({ max: LIMITS.challengeTitle, noUrl: true, label: "チャレンジ名" }),
  seal: SealSchema,
  startDate: DateSchema,
});
export type ChallengeCreate = z.input<typeof ChallengeCreateSchema>;

export const ChallengePatchSchema = z
  .object({
    title: text({ max: LIMITS.challengeTitle, noUrl: true, label: "チャレンジ名" }).optional(),
    seal: SealSchema.optional(),
    /** Only while the challenge has not started yet (move a reservation / start today instead). */
    startDate: DateSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "変更する項目がありません");
export type ChallengePatch = z.input<typeof ChallengePatchSchema>;

/** Saving a stamp never shows its note: only PUT .../visibility does (#17). */
export const StampPutSchema = z.object({
  note: text({ min: 0, max: LIMITS.note, label: "ひとこと" }).optional(),
});
export type StampPut = z.input<typeof StampPutSchema>;

/**
 * A day note that may be shown in 「みんな」 (#17): the public-text rules (no URL, length and UTF-8
 * caps). A private note may break them (a URL is fine there).
 */
export const PublicNoteSchema = text({ min: 1, max: LIMITS.note, noUrl: true, label: "ひとこと" });

/** Passes PublicNoteSchema and is already in its normalised form (normalising leaves it unchanged). */
export function isPublicNote(t: unknown): t is string {
  if (typeof t !== "string") return false;
  const r = PublicNoteSchema.safeParse(t);
  return r.success && r.data === t;
}

/**
 * PUT .../stamps/:day/visibility. Showing names the exact text the owner saw (the server refuses it
 * when the stored note differs); hiding needs nothing.
 */
export const NoteVisibilitySchema = z.discriminatedUnion("show", [
  z.object({ show: z.literal(true), note: z.string().min(1).max(rawTextLimit(LIMITS.note)) }),
  z.object({ show: z.literal(false) }),
]);
export type NoteVisibility = z.input<typeof NoteVisibilitySchema>;

export const ReflectSchema = z.object({
  verdict: VerdictSchema,
  reflection: text({ min: 0, max: LIMITS.reflection, multiline: true, noUrl: true, label: "ひとこと" }).optional(),
});
export type Reflect = z.input<typeof ReflectSchema>;

export type ChallengeListResponse = { challenges: Challenge[]; today: string };
export type ChallengeResponse = { challenge: Challenge };

// ---------- cohorts ("1日組") ----------

export type CohortMember = {
  challengeId: string;
  nickname: string;
  seal: string;
  title: string;
  recipeId: string | null;
  startDate: string;
  stampDays: number[];
  done: boolean;
  verdict: z.infer<typeof VerdictSchema> | null;
  cheers: number;
  cheeredToday: boolean;
  isMine: boolean;
  updatedAt: number;
  /**
   * How many day notes the owner shows (#17); the text is fetched with GET /api/members/:id/notes.
   * Sent only when > 0; optional so a client tolerates an older API during a deploy.
   */
  shownNoteCount?: number;
};
export type CohortResponse = { month: string; members: CohortMember[] };
/** A day note the owner chose to show, by day number (1..30). */
export type MemberNote = { day: number; note: string };
/** GET /api/members/:challengeId/notes: the notes shown in 「みんな」, by day ascending. */
export type MemberNotesResponse = { challengeId: string; notes: MemberNote[] };
export type UpcomingResponse = {
  startDate: string;
  /** Reservations (challenges), not people: one person may reserve several. */
  count: number;
  /**
   * Distinct people among those reservations (counted on the server; no ids leave it). Always sent by
   * this API; optional only so a client tolerates an older API during a deploy.
   */
  peopleCount?: number;
  byRecipe: { recipeId: string | null; title: string; seal: string; count: number }[];
};
export type CheerResponse = { cheers: number; cheeredToday: true };

// ---------- recipes & stories ----------

export const OfficialRecipeSchema = z.object({
  id: z.string(),
  seal: z.string(),
  title: z.string(),
  category: CategorySchema,
  minutes: z.number(),
  place: PlaceSchema,
  difficulty: DifficultySchema,
  summary: z.string(),
  how: z.array(z.string()),
  after: z.string(),
});
export type OfficialRecipe = z.infer<typeof OfficialRecipeSchema>;

export type Recipe = OfficialRecipe & {
  source: "official" | "community";
  authorName: string | null;
  isMine: boolean;
  featured: boolean;
  startCount: number;
  storyCount: number;
  createdAt: number | null;
};

export const RecipeInputSchema = z.object({
  seal: SealSchema,
  title: text({ max: LIMITS.recipeTitle, noUrl: true, label: "タイトル" }),
  category: CategorySchema,
  minutes: z.coerce.number().int().min(0).max(180),
  place: PlaceSchema,
  difficulty: z.coerce.number().pipe(DifficultySchema),
  summary: text({ max: LIMITS.recipeSummary, noUrl: true, label: "何をするか" }),
  how: z
    .array(text({ max: LIMITS.recipeHowItem, noUrl: true, label: "コツ" }))
    .max(LIMITS.recipeHowItems, `コツは${LIMITS.recipeHowItems}個までです`),
  after: text({ min: 0, max: LIMITS.recipeAfter, multiline: true, noUrl: true, label: "30日後" }),
  authorName: NicknameSchema.optional(),
});
export type RecipeInput = z.input<typeof RecipeInputSchema>;

export type Story = {
  id: string;
  recipeId: string;
  authorName: string;
  body: string;
  days: number | null;
  verdict: z.infer<typeof VerdictSchema> | null;
  createdAt: number;
  isMine: boolean;
};

export const StoryInputSchema = z.object({
  body: text({ max: LIMITS.story, multiline: true, noUrl: true, label: "体験談" }),
  authorName: NicknameSchema.optional(),
  days: z.coerce.number().int().min(0).max(TOTAL_DAYS).nullable().optional(),
  verdict: VerdictSchema.nullable().optional(),
});
export type StoryInput = z.input<typeof StoryInputSchema>;

export type RecipeListResponse = { recipes: Recipe[] };
export type RecipeDetailResponse = { recipe: Recipe; stories: Story[] };

// ---------- ひらめき提案 (rule-based, no generative AI — ADR 0003) ----------

export const SuggestRequestSchema = z.object({
  maxMinutes: z.coerce.number().int().min(0).max(180).optional(),
  category: CategorySchema.optional(),
  place: PlaceSchema.optional(),
  hint: text({ min: 0, max: LIMITS.aiHint, noUrl: true, label: "ひとこと" }).optional(),
});
export type SuggestRequest = z.input<typeof SuggestRequestSchema>;

/** One suggestion. The provider output is validated against this before it reaches the client. */
export const SuggestionSchema = z.object({
  seal: SealSchema,
  title: text({ max: LIMITS.recipeTitle, noUrl: true, label: "タイトル" }),
  category: CategorySchema,
  minutes: z.coerce.number().int().min(0).max(180),
  place: PlaceSchema,
  difficulty: z.coerce.number().pipe(DifficultySchema),
  summary: text({ max: LIMITS.recipeSummary, noUrl: true, label: "何をするか" }),
  how: z.array(text({ max: LIMITS.recipeHowItem, noUrl: true, label: "コツ" })).min(1).max(LIMITS.recipeHowItems),
  after: text({ min: 0, max: LIMITS.recipeAfter, multiline: true, noUrl: true, label: "30日後" }),
});
export type Suggestion = z.output<typeof SuggestionSchema>;
export type SuggestResponse = { suggestions: Suggestion[]; remainingToday: number };

// ---------- share cards ----------

export const ShareCreateSchema = z.object({
  challengeId: IdSchema,
  /** PNG, base64 (no data: prefix). 1200x630. */
  imageBase64: z.string().min(100).max(Math.ceil((LIMITS.shareImageBytes * 4) / 3) + 8),
});
export type ShareCreate = z.input<typeof ShareCreateSchema>;
export type ShareResponse = { id: string; url: string; imageUrl: string };

/** Which share action was used (counted in STATS only; no user id, no content). */
export const ShareMetricSchema = z.object({
  channel: z.enum(["link", "image", "webshare", "x", "line", "copy"]),
});
export type ShareMetric = z.input<typeof ShareMetricSchema>;

// ---------- push reminders ----------

export const PushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({
    p256dh: z.string().min(16).max(200),
    auth: z.string().min(8).max(100),
  }),
});
export type PushSubscriptionInput = z.input<typeof PushSubscriptionSchema>;
export const PushUnsubscribeSchema = z.object({ endpoint: z.string().url().max(1000) });
export type PushPublicKeyResponse = { publicKey: string | null };

// ---------- moderation & contact ----------

export const ReportTargetTypeSchema = z.enum(["recipe", "story", "share", "member"]);
export type ReportTargetType = z.infer<typeof ReportTargetTypeSchema>;
export const ReportCreateSchema = z.object({
  targetType: ReportTargetTypeSchema,
  /** recipe: recipeId / story: "<recipeId>:<storyId>" / share: shareId / member: challengeId */
  targetId: z.string().min(1).max(80),
  reason: text({ min: 0, max: LIMITS.reportReason, multiline: true, label: "理由" }).optional(),
});
export type ReportCreate = z.input<typeof ReportCreateSchema>;

export const ContactCreateSchema = z.object({
  message: text({ max: LIMITS.contactMessage, multiline: true, label: "お問い合わせ内容" }),
  replyTo: text({ min: 0, max: LIMITS.contactReplyTo, label: "返信先" }).optional(),
});
export type ContactCreate = z.input<typeof ContactCreateSchema>;

export const AdminModerateSchema = z.object({
  targetType: ReportTargetTypeSchema,
  targetId: z.string().min(1).max(80),
  action: z.enum(["hide", "restore", "delete"]),
});
export type AdminModerate = z.input<typeof AdminModerateSchema>;

export const AdminRecipePatchSchema = z.object({ featured: z.boolean() });

export type AdminReportItem = {
  targetType: ReportTargetType;
  targetId: string;
  count: number;
  reasons: string[];
  lastAt: number;
  status: "published" | "hidden" | "deleted";
  preview: string;
};
export type AdminReportsResponse = { items: AdminReportItem[] };
export type AdminContactItem = { id: string; message: string; replyTo: string | null; createdAt: number };
export type AdminContactsResponse = { items: AdminContactItem[] };
/**
 * PILOT metrics (docs/validation-plan.md), counted per PERSON from the challenges that exist now
 * (deleted ones drop out; imported ones do not count). "Today" is the JST date; a reservation whose
 * start date has not come yet is not counted.
 */
export type PilotStats = {
  /** People with at least one challenge whose start date has come (開始した人; the 完走 denominator). */
  starters: number;
  /** Starters whose first started challenge is on day 8 or later (day 7 has passed): the 7日継続 denominator. */
  eligible7: number;
  /** Of eligible7, people with any challenge that has 5 or more stamps within days 1–7. */
  retained7: number;
  /** People with at least one reflected (done) challenge: the 完走 numerator and the 共有 denominator. */
  reflected: number;
  /** People with at least one done challenge that currently has a public card: the 共有 numerator. */
  sharers: number;
  /**
   * true when the scan stopped before the end of the table (after 20 seconds, or at its cap): the
   * numbers count only the challenges read so far (R15). Absent when complete.
   */
  partial?: boolean;
};

export type AdminStats = {
  users: number;
  challengesStarted: number;
  challengesDone: number;
  verdicts: Record<z.infer<typeof VerdictSchema>, number>;
  communityRecipes: number;
  stories: number;
  shares: number;
  /** Share actions by channel (from POST /api/metrics/share). */
  shareActions: Record<string, number>;
  suggestionsToday: number;
  pushSubscriptions: number;
  pilot: PilotStats;
};

// ---------- backup ----------

export const BackupFileSchema = z.object({
  format: z.literal("thirty-days-backup"),
  version: z.literal(1),
  exportedAt: z.number(),
  user: z.object({
    nickname: z.string(),
    shareProgress: z.boolean(),
    reminder: ReminderSchema,
  }),
  challenges: z.array(ChallengeSchema).max(LIMITS.importChallenges),
});
export type BackupFile = z.infer<typeof BackupFileSchema>;
/**
 * `notesDropped` (only when > 0): day notes that break today's text rules (e.g. a backup written
 * before the UTF-8 cap) were left out; their stamps and the challenge were kept (R14).
 */
export type ImportResponse = { imported: number; skipped: number; notesDropped?: number };

// ---------- errors ----------

export const ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "payload_too_large",
  "unsupported_media_type",
  "ai_unavailable",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export type ApiError = { error: { code: ErrorCode; message: string; fields?: Record<string, string> } };
