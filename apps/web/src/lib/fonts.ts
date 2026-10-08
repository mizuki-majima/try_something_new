/**
 * The one web font (Klee One 600, handwritten headings) is declared in a separate, lazily loaded
 * stylesheet (see styles/fonts.ts). Text renders with system fonts first and swaps in.
 *
 * With Save-Data on (or prefers-reduced-data: reduce) nothing is loaded and headings stay in the
 * device's fonts, unless a caller needs the glyphs: drawing on a canvas (the share card) must wait,
 * so it forces the load:
 *
 *   await loadFonts({ force: true });
 *   await document.fonts.load('600 56px "Klee One"', text);
 *
 * Only weight 600 is loaded: draw Klee One with "600", never "bold" or "400".
 */
let loading: Promise<void> | null = null;

type NetworkInformationLike = { saveData?: boolean };

/** The person asked the browser to save data (Save-Data header / prefers-reduced-data). */
export function prefersReducedData(): boolean {
  const connection = typeof navigator !== "undefined" ? (navigator as Navigator & { connection?: NetworkInformationLike }).connection : undefined;
  if (connection?.saveData === true) return true;
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-data: reduce)").matches;
  } catch {
    return false;
  }
}

export function loadFonts({ force = false }: { force?: boolean } = {}): Promise<void> {
  if (!force && prefersReducedData()) return Promise.resolve();
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
  hand: '"Klee One", "Hiragino Maru Gothic ProN", "Hiragino Sans", "Noto Sans JP", "Noto Sans CJK JP", "Yu Gothic UI", system-ui, sans-serif',
  body: '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Noto Sans CJK JP", "Yu Gothic UI", Meiryo, system-ui, sans-serif',
} as const;
