import { describe, expect, it } from "vitest";
import { cleanLine, cleanText, containsUrl, firstGrapheme, graphemeLength, isValidSeal } from "../src/text";

// Built from code points so this file stays plain ASCII.
const ZWSP = String.fromCodePoint(0x200b);
const RLO = String.fromCodePoint(0x202e);
const BOM = String.fromCodePoint(0xfeff);
const BELL = String.fromCodePoint(0x07);
const FAMILY = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
const THUMBS_TONE = String.fromCodePoint(0x1f44d, 0x1f3fd);
const ZWJ = String.fromCodePoint(0x200d);

describe("cleanText", () => {
  it("trims and removes control, zero-width and bidi override characters", () => {
    expect(cleanText(`  a${ZWSP}b${RLO}c${BOM}d${BELL}  `)).toBe("abcd");
  });

  it("normalises newlines and keeps at most one blank line", () => {
    expect(cleanText("1\r\n2\r3\n\n\n\n4")).toBe("1\n2\n3\n\n4");
  });

  it("keeps tabs and ordinary text", () => {
    expect(cleanText("毎日\t歩く")).toBe("毎日\t歩く");
  });

  it("keeps emoji ZWJ sequences intact", () => {
    expect(cleanText(` ${FAMILY} `)).toBe(FAMILY);
    expect(graphemeLength(cleanText(FAMILY))).toBe(1);
  });
});

describe("cleanLine", () => {
  it("turns newlines into single spaces", () => {
    expect(cleanLine(" 3行\n\n 日記 \n ")).toBe("3行 日記");
  });
});

describe("graphemeLength / firstGrapheme", () => {
  it("counts user-perceived characters", () => {
    expect(graphemeLength("写")).toBe(1);
    expect(graphemeLength(FAMILY)).toBe(1);
    expect(graphemeLength(`${THUMBS_TONE}あa`)).toBe(3);
    expect(firstGrapheme(` ${FAMILY}x`)).toBe(FAMILY);
  });
});

describe("isValidSeal", () => {
  it("accepts exactly one visible character", () => {
    expect(isValidSeal("写")).toBe(true);
    expect(isValidSeal("A")).toBe(true);
    expect(isValidSeal("7")).toBe(true);
    expect(isValidSeal(FAMILY)).toBe(true);
  });

  it("rejects empty, several characters, whitespace and ASCII punctuation", () => {
    expect(isValidSeal("")).toBe(false);
    expect(isValidSeal("写真")).toBe(false);
    expect(isValidSeal(" ")).toBe(false);
    expect(isValidSeal("!")).toBe(false);
    expect(isValidSeal("<")).toBe(false);
  });
});

describe("containsUrl", () => {
  it("finds links in many shapes", () => {
    expect(containsUrl("見て https://example.org/x")).toBe(true);
    expect(containsUrl("HTTP://EXAMPLE.ORG")).toBe(true);
    expect(containsUrl("www.example")).toBe(true);
    expect(containsUrl("example.com")).toBe(true);
    expect(containsUrl("spam.xyz で")).toBe(true);
    expect(containsUrl(`example${ZWJ}.com`)).toBe(true);
  });

  it("leaves ordinary text alone", () => {
    expect(containsUrl("毎日20分歩く")).toBe(false);
    expect(containsUrl("1.5L の水")).toBe(false);
    expect(containsUrl("3.14")).toBe(false);
  });
});
