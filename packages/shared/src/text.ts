/** Text normalisation and checks shared by client forms and API validation. */

// Control characters, zero-width characters and bidi overrides, built from code points so the
// source stays plain ASCII: C0 controls (except \t \n \r), DEL, U+200B-U+200F, U+202A-U+202E, U+2066-U+2069, U+FEFF.
const CONTROL_RANGES: [number, number][] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x7f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];
const hex = (n: number) => "\\u" + n.toString(16).padStart(4, "0");
const CONTROL_RE = new RegExp("[" + CONTROL_RANGES.map(([a, b]) => (a === b ? hex(a) : hex(a) + "-" + hex(b))).join("") + "]", "g");

/** Trim, drop control / bidi-override characters, normalise newlines. Keeps single newlines. */
export function cleanText(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(CONTROL_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Single-line variant: newlines become spaces. */
export function cleanLine(s: string): string {
  return cleanText(s).replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ");
}

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("ja", { granularity: "grapheme" }) : null;

/** Number of user-perceived characters (grapheme clusters). */
export function graphemeLength(s: string): number {
  if (!segmenter) return Array.from(s).length;
  let n = 0;
  for (const _ of segmenter.segment(s)) n++;
  return n;
}

/** A seal (印) is exactly one visible character that is not whitespace or punctuation-only ASCII. */
export function isValidSeal(s: string): boolean {
  if (graphemeLength(s) !== 1) return false;
  if (/^\s$/u.test(s)) return false;
  if (s.length === 1 && s.charCodeAt(0) < 0x80 && !/^[0-9A-Za-z]$/.test(s)) return false;
  return true;
}

/** Public text must not carry links (spam). Private notes may. */
export function containsUrl(s: string): boolean {
  return /(https?:\/\/|www\.|[a-z0-9-]+\.(com|net|org|jp|io|xyz|info|biz|ly|me|co)\b)/i.test(s);
}

/** First grapheme of a string, used as the default seal. */
export function firstGrapheme(s: string): string {
  if (!segmenter) return Array.from(s)[0] ?? "";
  for (const seg of segmenter.segment(s.trim())) return seg.segment;
  return "";
}
