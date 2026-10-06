import "@fontsource/kiwi-maru/400.css";
import "@fontsource/kiwi-maru/500.css";
import "@fontsource/zen-kaku-gothic-new/400.css";
import "@fontsource/zen-kaku-gothic-new/500.css";
import "@fontsource/zen-kaku-gothic-new/700.css";
import "@fontsource/dela-gothic-one/400.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import App from "./App";
import { ToastProvider } from "./components/Toast";
import { AppProvider } from "./lib/store";
import { applyTheme, getThemePref } from "./lib/theme";

// The @fontsource "<weight>.css" files split Japanese into ~120 unicode-range slices, so the
// browser downloads only the glyphs on screen (the single-file "japanese-*.css" is 1–1.4MB per weight).

applyTheme(getThemePref());

// After a deploy, an old tab may ask for a lazy chunk that no longer exists: reload once
// (the flag clears after a while so a later deploy in the same tab can reload again).
const CHUNK_RELOAD_KEY = "thirty-days.reloaded-for-chunk";
setTimeout(() => {
  try {
    sessionStorage.removeItem(CHUNK_RELOAD_KEY);
  } catch {
    // storage unavailable
  }
}, 30_000);
window.addEventListener("vite:preloadError", (event) => {
  const key = CHUNK_RELOAD_KEY;
  try {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
  } catch {
    return;
  }
  event.preventDefault();
  window.location.reload();
});

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AppProvider>
          <App />
        </AppProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
