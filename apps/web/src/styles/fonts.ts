// Self-hosted web font (no Google Fonts; CSP font-src 'self'). Only Klee One 600, for handwritten
// headings, the brand, seals and big numbers; body text uses the device's own fonts (tokens.css).
// "600.css" splits Japanese into ~120 unicode-range slices, so the browser downloads only the glyphs
// on screen. Loaded asynchronously by lib/fonts.ts (and skipped under Save-Data).
import "@fontsource/klee-one/600.css";
