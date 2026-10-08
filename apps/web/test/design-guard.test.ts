// Guards for the 「白いノート」 design (#20, docs/design.md): rules that are easy to break by accident
// when a page's CSS changes, checked from the source files.
//  (a) the two dark blocks in tokens.css declare the same values
//  (b) the contrast table (WCAG 2.x) holds in both themes, read from tokens.css
//  (c) every var(--x) used in the CSS is declared somewhere
//  (d) the old fonts are gone (Dela Gothic One, Zen Kaku Gothic New)
//  (e) no hard offset shadows
//  (f) no tilt except the seal (-4deg) and the ✓ drawn with borders (45deg)
//  (g) no raw #hex colours outside tokens.css
//  (h) components.css draws ::before / ::after without text (text would join accessible names)
//  (i) more contrast: control borders and every --rule line turn to ink, in both themes
//  (j) focus stays visible: form fields keep the focus ring; under forced colours, a focus rule
//      follows the selected-state outlines (which would otherwise hide it)
//  (k) handwriting (--font-hand) is set at 17px or more, except for seal characters
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");
const srcDir = path.join(webRoot, "src");

function walk(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p, ext) : ext.test(name) ? [p] : [];
  });
}

const cssFiles = walk(srcDir, /\.css$/);
const read = (p: string) => readFileSync(p, "utf8");
const rel = (p: string) => path.relative(webRoot, p);
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

type Rule = { selector: string; body: string; parents: string[] };

/** Innermost blocks of a stylesheet (no CSS nesting is used): selector, declarations, enclosing at-rules. */
function rules(css: string): Rule[] {
  const out: Rule[] = [];
  const stack: string[] = [];
  let buf = "";
  for (const ch of stripComments(css)) {
    if (ch === "{") {
      stack.push(buf.trim().replace(/\s+/g, " "));
      buf = "";
    } else if (ch === "}") {
      const selector = stack.pop() ?? "";
      if (buf.trim()) out.push({ selector, body: buf.trim(), parents: [...stack] });
      buf = "";
    } else buf += ch;
  }
  return out;
}

/** `--name: value;` pairs of a block, in order. */
function declarations(body: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)) map.set(m[1]!, m[2]!.trim());
  return map;
}

const tokensCss = read(path.join(srcDir, "styles/tokens.css"));
const tokenRules = rules(tokensCss);
const block = (selector: string, parents: string[] = []) => {
  const found = tokenRules.filter((r) => r.selector === selector && r.parents.join("|") === parents.join("|"));
  expect(found, `${selector} in ${parents.join(" ") || "the top level"}`).toHaveLength(1);
  return declarations(found[0]!.body);
};

const LIGHT = block(":root");
const DARK_OS = block(':root:not([data-theme="light"])', ["@media (prefers-color-scheme: dark)"]);
const DARK_MANUAL = block(':root[data-theme="dark"]');

/** A theme's colours: the light values with the dark block on top, var() references resolved. */
function theme(over?: Map<string, string>): (name: string) => string {
  const all = new Map([...LIGHT, ...(over ?? [])]);
  const get = (name: string, depth = 0): string => {
    const v = all.get(name);
    if (!v) throw new Error(`${name} is not declared`);
    const ref = /^var\((--[\w-]+)\)$/.exec(v);
    if (ref && depth < 5) return get(ref[1]!, depth + 1);
    return v;
  };
  return (name) => get(`--${name}`);
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const TEXT = 4.5;
const UI = 3;
const SOFT_FILLS = ["accent-soft", "shu-soft", "mist", "sand", "lavender", "gray-soft"];

/** docs/design.md "コントラスト": [foreground, background, minimum]. */
const PAIRS: [string, string, number][] = [
  ...["bg", "surface", "bg-2", ...SOFT_FILLS].map((bg): [string, string, number] => ["ink", bg, TEXT]),
  ...["bg", "surface", "bg-2", ...SOFT_FILLS].map((bg): [string, string, number] => ["muted", bg, TEXT]),
  ...["bg", "surface", "bg-2", "accent-soft"].map((bg): [string, string, number] => ["accent-ink", bg, TEXT]),
  ...["bg", "surface", "shu-soft"].map((bg): [string, string, number] => ["shu-ink", bg, TEXT]),
  ["slate", "surface", TEXT],
  ["slate", "mist", TEXT],
  ["amber-ink", "bg", TEXT],
  ["amber-ink", "sand", TEXT],
  ["amber-ink", "surface", TEXT],
  ["on-primary", "accent", TEXT],
  ["on-primary", "accent-hover", TEXT],
  ["toast-fg", "toast-bg", TEXT],
  // Control borders, the seal and the focus ring (1.4.11).
  ...["bg", "surface", "bg-2"].map((bg): [string, string, number] => ["line", bg, UI]),
  ...["bg", "surface", "shu-soft", "accent-soft"].map((bg): [string, string, number] => ["shu", bg, UI]),
  ...["bg", "surface", "bg-2"].map((bg): [string, string, number] => ["accent-ink", bg, UI]),
];

describe("tokens.css", () => {
  it("(a) the two dark blocks (OS dark, manual dark) declare the same variables with the same values", () => {
    expect([...DARK_MANUAL.entries()].sort()).toEqual([...DARK_OS.entries()].sort());
    expect(DARK_OS.size).toBeGreaterThan(20);
  });

  it.each([
    ["light", theme()],
    ["dark", theme(DARK_OS)],
  ] as const)("(b) the contrast table holds in %s", (_name, t) => {
    const fails = PAIRS.map(([fg, bg, min]) => ({ fg, bg, min, ratio: Math.round(contrast(t(fg), t(bg)) * 100) / 100 })).filter((p) => p.ratio < p.min);
    expect(fails).toEqual([]);
  });

  it("(b) light only: --line on --accent-soft is 3:1 (in the dark, selected states use --accent-ink)", () => {
    const light = theme();
    expect(contrast(light("line"), light("accent-soft"))).toBeGreaterThanOrEqual(UI);
  });

  it("(i) more contrast: --line and every --rule line are ink, --muted is darker, in light, OS dark and manual dark", () => {
    const more = "@media (prefers-contrast: more)";
    const blocks = [
      block(":root", [more]),
      block(':root[data-theme="dark"]', [more]),
      block(':root:not([data-theme="light"])', ["@media (prefers-contrast: more) and (prefers-color-scheme: dark)"]),
    ];
    for (const b of blocks) {
      expect(b.get("--line")).toBe("var(--ink)");
      expect(b.get("--rule")).toBe("var(--line)");
      expect(b.get("--muted")).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(contrast(blocks[0]!.get("--muted")!, theme()("bg"))).toBeGreaterThanOrEqual(7);
    expect(contrast(blocks[1]!.get("--muted")!, theme(DARK_OS)("bg"))).toBeGreaterThanOrEqual(7);
    expect(blocks[2]!.get("--muted")).toBe(blocks[1]!.get("--muted"));
    // After the dark blocks, so they win.
    expect(tokensCss.indexOf(more)).toBeGreaterThan(tokensCss.indexOf(':root[data-theme="dark"] {'));
  });
});

describe("the CSS under apps/web/src", () => {
  const all = cssFiles.map((f) => ({ file: rel(f), css: stripComments(read(f)), rules: rules(read(f)) }));

  it("(c) uses only custom properties that some stylesheet declares", () => {
    const declared = new Set(all.flatMap(({ css }) => [...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1])));
    const missing = all.flatMap(({ file, css }) => [...css.matchAll(/var\(\s*(--[\w-]+)/g)].filter((m) => !declared.has(m[1])).map((m) => `${file}: ${m[1]}`));
    expect(missing).toEqual([]);
  });

  it("(d) has no trace of the old fonts (also the share page and the icon script)", () => {
    const files = [...walk(srcDir, /\.(css|ts|tsx)$/), path.resolve(webRoot, "../api/src/share-page.ts"), ...walk(path.join(webRoot, "scripts"), /\.(mjs|js|ts)$/)];
    const hits = files.filter((f) => /Dela Gothic One|Zen Kaku/i.test(read(f))).map(rel);
    expect(hits).toEqual([]);
  });

  it("(e) has no hard offset shadow (x/y offset with no blur)", () => {
    const hard = all.flatMap(({ file, rules: rs }) =>
      rs.flatMap((r) =>
        [...r.body.matchAll(/(?:box-shadow|--shadow[\w-]*)\s*:\s*([^;]+)/g)].flatMap((m) =>
          [...m[1]!.matchAll(/(-?\d*\.?\d+)(?:px)?\s+(-?\d*\.?\d+)(?:px)?\s+0(?:px)?(?=[\s,;)]|$)/g)]
            .filter((s) => Number(s[1]) !== 0 || Number(s[2]) !== 0)
            .map(() => `${file}: ${r.selector} { ${m[0]} }`),
        ),
      ),
    );
    expect(hard).toEqual([]);
  });

  it("(f) tilts only the seal (-4deg, also in its keyframes) and the ✓ drawn with borders (45deg)", () => {
    const bad = all.flatMap(({ file, rules: rs }) =>
      rs.flatMap((r) =>
        [...r.body.matchAll(/rotate\(\s*([^)]+)\)/g)]
          .filter((m) => {
            const angle = m[1]!.replace(/\s/g, "");
            const seal = angle === "-4deg" && (/seal|\.st\b/.test(r.selector) || r.parents.some((p) => /^@keyframes stamp/.test(p)));
            const check = angle === "45deg" && /::(before|after)/.test(r.selector) && /border-width:\s*0 2px 2px 0/.test(r.body);
            return !seal && !check;
          })
          .map((m) => `${file}: ${r.selector} { ${m[0]} }`),
      ),
    );
    expect(bad).toEqual([]);
  });

  it("(g) uses no raw #hex colour outside tokens.css", () => {
    const raw = all
      .filter(({ file }) => !file.endsWith("styles/tokens.css"))
      .flatMap(({ file, rules: rs }) => rs.flatMap((r) => [...r.body.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => `${file}: ${r.selector} ${m[0]}`)));
    expect(raw).toEqual([]);
  });

  it("(h) components.css: ::before / ::after never carry text", () => {
    const components = all.find(({ file }) => file.endsWith("styles/components.css"))!;
    const texts = components.rules
      .filter((r) => /::?(before|after)/.test(r.selector))
      .flatMap((r) => [...r.body.matchAll(/content\s*:\s*([^;]+)/g)].map((m) => m[1]!.trim()).filter((v) => v !== '""' && v !== "none").map((v) => `${r.selector} { content: ${v} }`));
    expect(texts).toEqual([]);
  });

  it("(j) form fields keep the focus ring (no outline: none on their :focus)", () => {
    const hidden = all.flatMap(({ file, rules: rs }) =>
      rs
        .filter((r) => /(input|textarea|select)[^,]*:focus(?!-visible)/.test(r.selector) && !/:not\(:focus-visible\)/.test(r.selector))
        .filter((r) => /outline\s*:\s*(none|0)\b/.test(r.body))
        .map((r) => `${file}: ${r.selector}`),
    );
    expect(hidden).toEqual([]);
  });

  it("(j) forced colours: every block that draws a state with an outline ends with a focus rule that wins", () => {
    const problems: string[] = [];
    for (const { file, rules: rs } of all) {
      const forced = rs.filter((r) => r.parents.some((p) => p.includes("forced-colors: active")));
      const stateOutlines = forced.filter((r) => /(^|\s|;)outline\s*:/.test(r.body) && !r.selector.includes("focus-visible"));
      if (stateOutlines.length === 0) continue;
      const lastState = forced.lastIndexOf(stateOutlines.at(-1)!);
      const focus = forced.slice(lastState + 1).filter((r) => r.selector.includes("focus-visible") && /outline\s*:/.test(r.body));
      if (focus.length === 0) problems.push(`${file}: no :focus-visible outline after the selected-state outlines`);
      // Every element that gets a state outline gets the focus rule too (same element, same or higher specificity).
      for (const r of stateOutlines) {
        for (const sel of r.selector.split(",").map((s) => s.trim())) {
          const base = /^\.?[\w-]+/.exec(sel)?.[0] ?? sel;
          if (!focus.some((f) => f.selector.split(",").some((s) => s.trim().startsWith(base)))) problems.push(`${file}: ${sel} has no focus rule after it`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("(k) sets handwriting at 17px or more, except for seal characters", () => {
    const small = all.flatMap(({ file, rules: rs }) =>
      rs
        .filter((r) => /font-family\s*:\s*var\(--font-hand\)/.test(r.body) && !/seal|\.st\b/.test(r.selector))
        .flatMap((r) => [...r.body.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px\s*[;]?/g)].filter((m) => Number(m[1]) < 17).map((m) => `${file}: ${r.selector} ${m[1]}px`)),
    );
    expect(small).toEqual([]);
  });
});
