/**
 * Minimal PNG checks for uploaded share cards (SPEC Security: "PNG のシグネチャと 1200×630 を検証").
 * The image is never decoded; we only make sure the bytes are a well-formed PNG container
 * (signature, IHDR first with a valid CRC, chunk lengths that add up, IDAT present, IEND last)
 * of the expected size, so the media bucket only ever serves what it claims to serve.
 */
import { crc32 } from "node:zlib";

export const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Size of the card the client renders (docs/design.md "シェア用カード"). */
export const SHARE_CARD_WIDTH = 1200;
export const SHARE_CARD_HEIGHT = 630;

export type PngInfo = { width: number; height: number; bitDepth: number; colorType: number };

export type PngCheck = { ok: true; info: PngInfo } | { ok: false; reason: string };

const VALID_BIT_DEPTHS: Record<number, number[]> = {
  0: [1, 2, 4, 8, 16], // grayscale
  2: [8, 16], // RGB
  3: [1, 2, 4, 8], // palette
  4: [8, 16], // grayscale + alpha
  6: [8, 16], // RGBA
};

/** Upper bound on chunks we are willing to walk (a 600KB file has a few dozen in practice). */
const MAX_CHUNKS = 10_000;

function u32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

function chunkType(bytes: Uint8Array, offset: number): string | null {
  let s = "";
  for (let i = 0; i < 4; i++) {
    const b = bytes[offset + i]!;
    const letter = (b >= 65 && b <= 90) || (b >= 97 && b <= 122);
    if (!letter) return null;
    s += String.fromCharCode(b);
  }
  return s;
}

/** Structural check of a PNG file. Does not decompress image data. */
export function checkPng(bytes: Uint8Array): PngCheck {
  if (bytes.length < PNG_SIGNATURE.length + 25 + 12) return { ok: false, reason: "too_short" };
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return { ok: false, reason: "signature" };
  }

  let offset = PNG_SIGNATURE.length;
  let info: PngInfo | null = null;
  let sawIdat = false;
  for (let n = 0; n < MAX_CHUNKS; n++) {
    if (offset + 12 > bytes.length) return { ok: false, reason: "truncated" };
    const length = u32(bytes, offset);
    const type = chunkType(bytes, offset + 4);
    if (type === null) return { ok: false, reason: "chunk_type" };
    const end = offset + 12 + length;
    if (end > bytes.length) return { ok: false, reason: "truncated" };

    if (n === 0) {
      if (type !== "IHDR" || length !== 13) return { ok: false, reason: "ihdr_first" };
      const data = bytes.subarray(offset + 8, offset + 8 + 13);
      const crc = u32(bytes, offset + 8 + 13);
      if (crc32(bytes.subarray(offset + 4, offset + 8 + 13)) !== crc) return { ok: false, reason: "ihdr_crc" };
      info = { width: u32(data, 0), height: u32(data, 4), bitDepth: data[8]!, colorType: data[9]! };
      if (!(VALID_BIT_DEPTHS[info.colorType] ?? []).includes(info.bitDepth)) return { ok: false, reason: "ihdr_format" };
      if (data[10] !== 0 || data[11] !== 0 || (data[12] !== 0 && data[12] !== 1)) return { ok: false, reason: "ihdr_format" };
    } else if (type === "IHDR") {
      return { ok: false, reason: "ihdr_twice" };
    } else if (type === "IDAT") {
      sawIdat = true;
    } else if (type === "IEND") {
      if (end !== bytes.length) return { ok: false, reason: "trailing_data" };
      if (!sawIdat || !info) return { ok: false, reason: "no_idat" };
      return { ok: true, info };
    }
    offset = end;
  }
  return { ok: false, reason: "too_many_chunks" };
}

/** A share card: a well-formed PNG of exactly 1200x630. */
export function isShareCardPng(bytes: Uint8Array): boolean {
  const res = checkPng(bytes);
  return res.ok && res.info.width === SHARE_CARD_WIDTH && res.info.height === SHARE_CARD_HEIGHT;
}

/**
 * Strict base64 (standard alphabet, padded, canonical). Returns null for anything else,
 * including data: URLs, whitespace, base64url and non-zero padding bits.
 */
export function decodeBase64Strict(s: string): Uint8Array | null {
  if (s.length === 0 || s.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  const buf = Buffer.from(s, "base64");
  if (buf.toString("base64") !== s) return null;
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
