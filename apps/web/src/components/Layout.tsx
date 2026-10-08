/**
 * App shell: sticky header (brand, desktop nav, sync status, 「設定」), bands for offline, a
 * server-requested wait (429), a broken session and a notice (お知らせ, e.g. revised Terms), the page
 * (<Outlet/>), the footer links (about / terms / privacy / contact), the phone tab bar and the toast
 * live region.
 *
 * Four tabs (#20): きょう / えらぶ (レシピ and ガチャ, see ChooseNav) / みんな / 記録. Which one is
 * current comes from activeTab(): a challenge page belongs to 記録 once the challenge is done, else to
 * きょう, so a reload or a link from a calendar event marks the same tab. On ガチャ, えらぶ links to
 * /gacha itself (tabTarget), so tapping the current tab keeps the page and its result.
 */
import { Suspense, useEffect, useRef, type ComponentType, type RefObject } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router";
import type { Challenge } from "@thirty/shared";
import { useChallenges, useSync } from "../lib/store";
import { ErrorBoundary } from "./ErrorBoundary";
import { ArchiveIcon, BookIcon, PeopleIcon, SettingsIcon, StampIcon } from "./Icons";
import { NoticeBanner } from "./NoticeBanner";
import { OfflineBanner, SessionBanner, ThrottleBanner } from "./OfflineBanner";
import { Seal } from "./Seal";
import { Loading } from "./States";
import { ToastHost } from "./Toast";

export type TabId = "today" | "choose" | "together" | "log";

export type Tab = { id: TabId; to: string; label: string; Icon: ComponentType };

/** The app menu: the phone tab bar and the desktop top nav (both named 「メニュー」). */
export const TABS: readonly Tab[] = [
  { id: "today", to: "/", label: "きょう", Icon: StampIcon },
  { id: "choose", to: "/recipes", label: "えらぶ", Icon: BookIcon },
  { id: "together", to: "/together", label: "みんな", Icon: PeopleIcon },
  { id: "log", to: "/log", label: "記録", Icon: ArchiveIcon },
];

/**
 * The tab a path belongs to, or null (settings, about, legal pages, 404).
 * /c/:id and /c/:id/reflect: 記録 when that challenge is done, else きょう (also while it is unknown).
 */
export function activeTab(pathname: string, challenges: readonly Pick<Challenge, "id" | "status">[]): TabId | null {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/") return "today";
  if (p.startsWith("/c/")) {
    let id = p.slice(3).split("/")[0] ?? "";
    try {
      id = decodeURIComponent(id);
    } catch {
      // a malformed escape: not a challenge id
    }
    return challenges.find((c) => c.id === id)?.status === "done" ? "log" : "today";
  }
  if (p === "/recipes" || p.startsWith("/recipes/") || p === "/gacha") return "choose";
  if (p === "/together") return "together";
  if (p === "/log") return "log";
  return null;
}

/**
 * Where a tab's link goes from `pathname`. On ガチャ, えらぶ (the current tab) stays on /gacha: a tap
 * on it is then a same-page navigation that keeps the roll and the ひらめき提案 ideas, like the old
 * ガチャ tab did. Everywhere else it opens the recipe list.
 */
export function tabTarget(tab: Tab, pathname: string): string {
  if (tab.id === "choose" && pathname.replace(/\/+$/, "") === "/gacha") return "/gacha";
  return tab.to;
}

const SYNC_TEXT = {
  synced: "同期済み",
  pending: "同期中…",
  waiting: "送信待ち",
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
  const challenges = useChallenges();
  const current = activeTab(pathname, challenges);
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
              <Link key={t.id} to={tabTarget(t, pathname)} aria-current={current === t.id ? "page" : undefined}>
                {t.label}
              </Link>
            ))}
          </nav>
          <div className="top-actions">
            <SyncPill />
            {/* Visible text; the gear is decorative, so the link's name is exactly 「設定」. */}
            <Link to="/settings" className="top-settings" aria-current={pathname === "/settings" ? "page" : undefined}>
              <SettingsIcon />
              <span>設定</span>
            </Link>
          </div>
        </div>
      </header>
      <OfflineBanner />
      <ThrottleBanner />
      <SessionBanner />
      <NoticeBanner />
      <main id="main" className="wrap" ref={mainRef} tabIndex={-1}>
        <ErrorBoundary key={pathname}>
          <Suspense fallback={<Loading />}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>
      <SiteFooter />
      <nav className="tabbar" aria-label="メニュー">
        {TABS.map((t) => (
          <Link key={t.id} to={tabTarget(t, pathname)} aria-current={current === t.id ? "page" : undefined}>
            <t.Icon />
            <span>{t.label}</span>
          </Link>
        ))}
      </nav>
      <ToastHost />
    </>
  );
}
