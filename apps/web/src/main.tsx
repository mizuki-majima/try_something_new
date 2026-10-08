// zod's jitless flag is set by /zod-jitless.js (index.html), before any module chunk runs (CSP).
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import App from "./App";
import { ToastProvider } from "./components/Toast";
import { loadFonts } from "./lib/fonts";
import { startPushResync } from "./lib/push";
import { AppProvider } from "./lib/store";
import { applyTheme, getThemePref } from "./lib/theme";

// /theme-boot.js (index.html) already applied a manual choice before the first paint; the app's own
// applyTheme stays the source of truth (and the only one that runs when the choice changes).
applyTheme(getThemePref());
void loadFonts();
startPushResync(); // re-register this device's push subscription (endpoints rotate)

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
