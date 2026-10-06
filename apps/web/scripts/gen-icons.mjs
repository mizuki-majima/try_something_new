/* global document -- used inside page.evaluate(), which runs in the browser */
/**
 * Generates the app icons, favicon and default OG image into apps/web/public.
 *
 *   PLAYWRIGHT_BROWSERS_PATH=<browsers dir> node apps/web/scripts/gen-icons.mjs
 *
 * The brand seal 「卅」 is drawn from the real Kiwi Maru glyph outline (read from the @fontsource
 * WOFF file), so favicon.svg needs no web font. PNGs are rendered with Playwright's Chromium.
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
const PAPER = "#fafaf6";
const GRID = "rgba(59,91,165,0.11)";
const SURFACE = "#ffffff";
const INK = "#1b2440";
const MUTED = "#5f6782";
const LINE = "#d8dce7";
const SHU = "#c73a23";

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
  const tables = await loadWoff(fontFile("kiwi-maru", "kiwi-maru-japanese-500-normal.woff"));
  const index = glyphIndex(tables.cmap, char.codePointAt(0));
  if (!index) throw new Error(`Kiwi Maru has no glyph for ${char}`);
  const [start] = glyphOffset(tables, index);
  const g = tables.glyf;
  return {
    unitsPerEm: tables.head.readUInt16BE(18),
    bbox: { xMin: g.readInt16BE(start + 2), yMin: g.readInt16BE(start + 4), xMax: g.readInt16BE(start + 6), yMax: g.readInt16BE(start + 8) },
    path: contoursToPath(glyphContours(tables, index)),
  };
}

// ---------- seal SVG ----------

/**
 * The seal in a `size` box: ring + glyph, rotated like the CSS .seal (-6deg).
 * `diameter` is the ring's outer size relative to the box; the glyph is half the diameter
 * (font-size: calc(var(--s) * .5) in components.css), optionally enlarged for tiny icons.
 */
function sealSvg(glyph, { size, diameter, stroke, ink, fill, background, grid = false, glyphRatio = 0.5 }) {
  const c = size / 2;
  const outer = size * diameter;
  const r = (outer - stroke) / 2;
  const em = outer * glyphRatio;
  const s = em / glyph.unitsPerEm;
  const gx = (glyph.bbox.xMin + glyph.bbox.xMax) / 2;
  const gy = (glyph.bbox.yMin + glyph.bbox.yMax) / 2;
  const cell = size / 16;
  const gridDefs = grid
    ? `<defs><pattern id="g" width="${cell}" height="${cell}" patternUnits="userSpaceOnUse"><path d="M${cell} 0H0V${cell}" fill="none" stroke="${GRID}" stroke-width="${Math.max(1, size / 512)}"/></pattern></defs>`
    : "";
  const bg = background
    ? `<rect width="${size}" height="${size}" fill="${background}"/>${grid ? `<rect width="${size}" height="${size}" fill="url(#g)"/>` : ""}`
    : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
    gridDefs +
    bg +
    `<g transform="rotate(-6 ${c} ${c})">` +
    `<circle cx="${c}" cy="${c}" r="${r2(r)}" fill="${fill}" stroke="${ink}" stroke-width="${r2(stroke)}"/>` +
    `<path fill="${ink}" transform="translate(${r2(c)} ${r2(c)}) scale(${s.toFixed(5)} ${(-s).toFixed(5)}) translate(${-gx} ${-gy})" d="${glyph.path}"/>` +
    `</g></svg>`
  );
}

// ---------- OG image ----------

async function fontFace(family, weight, pkg, file, range) {
  const data = (await readFile(fontFile(pkg, file))).toString("base64");
  return `@font-face{font-family:"${family}";font-weight:${weight};src:url(data:font/woff2;base64,${data}) format("woff2");${range ? `unicode-range:${range};` : ""}}`;
}

async function ogHtml(glyph) {
  const faces = [
    await fontFace("Kiwi Maru", 500, "kiwi-maru", "kiwi-maru-japanese-500-normal.woff2"),
    await fontFace("Kiwi Maru", 500, "kiwi-maru", "kiwi-maru-latin-500-normal.woff2", "U+0000-00FF"),
    await fontFace("Zen Kaku Gothic New", 500, "zen-kaku-gothic-new", "zen-kaku-gothic-new-japanese-500-normal.woff2"),
    await fontFace("Zen Kaku Gothic New", 500, "zen-kaku-gothic-new", "zen-kaku-gothic-new-latin-500-normal.woff2", "U+0000-00FF"),
  ].join("");
  const stamped = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13]);
  const today = 14;
  const cells = Array.from({ length: 30 }, (_, i) => {
    const day = i + 1;
    const cls = day === today ? "cell today" : day > today ? "cell future" : "cell";
    return `<div class="${cls}"><span class="n">${day}</span>${stamped.has(day) ? '<span class="st">試</span>' : ""}</div>`;
  }).join("");
  const brandSeal = sealSvg(glyph, { size: 132, diameter: 1, stroke: 6, ink: SHU, fill: SURFACE });
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
${faces}
*{box-sizing:border-box;margin:0}
html,body{width:1200px;height:630px}
body{font-family:"Zen Kaku Gothic New",sans-serif;color:${INK};background:${PAPER};
 background-image:linear-gradient(${GRID} 1px,transparent 1px),linear-gradient(90deg,${GRID} 1px,transparent 1px);background-size:30px 30px;
 display:flex;align-items:center;gap:56px;padding:0 72px 0 80px}
.left{flex:1;min-width:0}
.brand{display:flex;align-items:center;gap:26px;margin-bottom:40px}
.brand b{font-family:"Kiwi Maru",serif;font-weight:500;font-size:84px;letter-spacing:.02em;line-height:1}
.tag{font-family:"Kiwi Maru",serif;font-weight:500;font-size:44px;line-height:1.5;white-space:nowrap}
.sub{margin-top:26px;font-size:24px;color:${MUTED};line-height:1.6;white-space:nowrap}
.card{flex:none;background:${SURFACE};border:2px solid ${LINE};border-radius:24px;padding:26px;box-shadow:0 2px 4px rgba(27,36,64,.06),0 24px 48px -24px rgba(27,36,64,.35);transform:rotate(2deg)}
.grid{display:grid;grid-template-columns:repeat(6,56px);gap:8px}
.cell{position:relative;width:56px;height:56px;border:1.5px solid ${LINE};border-radius:9px;background:${SURFACE}}
.cell .n{position:absolute;top:3px;left:6px;font-size:12px;color:${MUTED}}
.cell.today{border:2px dashed ${SHU}}.cell.today .n{color:${SHU};font-weight:700}
.cell.future{opacity:.45}
.st{position:absolute;inset:15%;border-radius:50%;border:2.5px solid ${SHU};color:${SHU};display:flex;align-items:center;justify-content:center;
 font-family:"Kiwi Maru",serif;font-weight:500;font-size:22px;transform:rotate(-8deg);background:${SURFACE}}
</style></head><body>
<div class="left">
  <div class="brand">${brandSeal}<b>30日だけ</b></div>
  <p class="tag">どうせ過ぎる30日なら、<br>ひとつ試してみる。</p>
  <p class="sub">毎日1タップで印を押して、30日目に<br>「続ける・やめる・形を変える」を決める。</p>
</div>
<div class="card"><div class="grid">${cells}</div></div>
</body></html>`;
}

// ---------- render ----------

async function main() {
  const glyph = await loadGlyph("卅");
  await mkdir(join(PUBLIC, "icons"), { recursive: true });

  const favicon = sealSvg(glyph, { size: 64, diameter: 0.92, stroke: 4.5, ink: SHU, fill: PAPER, glyphRatio: 0.56 });
  await writeFile(join(PUBLIC, "favicon.svg"), `${favicon}\n`);
  log("public/favicon.svg");

  const pngs = [
    // Full-bleed squares: the OS applies its own mask / rounding.
    { file: "icons/icon-192.png", svg: sealSvg(glyph, { size: 192, diameter: 0.74, stroke: 9, ink: SHU, fill: SURFACE, background: PAPER, grid: true, glyphRatio: 0.56 }) },
    { file: "icons/icon-512.png", svg: sealSvg(glyph, { size: 512, diameter: 0.74, stroke: 24, ink: SHU, fill: SURFACE, background: PAPER, grid: true, glyphRatio: 0.56 }) },
    // Maskable: keep the seal inside the 80% safe circle.
    { file: "icons/maskable-512.png", svg: sealSvg(glyph, { size: 512, diameter: 0.6, stroke: 20, ink: SHU, fill: SURFACE, background: PAPER, grid: true, glyphRatio: 0.56 }) },
    { file: "icons/apple-touch-icon-180.png", svg: sealSvg(glyph, { size: 180, diameter: 0.7, stroke: 8, ink: SHU, fill: SURFACE, background: PAPER, grid: true, glyphRatio: 0.56 }) },
    // Android status-bar badge: only the alpha channel is used, so white on transparent.
    { file: "icons/badge-72.png", svg: sealSvg(glyph, { size: 72, diameter: 0.9, stroke: 6, ink: "#ffffff", fill: "none", glyphRatio: 0.56 }), transparent: true },
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
        document.fonts.load('500 84px "Kiwi Maru"', "30日だけどうせ過ぎるなら、ひとつ試してみる。"),
        document.fonts.load('500 24px "Zen Kaku Gothic New"', "毎日1タップで印を押して「続ける・やめる・形を変える」を決める。"),
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
