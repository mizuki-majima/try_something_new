/**
 * The 1200×630 reflection card (FR-7, docs/design.md "シェア用カード"): cream grid paper, a white
 * card with a thick ink border and a hard 12px shadow, a big seal on the left with the verdict
 * sticker slapped on it and the "23 / 30" count, the title, the 30 cells and the ひとこと on the
 * right, and the 「30日だけ」 logo bottom right.
 *
 * Layout is computed by pure functions (computeCardLayout, wrapText, fitTitle …) that only need a
 * text-measuring function, so they are unit-tested without a canvas. drawCard() just paints a
 * layout; renderShareCard() wires fonts + canvas + PNG.
 */
import { TOTAL_DAYS, VERDICTS, jpPeriod, type Challenge, type Verdict } from "@thirty/shared";
import { stampedDays } from "../../lib/challenge";
import { FONT_STACKS, loadFonts } from "../../lib/fonts";

export const CARD_W = 1200;
export const CARD_H = 630;

/** Light-theme colours from docs/design.md (the card is always light). */
export const CARD_COLORS = {
  bg: "#FFF4D6",
  grid: "rgba(17, 17, 17, 0.08)",
  surface: "#FFFFFF",
  ink: "#111111",
  muted: "#4A4A4A",
  shu: "#FF4B2B",
  yellow: "#FFD43B",
  mint: "#3DDC97",
  blue: "#6C8CFF",
  gray: "#E6E1D3",
  onAccent: "#111111",
} as const;

export const VERDICT_COLORS: Record<Verdict, string> = {
  continue: CARD_COLORS.mint,
  stop: CARD_COLORS.gray,
  modify: CARD_COLORS.blue,
};

/** Dela Gothic One for display/numbers/seals, Zen Kaku Gothic New for text. */
export const CARD_FONTS = {
  display: FONT_STACKS.num,
  body: FONT_STACKS.body,
} as const;

export type ShareCardData = {
  title: string;
  seal: string;
  verdict: Verdict | null;
  stampedDays: number[];
  count: number;
  /** Closing day (cells after it are hatched); 30 for a full run. */
  lastDay: number;
  reflection: string;
  period: string;
};

export function shareCardData(c: Challenge): ShareCardData {
  const days = stampedDays(c);
  return {
    title: c.title,
    seal: c.seal,
    verdict: c.verdict,
    stampedDays: days,
    count: days.length,
    lastDay: Math.max(1, Math.min(TOTAL_DAYS, c.finishedDay ?? TOTAL_DAYS)),
    reflection: c.reflection ?? "",
    period: jpPeriod(c.startDate),
  };
}

/** Screen-reader description of the image. */
export function shareCardAlt(d: ShareCardData): string {
  const verdict = d.verdict ? `判定「${VERDICTS[d.verdict].label}」。` : "";
  const reflection = d.reflection ? `ひとこと「${d.reflection}」` : "";
  return `「${d.title}」の30日カード。印「${d.seal}」、${d.period}、${d.count}/30日押した。${verdict}${reflection}`;
}

// ---------- text layout (pure) ----------

/** Width of `text` drawn with the CSS `font` shorthand. */
export type Measure = (font: string, text: string) => number;

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("ja", { granularity: "grapheme" }) : null;

export function graphemes(s: string): string[] {
  if (!segmenter) return Array.from(s);
  return Array.from(segmenter.segment(s), (x) => x.segment);
}

/** Characters that must not start a line (kinsoku): they hang on the previous line instead. */
const NO_LINE_START = new Set(Array.from("、。，．,.・：:；;？?！!ー－）)」』】〕〉》］]｝}’”…‥ゝゞヽヾぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ％%"));
/** Characters that must not end a line: they move to the next line with what follows. */
const NO_LINE_END = new Set(Array.from("（(「『【〔〈《［[｛{‘“"));
const WORD_CHAR = /^[0-9A-Za-z'_-]$/;

export const ELLIPSIS = "…";

function shorten(line: string, maxWidth: number, width: (s: string) => number): string {
  const g = graphemes(line);
  while (g.length > 0 && width(g.join("") + ELLIPSIS) > maxWidth) g.pop();
  return g.join("") + ELLIPSIS;
}

/**
 * Greedy line breaking by graphemes (so emoji and combining marks never split), with simple
 * Japanese kinsoku and without breaking inside Latin words when a space is available.
 * Newlines in the text start new lines. Lines beyond maxLines are cut and the last one ends in "…".
 */
export function wrapText(
  text: string,
  maxWidth: number,
  width: (s: string) => number,
  maxLines = Number.POSITIVE_INFINITY,
): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    let cur: string[] = [];
    for (const g of graphemes(paragraph)) {
      if (cur.length === 0 && g === " ") continue;
      if (cur.length > 0 && width(cur.join("") + g) > maxWidth) {
        if (NO_LINE_START.has(g)) {
          cur.push(g); // hang punctuation
          lines.push(cur.join(""));
          cur = [];
          continue;
        }
        let carry: string[] = [];
        if (WORD_CHAR.test(g) && WORD_CHAR.test(cur[cur.length - 1] ?? "")) {
          // Move the partial Latin word down when the line has a break opportunity before it.
          let i = cur.length - 1;
          while (i >= 0 && WORD_CHAR.test(cur[i]!)) i--;
          if (i >= 0) carry = cur.splice(i + 1);
        } else if (cur.length > 1 && NO_LINE_END.has(cur[cur.length - 1]!)) {
          carry = cur.splice(cur.length - 1);
        }
        lines.push(cur.join("").trimEnd());
        cur = [...carry, g];
      } else {
        cur.push(g);
      }
    }
    if (cur.length > 0 || paragraph === "") lines.push(cur.join(""));
  }
  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length <= maxLines) return { lines, truncated: false };
  const kept = lines.slice(0, Math.max(1, maxLines));
  kept[kept.length - 1] = shorten(kept[kept.length - 1]!, maxWidth, width);
  return { lines: kept, truncated: true };
}

export type TextBlock = { font: string; size: number; lineHeight: number; lines: string[]; truncated: boolean };

/**
 * Pick the biggest size where the text fits: sizes[0] must fit on one line, the other sizes may use
 * up to maxLines. Falls back to the last size, truncated.
 */
export function fitText(
  text: string,
  maxWidth: number,
  measure: Measure,
  fontFor: (size: number) => string,
  sizes: readonly number[],
  maxLinesFor: (size: number, index: number) => number,
  lineHeightRatio: number,
): TextBlock {
  for (let i = 0; i < sizes.length; i++) {
    const size = sizes[i]!;
    const font = fontFor(size);
    const max = maxLinesFor(size, i);
    const r = wrapText(text, maxWidth, (s) => measure(font, s));
    if (r.lines.length <= max || i === sizes.length - 1) {
      const out = r.lines.length <= max ? r : wrapText(text, maxWidth, (s) => measure(font, s), max);
      return { font, size, lineHeight: Math.round(size * lineHeightRatio), lines: out.lines, truncated: out.truncated };
    }
  }
  throw new Error("fitText: no sizes");
}

export const TITLE_SIZES = [56, 48, 40] as const;
export const REFLECTION_SIZES = [28, 25, 22] as const;

export function fitTitle(title: string, maxWidth: number, measure: Measure): TextBlock {
  return fitText(title, maxWidth, measure, (s) => `400 ${s}px ${CARD_FONTS.display}`, TITLE_SIZES, (_s, i) => (i === 0 ? 1 : 2), 1.2);
}

/** The ひとこと in 「」, as many lines as the space allows. */
export function fitReflection(text: string, maxWidth: number, maxHeight: number, measure: Measure): TextBlock {
  const quoted = `「${text}」`;
  return fitText(
    quoted,
    maxWidth,
    measure,
    (s) => `700 ${s}px ${CARD_FONTS.body}`,
    REFLECTION_SIZES,
    (s) => Math.max(1, Math.floor(maxHeight / Math.round(s * 1.5))),
    1.5,
  );
}

// ---------- card layout (pure) ----------

export type Rect = { x: number; y: number; w: number; h: number };
export type GridCell = Rect & { day: number; stamped: boolean; after: boolean };

/** 30 cells in `cols` columns, left to right, top to bottom. */
export function gridCells(
  x: number,
  y: number,
  cell: number,
  gap: number,
  cols: number,
  stamped: ReadonlySet<number>,
  lastDay: number = TOTAL_DAYS,
): GridCell[] {
  return Array.from({ length: TOTAL_DAYS }, (_, i) => {
    const day = i + 1;
    return {
      day,
      x: x + (i % cols) * (cell + gap),
      y: y + Math.floor(i / cols) * (cell + gap),
      w: cell,
      h: cell,
      stamped: stamped.has(day),
      after: day > lastDay,
    };
  });
}

export type CardLayout = {
  card: Rect;
  seal: { cx: number; cy: number; r: number; char: string; font: string };
  sticker: { cx: number; cy: number; w: number; h: number; label: string; font: string; color: string } | null;
  count: { x: number; y: number; value: string; font: string; denom: string; denomFont: string; denomX: number; label: string; labelFont: string; labelY: number };
  title: TextBlock & { x: number; y: number };
  grid: GridCell[];
  gridSeal: { r: number; font: string };
  reflection: (TextBlock & { x: number; y: number; color: string }) | null;
  period: { x: number; y: number; text: string; font: string };
  logo: { x: number; y: number; text: string; font: string; sealR: number; sealX: number };
};

export const CARD = { x: 44, y: 34, w: 1100, h: 526, border: 6, shadow: 12, radius: 22, pad: 44 } as const;
const LEFT_W = 300;
const COL_GAP = 40;
/** Preferred 10×3 grid with big cells; 15×2 when the ひとこと needs the room. */
export const GRID_SHAPES = [
  { cols: 10, gap: 8, maxCell: 54 },
  { cols: 15, gap: 6, maxCell: 44 },
] as const;

export function computeCardLayout(d: ShareCardData, measure: Measure): CardLayout {
  const inner = { x: CARD.x + CARD.pad, y: CARD.y + CARD.pad, w: CARD.w - CARD.pad * 2, h: CARD.h - CARD.pad * 2 };
  const bottom = inner.y + inner.h;

  // Left column: seal, verdict sticker on its lower right, count.
  const sealR = 116;
  const seal = { cx: inner.x + LEFT_W / 2 - 10, cy: inner.y + sealR + 6, r: sealR, char: d.seal || "印", font: `400 ${Math.round(sealR * 1.18)}px ${CARD_FONTS.display}` };
  let sticker: CardLayout["sticker"] = null;
  if (d.verdict) {
    const label = VERDICTS[d.verdict].label;
    const font = `400 34px ${CARD_FONTS.display}`;
    const w = Math.ceil(measure(font, label)) + 48;
    sticker = { cx: Math.min(inner.x + LEFT_W - w / 2 + 6, seal.cx + sealR * 0.55), cy: seal.cy + sealR - 4, w, h: 66, label, font, color: VERDICT_COLORS[d.verdict] };
  }
  const countFont = `400 96px ${CARD_FONTS.display}`;
  const denomFont = `400 40px ${CARD_FONTS.display}`;
  const value = String(d.count);
  const countY = bottom - 4;
  const count = {
    x: inner.x,
    y: countY,
    value,
    font: countFont,
    denom: ` / ${TOTAL_DAYS}`,
    denomFont,
    denomX: inner.x + measure(countFont, value) + 4,
    label: "押せた日",
    labelFont: `700 22px ${CARD_FONTS.body}`,
    labelY: countY - 104,
  };

  // Right column: title, 30 cells, ひとこと.
  const rx = inner.x + LEFT_W + COL_GAP;
  const rw = inner.x + inner.w - rx;
  const titleBlock = fitTitle(d.title, rw, measure);
  const title = { ...titleBlock, x: rx, y: inner.y + 2 };
  const titleBottom = title.y + title.lines.length * title.lineHeight;
  const own = d.reflection.trim();
  const text = own || (d.verdict ? VERDICTS[d.verdict].desc : "");
  const stamped = new Set(d.stampedDays);

  const arrange = (shape: (typeof GRID_SHAPES)[number]) => {
    const cell = Math.min(shape.maxCell, Math.floor((rw - shape.gap * (shape.cols - 1)) / shape.cols));
    const rows = Math.ceil(TOTAL_DAYS / shape.cols);
    const gridTop = titleBottom + 22;
    const grid = gridCells(rx, gridTop, cell, shape.gap, shape.cols, stamped, d.lastDay);
    const reflTop = gridTop + rows * cell + (rows - 1) * shape.gap + 26;
    const reflection = !text
      ? null
      : own
        ? { ...fitReflection(text, rw, bottom - reflTop, measure), x: rx, y: reflTop, color: CARD_COLORS.ink }
        : { ...fitText(text, rw, measure, (s) => `400 ${s}px ${CARD_FONTS.body}`, [24, 22], () => 2, 1.5), x: rx, y: reflTop, color: CARD_COLORS.muted };
    return { cell, grid, reflection };
  };
  let arranged = arrange(GRID_SHAPES[0]);
  if (arranged.reflection?.truncated) arranged = arrange(GRID_SHAPES[1]);
  const { cell, grid, reflection } = arranged;

  // Under the card: period (left) and logo (right).
  const stripY = CARD.y + CARD.h + CARD.shadow + (CARD_H - (CARD.y + CARD.h + CARD.shadow)) / 2 + 2;
  const logoFont = `400 30px ${CARD_FONTS.display}`;
  const logoText = "30日だけ";
  const logoX = CARD_W - 48;
  const sealRSmall = 19;
  return {
    card: { x: CARD.x, y: CARD.y, w: CARD.w, h: CARD.h },
    seal,
    sticker,
    count,
    title,
    grid,
    gridSeal: { r: Math.round(cell * 0.4), font: `400 ${Math.round(cell * 0.46)}px ${CARD_FONTS.display}` },
    reflection,
    period: { x: CARD.x + 4, y: stripY, text: d.period, font: `700 22px ${CARD_FONTS.body}` },
    logo: { x: logoX, y: stripY, text: logoText, font: logoFont, sealR: sealRSmall, sealX: logoX - measure(logoFont, logoText) - 12 - sealRSmall },
  };
}

// ---------- drawing (thin; needs a real canvas) ----------

type Ctx = CanvasRenderingContext2D;

function roundRect(x: Ctx, r: Rect, radius: number): void {
  const { x: px, y: py, w, h } = r;
  const rad = Math.min(radius, w / 2, h / 2);
  x.beginPath();
  x.moveTo(px + rad, py);
  x.arcTo(px + w, py, px + w, py + h, rad);
  x.arcTo(px + w, py + h, px, py + h, rad);
  x.arcTo(px, py + h, px, py, rad);
  x.arcTo(px, py, px + w, py, rad);
  x.closePath();
}

function drawSeal(x: Ctx, cx: number, cy: number, r: number, char: string, font: string, rotDeg: number, border: number, shadow: number): void {
  x.save();
  x.translate(cx, cy);
  x.rotate((rotDeg * Math.PI) / 180);
  if (shadow > 0) {
    x.fillStyle = CARD_COLORS.ink;
    x.beginPath();
    x.arc(shadow, shadow, r, 0, Math.PI * 2);
    x.fill();
  }
  x.fillStyle = CARD_COLORS.shu;
  x.beginPath();
  x.arc(0, 0, r, 0, Math.PI * 2);
  x.fill();
  x.lineWidth = border;
  x.strokeStyle = CARD_COLORS.ink;
  x.stroke();
  x.fillStyle = CARD_COLORS.ink;
  x.font = font;
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillText(char, 0, r * 0.05);
  x.restore();
}

export function drawCard(x: Ctx, l: CardLayout): void {
  const C = CARD_COLORS;
  // Grid paper.
  x.fillStyle = C.bg;
  x.fillRect(0, 0, CARD_W, CARD_H);
  x.strokeStyle = C.grid;
  x.lineWidth = 1;
  x.beginPath();
  for (let i = 0.5; i <= CARD_W; i += 24) {
    x.moveTo(i, 0);
    x.lineTo(i, CARD_H);
  }
  for (let i = 0.5; i <= CARD_H; i += 24) {
    x.moveTo(0, i);
    x.lineTo(CARD_W, i);
  }
  x.stroke();

  // Card with a hard shadow.
  x.fillStyle = C.ink;
  roundRect(x, { ...l.card, x: l.card.x + CARD.shadow, y: l.card.y + CARD.shadow }, CARD.radius);
  x.fill();
  x.fillStyle = C.surface;
  roundRect(x, l.card, CARD.radius);
  x.fill();
  x.lineWidth = CARD.border;
  x.strokeStyle = C.ink;
  roundRect(x, { x: l.card.x + CARD.border / 2, y: l.card.y + CARD.border / 2, w: l.card.w - CARD.border, h: l.card.h - CARD.border }, CARD.radius - CARD.border / 2);
  x.stroke();

  // Seal + verdict sticker.
  drawSeal(x, l.seal.cx, l.seal.cy, l.seal.r, l.seal.char, l.seal.font, -6, 6, 8);
  if (l.sticker) {
    const s = l.sticker;
    x.save();
    x.translate(s.cx, s.cy);
    x.rotate((-6 * Math.PI) / 180);
    const box = { x: -s.w / 2, y: -s.h / 2, w: s.w, h: s.h };
    x.fillStyle = C.ink;
    roundRect(x, { ...box, x: box.x + 6, y: box.y + 6 }, 10);
    x.fill();
    x.fillStyle = s.color;
    roundRect(x, box, 10);
    x.fill();
    x.lineWidth = 4;
    x.strokeStyle = C.ink;
    x.stroke();
    x.fillStyle = C.onAccent;
    x.font = s.font;
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillText(s.label, 0, 2);
    x.restore();
  }

  // Count.
  x.textAlign = "left";
  x.textBaseline = "alphabetic";
  x.fillStyle = C.muted;
  x.font = l.count.labelFont;
  x.fillText(l.count.label, l.count.x, l.count.labelY);
  x.fillStyle = C.ink;
  x.font = l.count.font;
  x.fillText(l.count.value, l.count.x, l.count.y);
  x.font = l.count.denomFont;
  x.fillText(l.count.denom, l.count.denomX, l.count.y);

  // Title.
  x.fillStyle = C.ink;
  x.font = l.title.font;
  x.textBaseline = "top";
  l.title.lines.forEach((line, i) => x.fillText(line, l.title.x, l.title.y + i * l.title.lineHeight + (l.title.lineHeight - l.title.size) / 2));

  // 30 cells.
  for (const c of l.grid) {
    roundRect(x, c, 7);
    // Days after an early finish ("ここで区切る") are greyed out.
    x.fillStyle = c.after ? C.gray : C.surface;
    x.fill();
    x.lineWidth = 2.5;
    x.strokeStyle = C.ink;
    x.stroke();
    if (c.stamped) drawSeal(x, c.x + c.w / 2, c.y + c.h / 2, l.gridSeal.r, l.seal.char, l.gridSeal.font, -8, 2, 0);
  }

  // ひとこと.
  if (l.reflection) {
    x.fillStyle = l.reflection.color;
    x.font = l.reflection.font;
    x.textBaseline = "top";
    const r = l.reflection;
    r.lines.forEach((line, i) => x.fillText(line, r.x, r.y + i * r.lineHeight + (r.lineHeight - r.size) / 2));
  }

  // Strip under the card.
  x.textBaseline = "middle";
  x.fillStyle = C.ink;
  x.font = l.period.font;
  x.textAlign = "left";
  x.fillText(l.period.text, l.period.x, l.period.y);
  drawSeal(x, l.logo.sealX, l.logo.y, l.logo.sealR, "卅", `400 ${Math.round(l.logo.sealR * 1.15)}px ${CARD_FONTS.display}`, -6, 3, 3);
  x.fillStyle = C.ink;
  x.font = l.logo.font;
  x.textAlign = "right";
  x.fillText(l.logo.text, l.logo.x, l.logo.y + 2);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Make sure the web fonts (only the glyphs we draw) are loaded before painting. */
export async function ensureCardFonts(d: ShareCardData, timeoutMs = 5000): Promise<void> {
  try {
    await loadFonts();
  } catch {
    // fall back to system fonts
  }
  const fonts = typeof document !== "undefined" ? document.fonts : undefined;
  if (!fonts?.load) return;
  const display = `${d.title}${d.seal}卅30日だけ0123456789/ ${d.verdict ? VERDICTS[d.verdict].label : ""}`;
  const body = `${d.reflection}「」${d.period}押せた日${d.verdict ? VERDICTS[d.verdict].desc : ""}`;
  await Promise.race([
    Promise.all([
      fonts.load(`400 56px "Dela Gothic One"`, display),
      fonts.load(`700 26px "Zen Kaku Gothic New"`, body),
      fonts.load(`400 24px "Zen Kaku Gothic New"`, body),
    ]).catch(() => undefined),
    delay(timeoutMs),
  ]);
}

/** Draw the card and return it as a PNG Blob. Throws when the browser cannot draw. */
export async function renderShareCard(d: ShareCardData): Promise<Blob> {
  await ensureCardFonts(d);
  const canvas = document.createElement("canvas");
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  const measure: Measure = (font, text) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  };
  drawCard(ctx, computeCardLayout(d, measure));
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("toBlob failed");
  return blob;
}
