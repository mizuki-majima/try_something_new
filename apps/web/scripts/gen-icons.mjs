/* global document -- used inside page.evaluate(), which runs in the browser */
/**
 * Generates the app icons, favicon and default OG image into apps/web/public.
 *
 *   PLAYWRIGHT_BROWSERS_PATH=<browsers dir> node apps/web/scripts/gen-icons.mjs
 *
 * NEO-BRUTALISM (docs/design.md): the brand seal 「卅」 is a 朱 disc with an ink ring, a hard
 * offset shadow and the kanji in ink, tilted -6deg. The kanji is drawn from the real Dela Gothic One
 * glyph outline (read from the @fontsource WOFF file), so favicon.svg needs no web font. PNGs and the
 * OG image are rendered with Playwright's Chromium (the OG page loads the @fontsource font files).
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

// tokens.css (light theme)
const BG = "#fff4d6";
const GRID = "rgba(17,17,17,0.08)";
const SURFACE = "#ffffff";
const INK = "#111111";
const MUTED = "#4a4a4a";
const SHU = "#ff4b2b";
const YELLOW = "#ffd43b";
const MINT = "#3ddc97";
const PINK = "#ff9ec7";
const HATCH = "rgba(17,17,17,0.22)";

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
  const tables = await loadWoff(fontFile("dela-gothic-one", "dela-gothic-one-japanese-400-normal.woff"));
  const index = glyphIndex(tables.cmap, char.codePointAt(0));
  if (!index) throw new Error(`Dela Gothic One has no glyph for ${char}`);
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

function gridBackground(size, cell) {
  return (
    `<defs><pattern id="g" width="${r2(cell)}" height="${r2(cell)}" patternUnits="userSpaceOnUse">` +
    `<path d="M${r2(cell)} 0H0V${r2(cell)}" fill="none" stroke="${GRID}" stroke-width="${Math.max(1, r2(size / 256))}"/></pattern></defs>` +
    `<rect width="${size}" height="${size}" fill="${BG}"/><rect width="${size}" height="${size}" fill="url(#g)"/>`
  );
}

/**
 * The seal in a `size` box, like the CSS .seal: 朱 disc, ink ring, hard ink shadow (down-right),
 * ink kanji, the whole stamp rotated -6deg. `diameter` is the disc's outer size relative to the box;
 * ring and shadow scale with it (CSS: 3px ring + 3px shadow on a 40px seal).
 * `adaptive` adds a dark-mode style (cream ring and shadow) for favicon.svg.
 */
function sealSvg(glyph, { size, diameter, background = false, glyphRatio = 0.54, adaptive = false }) {
  const outer = size * diameter;
  const ring = Math.max(1.5, outer * 0.075);
  const shadow = Math.max(1.5, outer * 0.08);
  const c = (size - shadow) / 2;
  const r = (outer - ring) / 2;
  const style = adaptive
    ? `<style>.o{fill:${INK}}.k{stroke:${INK}}@media (prefers-color-scheme:dark){.o{fill:#f7f3e8}.k{stroke:#f7f3e8}}</style>`
    : "";
  const ink = (cls, prop) => (adaptive ? `class="${cls}"` : `${prop}="${INK}"`);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
    style +
    (background ? gridBackground(size, size / 12) : "") +
    `<g transform="rotate(-6 ${r2(c)} ${r2(c)})">` +
    `<circle cx="${r2(c + shadow)}" cy="${r2(c + shadow)}" r="${r2(outer / 2)}" ${ink("o", "fill")}/>` +
    `<circle cx="${r2(c)}" cy="${r2(c)}" r="${r2(r)}" fill="${SHU}" ${ink("k", "stroke")} stroke-width="${r2(ring)}"/>` +
    glyphPath(glyph, c, c, outer * glyphRatio, `fill="${INK}"`) +
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
    `<g transform="rotate(-6 ${c} ${c})"><circle cx="${c}" cy="${c}" r="${r2(r)}" fill="#fff" mask="url(#m)"/></g></svg>`
  );
}

// ---------- OG image ----------

async function fontFace(family, weight, pkg, file, range) {
  const data = (await readFile(fontFile(pkg, file))).toString("base64");
  return `@font-face{font-family:"${family}";font-weight:${weight};src:url(data:font/woff2;base64,${data}) format("woff2");${range ? `unicode-range:${range};` : ""}}`;
}

async function ogHtml(glyph) {
  const faces = [
    await fontFace("Dela Gothic One", 400, "dela-gothic-one", "dela-gothic-one-japanese-400-normal.woff2"),
    await fontFace("Dela Gothic One", 400, "dela-gothic-one", "dela-gothic-one-latin-400-normal.woff2", "U+0000-00FF"),
    await fontFace("Zen Kaku Gothic New", 700, "zen-kaku-gothic-new", "zen-kaku-gothic-new-japanese-700-normal.woff2"),
    await fontFace("Zen Kaku Gothic New", 700, "zen-kaku-gothic-new", "zen-kaku-gothic-new-latin-700-normal.woff2", "U+0000-00FF"),
  ].join("");
  const stamped = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13]);
  const today = 14;
  const cells = Array.from({ length: 30 }, (_, i) => {
    const day = i + 1;
    const cls = day === today ? "cell today" : day > today ? "cell future" : "cell";
    return `<div class="${cls}"><span class="n">${day}</span>${stamped.has(day) ? '<span class="st">試</span>' : ""}</div>`;
  }).join("");
  const brandSeal = sealSvg(glyph, { size: 104, diameter: 0.9 });
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
${faces}
*{box-sizing:border-box;margin:0}
html,body{width:1200px;height:630px}
body{font-family:"Zen Kaku Gothic New",sans-serif;font-weight:700;color:${INK};background:${BG};
 background-image:linear-gradient(${GRID} 1px,transparent 1px),linear-gradient(90deg,${GRID} 1px,transparent 1px);background-size:30px 30px;
 padding:52px 64px 64px 52px;font-synthesis:none}
.card{position:relative;display:flex;align-items:center;gap:52px;height:100%;padding:0 52px 0 56px;background:${SURFACE};
 border:6px solid ${INK};border-radius:28px;box-shadow:12px 12px 0 ${INK}}
.left{flex:1;min-width:0}
.brand{display:flex;align-items:center;gap:18px;margin-bottom:34px}
.brand b{font-family:"Dela Gothic One",sans-serif;font-weight:400;font-size:64px;letter-spacing:.02em;line-height:1}
.tag{font-family:"Dela Gothic One",sans-serif;font-weight:400;font-size:46px;line-height:1.45;white-space:nowrap}
.hl{background:${YELLOW};padding:0 .12em;border-radius:6px}
.sub{margin-top:26px;font-size:23px;color:${MUTED};line-height:1.6;white-space:nowrap}
.sticker{position:absolute;top:-28px;right:44px;padding:6px 20px;border:4px solid ${INK};border-radius:14px;background:${MINT};
 box-shadow:5px 5px 0 ${INK};font-family:"Dela Gothic One",sans-serif;font-weight:400;font-size:26px;transform:rotate(4deg)}
.grid{display:grid;grid-template-columns:repeat(6,54px);gap:8px;padding:18px;border:4px solid ${INK};border-radius:18px;background:${PINK};
 box-shadow:6px 6px 0 ${INK};transform:rotate(-2deg)}
.cell{position:relative;width:54px;height:54px;border:3px solid ${INK};border-radius:9px;background:${SURFACE}}
.cell .n{position:absolute;top:2px;left:5px;font-family:"Dela Gothic One",sans-serif;font-weight:400;font-size:11px;color:${MUTED}}
.cell.today{border-width:4px;background:${YELLOW};box-shadow:3px 3px 0 ${INK}}.cell.today .n{color:${INK}}
.cell.future{background-image:repeating-linear-gradient(135deg,${HATCH} 0 2px,transparent 2px 7px)}
.st{position:absolute;inset:10%;border-radius:50%;border:3px solid ${INK};background:${SHU};color:${INK};display:flex;align-items:center;justify-content:center;
 font-family:"Dela Gothic One",sans-serif;font-weight:400;font-size:22px;line-height:1;transform:rotate(-8deg)}
</style></head><body>
<div class="card">
  <div class="left">
    <div class="brand">${brandSeal}<b>30日だけ</b></div>
    <p class="tag">どうせ過ぎる30日なら、<br><span class="hl">ひとつ試してみる。</span></p>
    <p class="sub">毎日1タップで印を押して、30日目に<br>「続ける・やめる・形を変える」を決める。</p>
  </div>
  <div class="grid">${cells}</div>
  <div class="sticker">1日1タップ</div>
</div>
</body></html>`;
}

// ---------- render ----------

async function main() {
  const glyph = await loadGlyph("卅");
  await mkdir(join(PUBLIC, "icons"), { recursive: true });

  const favicon = sealSvg(glyph, { size: 64, diameter: 0.84, glyphRatio: 0.6, adaptive: true });
  await writeFile(join(PUBLIC, "favicon.svg"), `${favicon}\n`);
  log("public/favicon.svg");

  const pngs = [
    // Full-bleed squares on grid paper: the OS applies its own mask / rounding.
    { file: "icons/icon-192.png", svg: sealSvg(glyph, { size: 192, diameter: 0.66, background: true }) },
    { file: "icons/icon-512.png", svg: sealSvg(glyph, { size: 512, diameter: 0.66, background: true }) },
    // Maskable: disc + shadow stay inside the 80% safe circle.
    { file: "icons/maskable-512.png", svg: sealSvg(glyph, { size: 512, diameter: 0.6, background: true }) },
    { file: "icons/apple-touch-icon-180.png", svg: sealSvg(glyph, { size: 180, diameter: 0.64, background: true }) },
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
        document.fonts.load('400 64px "Dela Gothic One"', "30日だけどうせ過ぎるなら、ひとつ試してみる。試1タップ0123456789"),
        document.fonts.load('700 23px "Zen Kaku Gothic New"', "毎日1タップで印を押して、30日目に「続ける・やめる・形を変える」を決める。"),
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
