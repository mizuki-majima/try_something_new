// Self-hosted fonts (no Google Fonts; CSP font-src 'self'). Each "<weight>.css" splits Japanese into
// ~120 unicode-range slices, so the browser downloads only the glyphs on screen (the single-file
// "japanese-*.css" variants are 1–1.4MB per weight). The declarations themselves are ~200KB gzip,
// so this module is loaded asynchronously (lib/fonts.ts) instead of blocking the first paint.
//
// NEO-BRUTALISM (docs/design.md): Dela Gothic One for display / numbers / seals (one weight),
// Zen Kaku Gothic New 400 / 700 / 900 for text.
import "@fontsource/zen-kaku-gothic-new/400.css";
import "@fontsource/zen-kaku-gothic-new/700.css";
import "@fontsource/zen-kaku-gothic-new/900.css";
import "@fontsource/dela-gothic-one/400.css";
