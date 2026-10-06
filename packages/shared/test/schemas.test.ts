import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/constants";
import {
  ChallengeCreateSchema,
  MePatchSchema,
  NicknameSchema,
  SealSchema,
  StampPutSchema,
  TransferRedeemSchema,
  text,
} from "../src/schemas";

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
