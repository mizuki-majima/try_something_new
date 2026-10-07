/**
 * App shell: sticky header (brand, desktop nav, sync status, settings), bands for offline and a
 * broken session, the page (<Outlet/>), the footer links (about / terms / privacy / contact), the
 * phone tab bar and the toast live region.
 */
import { Suspense, useEffect, useRef, type ComponentType, type RefObject } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router";
import { useSync } from "../lib/store";
import { ErrorBoundary } from "./ErrorBoundary";
import { ArchiveIcon, BookIcon, DiceIcon, PeopleIcon, SettingsIcon, StampIcon } from "./Icons";
import { OfflineBanner, SessionBanner } from "./OfflineBanner";
import { Seal } from "./Seal";
import { Loading } from "./States";
import { ToastHost } from "./Toast";

type Tab = { to: string; label: string; Icon: ComponentType; match: (path: string) => boolean };

export const TABS: readonly Tab[] = [
  { to: "/", label: "きょう", Icon: StampIcon, match: (p) => p === "/" || p.startsWith("/c/") },
  { to: "/recipes", label: "レシピ", Icon: BookIcon, match: (p) => p === "/recipes" || p.startsWith("/recipes/") },
  { to: "/gacha", label: "ガチャ", Icon: DiceIcon, match: (p) => p === "/gacha" },
  { to: "/together", label: "みんな", Icon: PeopleIcon, match: (p) => p === "/together" },
  { to: "/log", label: "記録", Icon: ArchiveIcon, match: (p) => p === "/log" },
];

const SYNC_TEXT = {
  synced: "同期済み",
  pending: "同期中…",
  offline: "オフライン・あとで同期",
  error: "同期できません",
} as const;

function SyncPill() {
  const { status, pending, hasSession, lastSyncError } = useSync();
  const localOnly = status === "synced" && !hasSession;
  const text = localOnly ? "この端末" : SYNC_TEXT[status];
  const cls = `sync ${localOnly ? "local" : status}`;
  const title =
    status === "synced"
      ? hasSession
        ? "記録はサーバーに保存されています"
        : "まだこの端末だけに保存しています"
      : pending > 0
        ? `送信待ち ${pending}件${lastSyncError ? `（${lastSyncError}）` : ""}`
        : (lastSyncError ?? undefined);
  if (status === "error") {
    return (
      <Link to="/settings#transfer" className={cls} title={title} data-testid="sync-status">
        {text}
      </Link>
    );
  }
  return (
    <span className={cls} title={title} data-testid="sync-status">
      {text}
    </span>
  );
}

/** Scroll to top and move focus to the page on navigation (not on first load). */
function useRouteFocus(mainRef: RefObject<HTMLElement | null>) {
  const { pathname, hash } = useLocation();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (hash) {
      const id = decodeURIComponent(hash.slice(1));
      requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView());
      return;
    }
    window.scrollTo(0, 0);
    mainRef.current?.focus({ preventScroll: true });
  }, [pathname, hash, mainRef]);
}

/** The service worker asks an open window to show a notification's page (sw.ts notificationclick). */
function useServiceWorkerNavigation() {
  const navigate = useNavigate();
  useEffect(() => {
    const sw = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
    if (!sw) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: unknown; url?: unknown } | null;
      if (data?.type === "thirty:navigate" && typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//")) {
        navigate(data.url);
      }
    };
    sw.addEventListener("message", onMessage);
    return () => sw.removeEventListener("message", onMessage);
  }, [navigate]);
}

/** About and the legal pages, reachable from every screen (the Terms bind from the first use). */
export const FOOTER_LINKS: readonly { to: string; label: string }[] = [
  { to: "/about", label: "このサービスについて" },
  { to: "/terms", label: "利用規約" },
  { to: "/privacy", label: "プライバシーポリシー" },
  { to: "/contact", label: "お問い合わせ" },
];

export function SiteFooter() {
  return (
    <footer className="site-foot">
      <nav aria-label="このサイトについて">
        {FOOTER_LINKS.map((l) => (
          <Link key={l.to} to={l.to}>
            {l.label}
          </Link>
        ))}
      </nav>
    </footer>
  );
}

export function Layout() {
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  useRouteFocus(mainRef);
  useServiceWorkerNavigation();

  return (
    <>
      <a className="skip-link" href="#main">
        本文へ移動
      </a>
      <header className="top">
        <div className="top-in">
          <Link to="/" className="brand" aria-label="30日だけ（きょう）">
            <Seal char="卅" />
            <span className="brand-name">30日だけ</span>
          </Link>
          <nav className="nav" aria-label="メニュー">
            {TABS.map((t) => (
              <Link key={t.to} to={t.to} aria-current={t.match(pathname) ? "page" : undefined}>
                {t.label}
              </Link>
            ))}
          </nav>
          <div className="top-actions">
            <SyncPill />
            <Link to="/settings" className="iconbtn" aria-label="設定" aria-current={pathname === "/settings" ? "page" : undefined}>
              <SettingsIcon />
            </Link>
          </div>
        </div>
      </header>
      <OfflineBanner />
      <SessionBanner />
      <main id="main" className="wrap" ref={mainRef} tabIndex={-1}>
        <ErrorBoundary key={pathname}>
          <Suspense fallback={<Loading />}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>
      <SiteFooter />
      <nav className="tabbar" aria-label="メニュー">
        {TABS.map(({ to, label, Icon, match }) => (
          <Link key={to} to={to} aria-current={match(pathname) ? "page" : undefined}>
            <Icon />
            <span>{label}</span>
          </Link>
        ))}
      </nav>
      <ToastHost />
    </>
  );
}
