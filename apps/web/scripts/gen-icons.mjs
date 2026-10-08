/* global document -- used inside page.evaluate(), which runs in the browser */
/**
 * Generates the app icons, favicon and default OG image into apps/web/public.
 *
 *   PLAYWRIGHT_BROWSERS_PATH=<browsers dir> node apps/web/scripts/gen-icons.mjs
 *
 * The brand seal 「卅」. The kanji is drawn from the real Klee One 600 glyph outline (read from the
 * @fontsource WOFF file, which has TrueType glyf outlines), so favicon.svg needs no web font. PNGs and
 * the OG image are rendered with Playwright's Chromium (the OG page embeds the @fontsource font files).
 * Colours and shapes: docs/design.md 「白いノート」 (Issue #20). App icons and the favicon are a filled 朱
 * circle with the kanji in paper colour on a paper tile, so they still read at 16–48px; the OG image
 * uses the thin 朱 ring seal of the app.
 * Re-run only when the brand changes; the outputs are committed.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { chromium } from "@playwright/test";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, "..", "public");

// tokens.css (light theme, and the dark values the favicon switches to)
const BG = "#faf8f4";
const SURFACE = "#ffffff";
const INK = "#34312c";
const MUTED = "#6b655c";
const LINE = "#8c8579";
const RULE = "#e2ddd3";
const RULE_FAINT = "rgba(52,49,44,0.06)";
const SHU = "#b9553d";
const SHU_SOFT = "#f6e3dc";
const ACCENT_INK = "#3f6b4a";
const ACCENT_SOFT = "#e6eee3";
const DARK_BG = "#1c1b19";
const DARK_SHU = "#d4866f";

const fontFile = (pkg, file) => require.resolve(`@fontsource/${pkg}/files/${file}`);
const log = (msg) => process.stdout.write(`${msg}\n`);

// ---------- minimal TrueType reader (WOFF 1.0, glyf outlines) ----------

async function loadWoff(path) {
  const buf = await readFile(path);
  if (buf.toString("ascii", 0, 4) !== "wOFF") throw new Error(`${path} is not WOFF 1.0`);
  const numTables = buf.readUInt16BE(12);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const o = 44 + i * 20;
    const tag = buf.toString("ascii", o, o + 4);
    const offset = buf.readUInt32BE(o + 4);
    const compLength = buf.readUInt32BE(o + 8);
    const origLength = buf.readUInt32BE(o + 12);
    const raw = buf.subarray(offset, offset + compLength);
    tables[tag] = compLength < origLength ? inflateSync(raw) : Buffer.from(raw);
  }
  return tables;
}

function glyphIndex(cmap, codePoint) {
  const n = cmap.readUInt16BE(2);
  const subtables = [];
  for (let i = 0; i < n; i++) {
    const o = 4 + i * 8;
    subtables.push({ platform: cmap.readUInt16BE(o), encoding: cmap.readUInt16BE(o + 2), offset: cmap.readUInt32BE(o + 4) });
  }
  for (const st of subtables) {
    const format = cmap.readUInt16BE(st.offset);
    if (format === 12) {
      const groups = cmap.readUInt32BE(st.offset + 12);
      for (let g = 0; g < groups; g++) {
        const o = st.offset + 16 + g * 12;
        const start = cmap.readUInt32BE(o);
        const end = cmap.readUInt32BE(o + 4);
        if (codePoint >= start && codePoint <= end) return cmap.readUInt32BE(o + 8) + (codePoint - start);
      }
    }
  }
  for (const st of subtables) {
    const base = st.offset;
    if (cmap.readUInt16BE(base) !== 4 || codePoint > 0xffff) continue;
    const segCount = cmap.readUInt16BE(base + 6) / 2;
    const endCodes = base + 14;
    const startCodes = endCodes + segCount * 2 + 2;
    const idDeltas = startCodes + segCount * 2;
    const idRangeOffsets = idDeltas + segCount * 2;
    for (let s = 0; s < segCount; s++) {
      const end = cmap.readUInt16BE(endCodes + s * 2);
      if (codePoint > end) continue;
      const start = cmap.readUInt16BE(startCodes + s * 2);
      if (codePoint < start) break;
      const delta = cmap.readInt16BE(idDeltas + s * 2);
      const rangeOffsetPos = idRangeOffsets + s * 2;
      const rangeOffset = cmap.readUInt16BE(rangeOffsetPos);
      if (rangeOffset === 0) return (codePoint + delta) & 0xffff;
      const g = cmap.readUInt16BE(rangeOffsetPos + rangeOffset + 2 * (codePoint - start));
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
  }
  return 0;
}

function glyphOffset(tables, index) {
  const longLoca = tables.head.readInt16BE(50) === 1;
  const loca = tables.loca;
  return longLoca
    ? [loca.readUInt32BE(index * 4), loca.readUInt32BE(index * 4 + 4)]
    : [loca.readUInt16BE(index * 2) * 2, loca.readUInt16BE(index * 2 + 2) * 2];
}

/** Contours as arrays of { x, y, on } in font units (composites flattened). */
function glyphContours(tables, index, depth = 0) {
  const [start, end] = glyphOffset(tables, index);
  if (end <= start) return [];
  const g = tables.glyf.subarray(start, end);
  const contours = g.readInt16BE(0);
  if (contours >= 0) {
    let p = 10;
    const endPts = [];
    for (let i = 0; i < contours; i++, p += 2) endPts.push(g.readUInt16BE(p));
    const count = contours ? endPts[contours - 1] + 1 : 0;
    p += 2 + g.readUInt16BE(p);
    const flags = [];
    while (flags.length < count) {
      const f = g[p++];
      flags.push(f);
      if (f & 8) for (let r = g[p++]; r > 0; r--) flags.push(f);
    }
    const read = (short, same) => {
      let v = 0;
      return flags.map((f) => {
        if (f & short) {
          const d = g[p++];
          v += f & same ? d : -d;
        } else if (!(f & same)) {
          v += g.readInt16BE(p);
          p += 2;
        }
        return v;
      });
    };
    const xs = read(2, 16);
    const ys = read(4, 32);
    const out = [];
    let from = 0;
    for (const last of endPts) {
      const pts = [];
      for (let i = from; i <= last; i++) pts.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) === 1 });
      out.push(pts);
      from = last + 1;
    }
    return out;
  }
  if (depth > 4) return [];
  // Composite glyph: components with an offset and optional scale.
  const out = [];
  let p = 10;
  for (;;) {
    const flags = g.readUInt16BE(p);
    const child = g.readUInt16BE(p + 2);
    p += 4;
    let dx = 0;
    let dy = 0;
    if (flags & 1) {
      dx = g.readInt16BE(p);
      dy = g.readInt16BE(p + 2);
      p += 4;
    } else {
      dx = g.readInt8(p);
      dy = g.readInt8(p + 1);
      p += 2;
    }
    let [a, b, c, d] = [1, 0, 0, 1];
    const f2 = (o) => g.readInt16BE(o) / 16384;
    if (flags & 8) {
      a = d = f2(p);
      p += 2;
    } else if (flags & 0x40) {
      a = f2(p);
      d = f2(p + 2);
      p += 4;
    } else if (flags & 0x80) {
      [a, b, c, d] = [f2(p), f2(p + 2), f2(p + 4), f2(p + 6)];
      p += 8;
    }
    const useOffsets = (flags & 2) !== 0;
    for (const contour of glyphContours(tables, child, depth + 1)) {
      out.push(
        contour.map((pt) => ({
          x: a * pt.x + c * pt.y + (useOffsets ? dx : 0),
          y: b * pt.x + d * pt.y + (useOffsets ? dy : 0),
          on: pt.on,
        })),
      );
    }
    if (!(flags & 0x20)) break;
  }
  return out;
}

const r2 = (n) => Math.round(n * 100) / 100;

/** Quadratic TrueType contours → SVG path data (font units, y up). */
function contoursToPath(contours) {
  let d = "";
  for (const pts of contours) {
    if (pts.length === 0) continue;
    const n = pts.length;
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true });
    let startIdx = pts.findIndex((p) => p.on);
    let start;
    if (startIdx === -1) {
      start = mid(pts[0], pts[n - 1]);
      startIdx = 0;
    } else {
      start = pts[startIdx];
      startIdx += 1;
    }
    d += `M${r2(start.x)} ${r2(start.y)}`;
    let ctrl = null;
    for (let k = 0; k < n; k++) {
      const p = pts[(startIdx + k) % n];
      if (p === start) continue;
      if (p.on) {
        d += ctrl ? `Q${r2(ctrl.x)} ${r2(ctrl.y)} ${r2(p.x)} ${r2(p.y)}` : `L${r2(p.x)} ${r2(p.y)}`;
        ctrl = null;
      } else {
        if (ctrl) {
          const m = mid(ctrl, p);
          d += `Q${r2(ctrl.x)} ${r2(ctrl.y)} ${r2(m.x)} ${r2(m.y)}`;
        }
        ctrl = p;
      }
    }
    d += ctrl ? `Q${r2(ctrl.x)} ${r2(ctrl.y)} ${r2(start.x)} ${r2(start.y)}Z` : "Z";
  }
  return d;
}

async function loadGlyph(char) {
  const tables = await loadWoff(fontFile("klee-one", "klee-one-japanese-600-normal.woff"));
  const index = glyphIndex(tables.cmap, char.codePointAt(0));
  if (!index) throw new Error(`Klee One has no glyph for ${char}`);
  const [start] = glyphOffset(tables, index);
  const g = tables.glyf;
  return {
    unitsPerEm: tables.head.readUInt16BE(18),
    bbox: { xMin: g.readInt16BE(start + 2), yMin: g.readInt16BE(start + 4), xMax: g.readInt16BE(start + 6), yMax: g.readInt16BE(start + 8) },
    path: contoursToPath(glyphContours(tables, index)),
  };
}

// ---------- seal SVG ----------

/** The glyph centred on (cx, cy), `em` px per em. */
function glyphPath(glyph, cx, cy, em, attrs) {
  const s = em / glyph.unitsPerEm;
  const gx = (glyph.bbox.xMin + glyph.bbox.xMax) / 2;
  const gy = (glyph.bbox.yMin + glyph.bbox.yMax) / 2;
  return `<path ${attrs} transform="translate(${r2(cx)} ${r2(cy)}) scale(${s.toFixed(5)} ${(-s).toFixed(5)}) translate(${-gx} ${-gy})" d="${glyph.path}"/>`;
}

/**
 * The app icon / favicon in a `size` box: a paper tile, a filled 朱 circle and the kanji in paper
 * colour, tilted -4deg like the seal. `diameter` is the circle's size relative to the box.
 * `tile`: "full" (a full-bleed square; the OS applies its own mask) or "rounded" (favicon).
 * `adaptive` adds the dark colours (tile #1c1b19, circle #d4866f, kanji #1c1b19) for favicon.svg.
 */
function iconSvg(glyph, { size, diameter, tile = "full", glyphRatio = 0.56, adaptive = false }) {
  const c = size / 2;
  const r = (size * diameter) / 2;
  const style = adaptive
    ? `<style>.t{fill:${BG}}.d{fill:${SHU}}.k{fill:${BG};stroke:${BG}}@media (prefers-color-scheme:dark){.t{fill:${DARK_BG}}.d{fill:${DARK_SHU}}.k{fill:${DARK_BG};stroke:${DARK_BG}}}</style>`
    : "";
  const paint = (cls, colour) => (adaptive ? `class="${cls}"` : `fill="${colour}"`);
  const rx = tile === "rounded" ? r2(size * 0.22) : 0;
  // Klee One's pen strokes are thin: a matching outline (about 1.3% of the icon) keeps the kanji
  // readable at 16–48px. The path is drawn in font units, so the width is converted to them.
  const em = r * 2 * glyphRatio;
  const strokeUnits = r2((size * 0.013 * glyph.unitsPerEm) / em);
  const kanji = adaptive
    ? `class="k" stroke-width="${strokeUnits}" stroke-linejoin="round"`
    : `fill="${BG}" stroke="${BG}" stroke-width="${strokeUnits}" stroke-linejoin="round"`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
    style +
    `<rect width="${size}" height="${size}" rx="${rx}" ${paint("t", BG)}/>` +
    `<g transform="rotate(-4 ${r2(c)} ${r2(c)})">` +
    `<circle cx="${r2(c)}" cy="${r2(c)}" r="${r2(r)}" ${paint("d", SHU)}/>` +
    glyphPath(glyph, c, c, em, kanji) +
    `</g></svg>`
  );
}

/** The app's seal (CSS .seal): a thin 朱 ring and the 朱 kanji, no fill, tilted -4deg. */
function ringSealSvg(glyph, size) {
  const c = size / 2;
  const ring = Math.max(1.5, size * 0.045);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
    `<g transform="rotate(-4 ${r2(c)} ${r2(c)})">` +
    `<circle cx="${r2(c)}" cy="${r2(c)}" r="${r2(c - ring / 2)}" fill="none" stroke="${SHU}" stroke-width="${r2(ring)}"/>` +
    glyphPath(glyph, c, c, size * 0.5, `fill="${SHU}"`) +
    `</g></svg>`
  );
}

/** Android status-bar badge: only alpha is used. A white disc with the kanji knocked out. */
function badgeSvg(glyph, size) {
  const c = size / 2;
  const r = size * 0.46;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
    `<defs><mask id="m"><rect width="${size}" height="${size}" fill="#fff"/>${glyphPath(glyph, c, c, r * 2 * 0.58, 'fill="#000"')}</mask></defs>` +
    `<g transform="rotate(-4 ${c} ${c})"><circle cx="${c}" cy="${c}" r="${r2(r)}" fill="#fff" mask="url(#m)"/></g></svg>`
  );
}

// ---------- OG image ----------

async function fontFace(family, weight, pkg, file, range) {
  const data = (await readFile(fontFile(pkg, file))).toString("base64");
  return `@font-face{font-family:"${family}";font-weight:${weight};src:url(data:font/woff2;base64,${data}) format("woff2");${range ? `unicode-range:${range};` : ""}}`;
}

async function ogHtml(glyph) {
  const faces = [
    // The OG image is a PNG, so the whole page can use the embedded handwriting font (no CJK system font needed).
    await fontFace("Klee One", 600, "klee-one", "klee-one-japanese-600-normal.woff2"),
    await fontFace("Klee One", 600, "klee-one", "klee-one-latin-600-normal.woff2", "U+0000-00FF"),
  ].join("");
  const stamped = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13]);
  const today = 14;
  const cells = Array.from({ length: 30 }, (_, i) => {
    const day = i + 1;
    const cls = ["cell", day === today ? "today" : "", day > today ? "future" : "", stamped.has(day) ? "on" : ""].filter(Boolean).join(" ");
    return `<div class="${cls}"><span class="n">${day}</span>${stamped.has(day) ? '<span class="st">試</span>' : ""}</div>`;
  }).join("");
  const brandSeal = ringSealSvg(glyph, 96);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
${faces}
*{box-sizing:border-box;margin:0}
html,body{width:1200px;height:630px}
body{font-family:"Klee One",sans-serif;font-weight:600;color:${INK};background:${BG};padding:52px 56px 56px;font-synthesis:none}
.card{position:relative;display:flex;align-items:center;gap:52px;height:100%;padding:0 52px 0 56px;background:${SURFACE};
 background-image:repeating-linear-gradient(to bottom,transparent 0 47px,${RULE_FAINT} 47px 48px);
 border:2px solid ${RULE};border-radius:20px 26px 19px 25px/25px 19px 26px 20px}
.left{flex:1;min-width:0}
.brand{display:flex;align-items:center;gap:20px;margin-bottom:34px}
.brand b{font-weight:600;font-size:62px;letter-spacing:.04em;line-height:1}
.tag{font-weight:600;font-size:44px;line-height:1.5;letter-spacing:.04em;white-space:nowrap}
.hl{background:linear-gradient(transparent 58%,${ACCENT_SOFT} 58%,${ACCENT_SOFT} 90%,transparent 90%);padding:0 .06em}
.sub{margin-top:24px;font-size:23px;color:${MUTED};line-height:1.65;white-space:nowrap}
.label{position:absolute;top:30px;right:44px;padding:4px 16px;border:2px solid ${ACCENT_INK};border-radius:12px;background:${ACCENT_SOFT};
 color:${ACCENT_INK};font-size:24px}
.grid{display:grid;grid-template-columns:repeat(6,56px);gap:8px;margin-top:40px}
.cell{position:relative;width:56px;height:56px;border:1.5px solid ${LINE};border-radius:9px;background:${SURFACE}}
.cell .n{position:absolute;top:2px;left:4px;z-index:1;padding:0 2px;border-radius:4px;font-size:13px;line-height:1.2;color:${MUTED}}
.cell.on{background:${SHU_SOFT}}.cell.on .n{background:${SHU_SOFT}}
.cell.today{border:2.5px solid ${ACCENT_INK};background:${ACCENT_SOFT}}.cell.today .n{color:${ACCENT_INK}}
.cell.future{border-style:dotted}
.st{position:absolute;inset:19% 7% 7% 19%;border-radius:50%;border:2px solid ${SHU};color:${SHU};display:flex;align-items:center;justify-content:center;
 font-size:21px;line-height:1;transform:rotate(-4deg)}
</style></head><body>
<div class="card">
  <div class="left">
    <div class="brand">${brandSeal}<b>30日だけ</b></div>
    <p class="tag">どうせ過ぎる30日なら、<br><span class="hl">ひとつ試してみる。</span></p>
    <p class="sub">毎日1タップで印を押して、30日目に<br>「続ける・やめる・形を変える」を決める。</p>
  </div>
  <div class="grid">${cells}</div>
  <div class="label">1日1タップ</div>
</div>
</body></html>`;
}

// ---------- render ----------

async function main() {
  const glyph = await loadGlyph("卅");
  await mkdir(join(PUBLIC, "icons"), { recursive: true });

  const favicon = iconSvg(glyph, { size: 64, diameter: 0.84, tile: "rounded", glyphRatio: 0.6, adaptive: true });
  await writeFile(join(PUBLIC, "favicon.svg"), `${favicon}\n`);
  log("public/favicon.svg");

  const pngs = [
    // Full-bleed paper squares: the OS applies its own mask / rounding.
    { file: "icons/icon-192.png", svg: iconSvg(glyph, { size: 192, diameter: 0.7 }) },
    { file: "icons/icon-512.png", svg: iconSvg(glyph, { size: 512, diameter: 0.7 }) },
    // Maskable: the circle stays inside the 80% safe circle.
    { file: "icons/maskable-512.png", svg: iconSvg(glyph, { size: 512, diameter: 0.62 }) },
    { file: "icons/apple-touch-icon-180.png", svg: iconSvg(glyph, { size: 180, diameter: 0.7 }) },
    // Android status-bar badge: only the alpha channel is used.
    { file: "icons/badge-72.png", svg: badgeSvg(glyph, 72), transparent: true },
  ];

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const { file, svg, transparent } of pngs) {
      const size = Number(/width="(\d+)"/.exec(svg)[1]);
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`);
      await page.screenshot({ path: join(PUBLIC, file), omitBackground: Boolean(transparent), clip: { x: 0, y: 0, width: size, height: size } });
      log(`public/${file}`);
    }

    await page.setViewportSize({ width: 1200, height: 630 });
    await page.setContent(await ogHtml(glyph), { waitUntil: "load" });
    await page.evaluate(async () => {
      await Promise.all([
        document.fonts.load('600 64px "Klee One"', "30日だけどうせ過ぎるなら、ひとつ試してみる。試1タップ0123456789"),
        document.fonts.load('600 23px "Klee One"', "毎日1タップで印を押して、30日目に「続ける・やめる・形を変える」を決める。"),
      ]);
      await document.fonts.ready;
    });
    await page.screenshot({ path: join(PUBLIC, "og-default.png"), clip: { x: 0, y: 0, width: 1200, height: 630 } });
    log("public/og-default.png");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
