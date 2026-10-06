import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/** Local API (npm run dev). Regex keys: a plain "/s" prefix would also swallow /settings and /src. */
const API_ORIGIN = "http://localhost:8787";
const proxy: Record<string, ProxyOptions> = {
  "^/api/": { target: API_ORIGIN },
  "^/s/": { target: API_ORIGIN },
  "^/media/": { target: API_ORIGIN },
};

/** Light theme paper (tokens.css --paper). */
const THEME_COLOR = "#fafaf6";

/**
 * @fontsource CSS lists a .woff fallback next to every .woff2. Every supported browser takes
 * woff2, so drop the fallback and halve the files we deploy.
 */
function woff2Only(): Plugin {
  return {
    name: "thirty:woff2-only",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("@fontsource") || !id.endsWith(".css")) return null;
      return { code: code.replace(/,\s*url\([^)]+\.woff\)\s*format\(['"]woff['"]\)/g, ""), map: null };
    },
  };
}

export default defineConfig({
  plugins: [
    woff2Only(),
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      // The SW calls skipWaiting/clientsClaim itself; the app keeps unsent writes in localStorage.
      registerType: "autoUpdate",
      // A /registerSW.js file instead of an inline snippet (CSP: script-src 'self').
      injectRegister: "script",
      manifest: {
        id: "/",
        name: "30日だけ",
        short_name: "30日だけ",
        description: "新しいことを、30日だけ試す。毎日1タップで印を押して、30日目に続けるかを決める。",
        lang: "ja",
        dir: "ltr",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        theme_color: THEME_COLOR,
        background_color: THEME_COLOR,
        categories: ["lifestyle", "productivity"],
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      injectManifest: {
        // Fonts are not precached (hundreds of unicode-range slices); sw.ts caches them on first use.
        globPatterns: ["**/*.{js,css,html,webmanifest}", "favicon.svg", "icons/*.png"],
        globIgnores: ["**/*.{woff,woff2,ttf,otf}", "og-default.png"],
        rollupFormat: "iife",
      },
      devOptions: { enabled: false },
    }),
  ],
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 4173, strictPort: true, proxy },
  build: {
    outDir: "dist",
    sourcemap: false,
    // Never inline fonts as data: URLs (CSP font-src 'self').
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
  },
});
