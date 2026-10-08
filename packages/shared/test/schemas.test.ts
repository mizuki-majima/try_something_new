import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/constants";
import {
  ChallengeCreateSchema,
  MePatchSchema,
  NicknameSchema,
  NoteVisibilitySchema,
  PublicNoteSchema,
  SealSchema,
  StampPutSchema,
  StampSchema,
  TransferRedeemSchema,
  isPublicNote,
  rawTextLimit,
  text,
  textByteLimit,
} from "../src/schemas";
import { graphemesOverByteLimit, utf8Length } from "../src/text";

const FAMILY = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
const ZWSP = String.fromCodePoint(0x200b);

const messages = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? [] : (r.error?.issues ?? []).map((i) => i.message);

describe("text()", () => {
  const three = text({ max: 3, label: "テスト" });

  it("limits by graphemes, not UTF-16 code units", () => {
    expect(three.safeParse(`${FAMILY}${FAMILY}あ`).success).toBe(true);
    expect(messages(three.safeParse("あいうえ"))).toEqual(["テストは3文字以内で入力してください"]);
  });

  it("normalises before measuring", () => {
    expect(three.parse(`  あ${ZWSP}い  `)).toBe("あい");
    expect(messages(three.safeParse(`   ${ZWSP}`))).toEqual(["テストを入力してください"]);
  });

  it("has a minimum (1 by default, 0 allowed)", () => {
    expect(text({ min: 0, max: 3, label: "x" }).parse("")).toBe("");
    expect(messages(text({ min: 2, max: 3, label: "x" }).safeParse("あ"))).toEqual(["xは2文字以上で入力してください"]);
  });

  it("rejects URLs in public text when noUrl is set", () => {
    const pub = text({ max: 100, noUrl: true, label: "タイトル" });
    expect(messages(pub.safeParse("詳しくは example.com"))).toEqual(["タイトルにURLは入れられません"]);
    expect(text({ max: 100, label: "メモ" }).safeParse("詳しくは example.com").success).toBe(true);
  });

  it("keeps newlines only when multiline", () => {
    expect(text({ max: 20, multiline: true, label: "x" }).parse("1行目\n2行目")).toBe("1行目\n2行目");
    expect(text({ max: 20, label: "x" }).parse("1行目\n2行目")).toBe("1行目 2行目");
  });

  it("rejects absurdly long raw input early", () => {
    expect(three.safeParse("a".repeat(3 * 8 + 65)).success).toBe(false);
  });

  it("caps the raw UTF-16 length so one 'grapheme' of combining marks cannot store kilobytes", () => {
    // 'a' + 1023 × U+20DD is a single grapheme of 1024 code units (~3 KB of UTF-8).
    const fat = "a" + String.fromCodePoint(0x20dd).repeat(1023);
    const note = text({ min: 0, max: LIMITS.note, label: "ひとこと" });
    expect(note.safeParse(fat).success).toBe(false);
    expect(messages(note.safeParse(fat))).toEqual(["ひとことが長すぎます"]);
    expect(rawTextLimit(LIMITS.note)).toBe(LIMITS.note * 4 + 16);
    // Real text still fits: the maximum in kana, and emoji sequences within the byte cap.
    expect(note.safeParse("あ".repeat(LIMITS.note)).success).toBe(true);
    expect(text({ max: 8, label: "x" }).safeParse(FAMILY.repeat(3)).success).toBe(true);
  });

  it("caps the stored size in UTF-8 bytes (max × 4 + 32), not only graphemes and UTF-16 units (NF-1)", () => {
    const note = text({ min: 0, max: LIMITS.note, label: "ひとこと" });
    expect(textByteLimit(LIMITS.note)).toBe(LIMITS.note * 4 + 32);
    // Exactly at the raw UTF-16 cap (496 units), one grapheme, ~1.5 KB of UTF-8: refused.
    const fat = "a" + String.fromCodePoint(0x20dd).repeat(LIMITS.note * 4 + 15);
    expect(fat.length).toBe(rawTextLimit(LIMITS.note));
    expect(messages(note.safeParse(fat))).toEqual([tooBig("ひとこと", 1)]);
    // Ordinary text at the grapheme limit fits: Japanese is 3 bytes, a plain emoji 4.
    expect(note.safeParse("あ".repeat(LIMITS.note)).success).toBe(true);
    expect(note.safeParse(String.fromCodePoint(0x1f600).repeat(LIMITS.note)).success).toBe(true);
    // Heavy ZWJ sequences count by their bytes: 5 families (90 bytes) do not fit in max 8 (64 bytes).
    expect(messages(text({ max: 8, label: "x" }).safeParse(FAMILY.repeat(5)))).toEqual([tooBig("x", 2)]);
  });

  it("says how many characters to remove when the stored size is over (R14)", () => {
    const note = text({ min: 0, max: LIMITS.note, label: "ひとこと" });
    // 70 thumbs-up with a skin tone: 70 characters (within 120) but 560 bytes (over 512): 64 fit.
    const THUMB = String.fromCodePoint(0x1f44d, 0x1f3fd);
    expect(messages(note.safeParse(THUMB.repeat(70)))).toEqual([tooBig("ひとこと", 6)]); // before: no count
    expect(note.safeParse(THUMB.repeat(64)).success).toBe(true);
    // The raw-length cap (before normalising) keeps the plain message.
    expect(messages(note.safeParse("a" + String.fromCodePoint(0x20dd).repeat(1023)))).toEqual(["ひとことが長すぎます"]);
  });
});

/** The byte-cap message of text() (R14). */
const tooBig = (label: string, n: number) => `${label}が長すぎます（絵文字などが多いため、あと${n}文字減らしてください）`;

describe("graphemesOverByteLimit", () => {
  it("counts the characters to drop from the end so the rest fits in the byte limit", () => {
    expect(graphemesOverByteLimit("abc", 3)).toBe(0);
    expect(graphemesOverByteLimit("abcd", 3)).toBe(1);
    expect(graphemesOverByteLimit("あいう", 6)).toBe(1);
    expect(graphemesOverByteLimit(FAMILY.repeat(5), 64)).toBe(2);
    expect(graphemesOverByteLimit("a" + String.fromCodePoint(0x20dd).repeat(10), 5)).toBe(1);
    expect(graphemesOverByteLimit("", 0)).toBe(0);
  });
});

describe("utf8Length", () => {
  it("matches TextEncoder", () => {
    for (const s of ["", "abc", "あいう", "é", FAMILY, String.fromCodePoint(0x1f600), "a" + String.fromCodePoint(0x20dd).repeat(3), "\ud800x"]) {
      expect(utf8Length(s), JSON.stringify(s)).toBe(new TextEncoder().encode(s).length);
    }
  });
});

describe("field schemas", () => {
  it("nickname: 16 graphemes, no URL", () => {
    expect(NicknameSchema.parse(" みずき ")).toBe("みずき");
    expect(NicknameSchema.safeParse("あ".repeat(LIMITS.nickname)).success).toBe(true);
    expect(NicknameSchema.safeParse("あ".repeat(LIMITS.nickname + 1)).success).toBe(false);
    expect(NicknameSchema.safeParse("www.example").success).toBe(false);
  });

  it("seal: one character after trimming", () => {
    expect(SealSchema.parse(" 写 ")).toBe("写");
    expect(SealSchema.safeParse("写真").success).toBe(false);
  });

  it("stamp note may contain URLs (private) but is limited", () => {
    expect(StampPutSchema.parse({ note: "https://example.com を読んだ" }).note).toContain("https://");
    expect(StampPutSchema.safeParse({ note: "あ".repeat(LIMITS.note + 1) }).success).toBe(false);
  });

  it("challenge create validates id, date and public title", () => {
    const ok = { id: "abcdefghijkl0123", title: "毎日歩く", seal: "歩", startDate: "2026-11-01" };
    expect(ChallengeCreateSchema.safeParse(ok).success).toBe(true);
    expect(ChallengeCreateSchema.safeParse({ ...ok, id: "ABC" }).success).toBe(false);
    expect(ChallengeCreateSchema.safeParse({ ...ok, startDate: "2026-02-30" }).success).toBe(false);
    expect(ChallengeCreateSchema.safeParse({ ...ok, title: "http://spam" }).success).toBe(false);
  });

  it("transfer code: case-insensitive, separators ignored, exactly 8", () => {
    expect(TransferRedeemSchema.parse({ code: "abcd-efgh" }).code).toBe("ABCDEFGH");
    expect(TransferRedeemSchema.safeParse({ code: "abc" }).success).toBe(false);
  });

  it("me patch needs at least one field", () => {
    expect(MePatchSchema.safeParse({}).success).toBe(false);
    expect(MePatchSchema.safeParse({ shareProgress: false }).success).toBe(true);
    expect(MePatchSchema.safeParse({ reminder: { enabled: true, time: "24:00" } }).success).toBe(false);
  });
});

describe("day notes shown in みんな (#17)", () => {
  it("PublicNoteSchema / isPublicNote: no URL, not empty, within the length and byte caps", () => {
    expect(isPublicNote("きょうは10分歩いた")).toBe(true);
    expect(isPublicNote(`${FAMILY}と散歩`)).toBe(true);
    expect(isPublicNote("あ".repeat(LIMITS.note))).toBe(true);

    expect(isPublicNote("https://example.com を読んだ")).toBe(false);
    expect(isPublicNote("example.com を見た")).toBe(false);
    expect(messages(PublicNoteSchema.safeParse("www.example.jp"))).toEqual(["ひとことにURLは入れられません"]);
    expect(isPublicNote("")).toBe(false);
    expect(isPublicNote("   ")).toBe(false);
    expect(isPublicNote("あ".repeat(LIMITS.note + 1))).toBe(false);
    // 1 grapheme of combining marks: within 120 characters, over the UTF-8 cap.
    const fat = "a" + String.fromCodePoint(0x20dd).repeat(LIMITS.note * 4 + 15);
    expect(isPublicNote(fat)).toBe(false);
    expect(isPublicNote(String.fromCodePoint(0x1f44d, 0x1f3fd).repeat(70))).toBe(false);
    expect(isPublicNote(undefined)).toBe(false);
    expect(isPublicNote(42)).toBe(false);
  });

  it("isPublicNote refuses a note that normalising would change (stored before today's rules)", () => {
    expect(PublicNoteSchema.safeParse("  前後に空白  ").success).toBe(true);
    expect(isPublicNote("  前後に空白  ")).toBe(false);
    expect(isPublicNote(`見え${ZWSP}ない`)).toBe(false);
    expect(isPublicNote("1行目\n2行目")).toBe(false);
    expect(isPublicNote("前後に空白")).toBe(true);
  });

  it("a private stamp note may still contain a URL (StampPutSchema is unchanged)", () => {
    expect(StampPutSchema.parse({ note: "https://example.com を読んだ" }).note).toBe("https://example.com を読んだ");
    // Saving a stamp cannot show it: there is no field for that.
    expect(StampPutSchema.parse({ note: "メモ", shown: true, shownNote: "メモ" })).toEqual({ note: "メモ" });
  });

  it("NoteVisibilitySchema accepts only { show: true, note } and { show: false }", () => {
    expect(NoteVisibilitySchema.parse({ show: true, note: "見せる" })).toEqual({ show: true, note: "見せる" });
    expect(NoteVisibilitySchema.parse({ show: false })).toEqual({ show: false });
    expect(NoteVisibilitySchema.parse({ show: false, note: "x" })).toEqual({ show: false });
    for (const bad of [
      {},
      { show: true },
      { show: true, note: "" },
      { show: true, note: 1 },
      { show: true, note: "あ".repeat(rawTextLimit(LIMITS.note) + 1) },
      { show: "true", note: "x" },
      { show: 1 },
      { note: "x" },
      null,
      "show",
    ]) {
      expect(NoteVisibilitySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("StampSchema: `shown` is an optional boolean (the owner view)", () => {
    expect(StampSchema.parse({ at: 1, note: "x", shown: true })).toEqual({ at: 1, note: "x", shown: true });
    expect(StampSchema.parse({ at: 1, note: "x" })).toEqual({ at: 1, note: "x" });
    expect(StampSchema.parse({ at: 1, note: "x", shownNote: "x" })).toEqual({ at: 1, note: "x" });
    expect(StampSchema.safeParse({ at: 1, shown: "yes" }).success).toBe(false);
  });
});
