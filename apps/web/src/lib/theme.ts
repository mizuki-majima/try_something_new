/**
 * Light / dark / follow the device (FR-21). The choice is stored per device and applied as
 * data-theme on <html>; tokens.css does the rest.
 */
import { useSyncExternalStore } from "react";
import { KEYS, readString, writeString } from "./storage";

export type ThemePref = "system" | "light" | "dark";

/**
 * Browser chrome color = the header (--bg in tokens.css, light and 「夜のノート」 dark). Keep in step
 * with index.html (theme-color metas) and vite.config.ts (manifest).
 */
export const THEME_COLORS = { light: "#faf8f4", dark: "#1c1b19" } as const;

const listeners = new Set<() => void>();

export function getThemePref(): ThemePref {
  const v = readString(KEYS.theme);
  return v === "light" || v === "dark" ? v : "system";
}

export function applyTheme(pref: ThemePref): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (pref === "system") delete root.dataset.theme;
  else root.dataset.theme = pref;

  // index.html ships two theme-color metas (light/dark media). A manual choice overrides both.
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    const media = meta.getAttribute("media") ?? "";
    const own = media.includes("dark") ? THEME_COLORS.dark : THEME_COLORS.light;
    meta.content = pref === "system" ? own : THEME_COLORS[pref];
  });
}

export function setThemePref(pref: ThemePref): void {
  writeString(KEYS.theme, pref);
  applyTheme(pref);
  for (const l of [...listeners]) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useThemePref(): [ThemePref, (pref: ThemePref) => void] {
  const pref = useSyncExternalStore(subscribe, getThemePref, () => "system" as ThemePref);
  return [pref, setThemePref];
}
