/**
 * Service worker (vite-plugin-pwa, injectManifest).
 * - Precaches the app shell (JS/CSS/HTML/icons; fonts are excluded and cached on first use).
 * - SPA navigations fall back to /index.html, except server routes (/api, /s, /media).
 * - Recipe lists are served stale-while-revalidate; a request with cache "no-cache"/"reload"
 *   (e.g. right after posting) goes to the network first.
 * - Web Push reminders (FR-14).
 * Updates: skipWaiting + clientsClaim ("autoUpdate"). Pending writes live in localStorage, so a
 * new version taking over loses nothing; an old tab that misses a lazy chunk reloads (main.tsx).
 */
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { clientsClaim } from "workbox-core";
import { ExpirationPlugin } from "workbox-expiration";
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute, type PrecacheEntry } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst, NetworkFirst, StaleWhileRevalidate } from "workbox-strategies";

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<PrecacheEntry | string> };

void self.skipWaiting();
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), {
    denylist: [/^\/api\//, /^\/s\//, /^\/media\//],
  }),
);

const sameOrigin = (url: URL) => url.origin === self.location.origin;

registerRoute(
  ({ request, url }) => sameOrigin(url) && (request.destination === "font" || /\.(woff2?|ttf|otf)$/.test(url.pathname)),
  new CacheFirst({
    cacheName: "fonts",
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({ maxEntries: 400, maxAgeSeconds: 365 * 24 * 60 * 60 }),
    ],
  }),
);

const RECIPES_PATH = /^\/api\/recipes(\/[0-9a-z][0-9a-z-]*)?$/;
const recipePlugins = [
  new CacheableResponsePlugin({ statuses: [200] }),
  new ExpirationPlugin({ maxEntries: 80, maxAgeSeconds: 14 * 24 * 60 * 60 }),
];
const recipesStale = new StaleWhileRevalidate({ cacheName: "api-recipes", plugins: recipePlugins });
const recipesFresh = new NetworkFirst({ cacheName: "api-recipes", networkTimeoutSeconds: 6, plugins: recipePlugins });

registerRoute(
  ({ url }) => sameOrigin(url) && RECIPES_PATH.test(url.pathname),
  (options) => {
    const mode = options.request.cache;
    return (mode === "no-cache" || mode === "reload" || mode === "no-store" ? recipesFresh : recipesStale).handle(options);
  },
  "GET",
);

// ---------- push ----------

type PushPayload = { title?: unknown; body?: unknown; url?: unknown; tag?: unknown };

/** Only same-origin paths; anything else opens the app root. */
function safePath(url: unknown): string {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//") ? url : "/";
}

function readPayload(event: PushEvent): PushPayload {
  if (!event.data) return {};
  try {
    return event.data.json() as PushPayload;
  } catch {
    return { body: event.data.text() };
  }
}

self.addEventListener("push", (event) => {
  const p = readPayload(event);
  const title = typeof p.title === "string" && p.title ? p.title : "30日だけ";
  const body = typeof p.body === "string" ? p.body : "きょうの分を押しましょう。";
  const tag = typeof p.tag === "string" && p.tag ? p.tag : "reminder";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-72.png",
      data: { url: safePath(p.url) },
      tag,
      lang: "ja",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = safePath((event.notification.data as { url?: unknown } | null)?.url);
  const target = new URL(path, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const exact = windows.find((w) => w.url === target);
      if (exact) {
        await exact.focus();
        return;
      }
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        // The app navigates client-side (Layout listens for this), keeping its state.
        open.postMessage({ type: "thirty:navigate", url: path });
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
