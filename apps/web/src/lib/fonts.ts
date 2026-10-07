/**
 * Web fonts are declared in a separate, lazily loaded stylesheet (see styles/fonts.ts).
 * Text renders with system fonts first and swaps in. Anything that draws text on a canvas
 * (the share card) must wait:
 *
 *   await loadFonts();
 *   await document.fonts.load('400 48px "Dela Gothic One"', text);
 *   await document.fonts.load('700 20px "Zen Kaku Gothic New"', text);
 *
 * Dela Gothic One has a single weight (400): draw it with "400", never "bold".
 * Zen Kaku Gothic New is loaded in 400 / 700 / 900.
 */
let loading: Promise<void> | null = null;

export function loadFonts(): Promise<void> {
  loading ??= import("../styles/fonts").then(
    () => undefined,
    () => {
      loading = null; // allow another try (e.g. offline before the stylesheet was cached)
    },
  );
  return loading;
}

/** CSS font stacks, matching tokens.css (for canvas drawing). */
export const FONT_STACKS = {
  display: '"Dela Gothic One", "Zen Kaku Gothic New", "Hiragino Sans", "Yu Gothic", system-ui, sans-serif',
  body: '"Zen Kaku Gothic New", "Hiragino Sans", "Yu Gothic", system-ui, sans-serif',
  num: '"Dela Gothic One", "Zen Kaku Gothic New", "Hiragino Sans", "Yu Gothic", system-ui, sans-serif',
} as const;
