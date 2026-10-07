import { useEffect, useSyncExternalStore } from "react";

function subscribeOnline(l: () => void): () => void {
  window.addEventListener("online", l);
  window.addEventListener("offline", l);
  return () => {
    window.removeEventListener("online", l);
    window.removeEventListener("offline", l);
  };
}

/** navigator.onLine as state. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine !== false,
    () => true,
  );
}

const SITE = "30日だけ";

/** Sets document.title to "<title> | 30日だけ" (or just the site name). */
export function usePageTitle(title?: string): void {
  useEffect(() => {
    document.title = title ? `${title} | ${SITE}` : SITE;
  }, [title]);
}

/** True when the user asked the OS for less motion (skip the gacha spin etc.). */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}
