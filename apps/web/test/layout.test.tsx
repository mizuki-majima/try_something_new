/**
 * The app menu after #20: four tabs (きょう / えらぶ / みんな / 記録) in the phone tab bar and the desktop
 * nav, which tab is current (activeTab, from the path and the challenge's state), the header link
 * 「設定」 with visible text, and the 「えらびかた」 switch between レシピ and ガチャ.
 */
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import type { Challenge } from "@thirty/shared";
import { ChooseNav } from "../src/components/ChooseNav";
import { Layout, TABS, activeTab } from "../src/components/Layout";
import { ToastProvider } from "../src/components/Toast";
import { createAppStore, type AppSnapshot, type AppStore } from "../src/lib/appStore";
import { AppProvider } from "../src/lib/store";

const DONE_ID = "done000000000001";
const OPEN_ID = "open000000000002";

const pick = (id: string, status: Challenge["status"]) => ({ id, status });
const CHALLENGES = [pick(DONE_ID, "done"), pick(OPEN_ID, "active")];

function challenge(id: string, status: Challenge["status"]): Challenge {
  return {
    id,
    recipeId: "photo",
    title: "毎日1枚、写真を撮る",
    seal: "写",
    startDate: "2026-09-01",
    status,
    stamps: {},
    verdict: status === "done" ? "continue" : null,
    reflection: null,
    finishedAt: status === "done" ? 5 : null,
    finishedDay: status === "done" ? 30 : null,
    cheers: 0,
    shareId: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** A store that holds `challenges` and never syncs. */
function storeWith(challenges: Challenge[]): AppStore {
  const store = createAppStore();
  const snap: AppSnapshot = { ...store.getSnapshot(), challenges, ready: true };
  return { ...store, getSnapshot: () => snap, subscribe: () => () => {}, start: () => () => {} };
}

function renderLayout(path: string, challenges: Challenge[] = []) {
  localStorage.removeItem("thirty-days.token");
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <AppProvider store={storeWith(challenges)}>
          <Routes>
            <Route element={<Layout />}>
              <Route path="*" element={<h1>ページ</h1>} />
            </Route>
          </Routes>
        </AppProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** Both menus (the phone tab bar and the desktop nav; CSS shows one of them). */
const menus = () => screen.getAllByRole("navigation", { name: "メニュー" });
const current = (nav: HTMLElement) =>
  within(nav)
    .getAllByRole("link")
    .filter((a) => a.getAttribute("aria-current") === "page")
    .map((a) => a.textContent);

describe("menu (tab bar and top nav)", () => {
  it("has exactly four links in order: きょう / えらぶ / みんな / 記録", () => {
    renderLayout("/");
    expect(TABS.map((t) => t.label)).toEqual(["きょう", "えらぶ", "みんな", "記録"]);
    const navs = menus();
    expect(navs).toHaveLength(2);
    for (const nav of navs) {
      expect(within(nav).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
        ["きょう", "/"],
        ["えらぶ", "/recipes"],
        ["みんな", "/together"],
        ["記録", "/log"],
      ]);
    }
  });

  it("marks えらぶ on the recipe pages and on ガチャ (old URLs still open their pages)", () => {
    for (const path of ["/recipes", "/recipes/photo", "/recipes/new", "/gacha"]) {
      const { unmount } = renderLayout(path);
      for (const nav of menus()) expect(current(nav), path).toEqual(["えらぶ"]);
      unmount();
    }
  });

  it("marks 記録 on a finished challenge's page, きょう on any other", () => {
    let r = renderLayout(`/c/${DONE_ID}`, [challenge(DONE_ID, "done")]);
    for (const nav of menus()) expect(current(nav)).toEqual(["記録"]);
    r.unmount();
    r = renderLayout(`/c/${OPEN_ID}/reflect`, [challenge(OPEN_ID, "active")]);
    for (const nav of menus()) expect(current(nav)).toEqual(["きょう"]);
    r.unmount();
  });

  it("marks no tab on 設定, and the header link 「設定」 is current there", () => {
    renderLayout("/settings");
    for (const nav of menus()) expect(current(nav)).toEqual([]);
    expect(screen.getByRole("link", { name: "設定" }).getAttribute("aria-current")).toBe("page");
  });
});

describe("activeTab", () => {
  it.each([
    ["/", "today"],
    ["/recipes", "choose"],
    ["/recipes/", "choose"],
    ["/recipes/x", "choose"],
    ["/recipes/new", "choose"],
    ["/gacha", "choose"],
    ["/together", "together"],
    ["/log", "log"],
    [`/c/${DONE_ID}`, "log"],
    [`/c/${DONE_ID}/reflect`, "log"],
    [`/c/${OPEN_ID}`, "today"],
    [`/c/${OPEN_ID}/reflect`, "today"],
    ["/c/unknown00000000", "today"],
    ["/settings", null],
    ["/about", null],
    ["/terms", null],
    ["/no-such-page", null],
  ] as const)("%s → %s", (path, tab) => {
    expect(activeTab(path, CHALLENGES)).toBe(tab);
  });

  it("follows the challenge's state, not where it was opened from", () => {
    expect(activeTab(`/c/${OPEN_ID}`, [pick(OPEN_ID, "active")])).toBe("today");
    expect(activeTab(`/c/${OPEN_ID}`, [pick(OPEN_ID, "done")])).toBe("log");
  });
});

describe("header 「設定」", () => {
  it("is a link with visible text whose name is exactly 「設定」, to /settings", () => {
    renderLayout("/");
    const link = screen.getByRole("link", { name: "設定" });
    expect(link.getAttribute("href")).toBe("/settings");
    expect(link.textContent).toBe("設定");
    expect(link.getAttribute("aria-current")).toBeNull();
    // The gear is decorative.
    expect(link.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("ChooseNav (えらびかた)", () => {
  it.each([
    ["recipes", "レシピ"],
    ["gacha", "ガチャ"],
  ] as const)("on %s: two links, the current one marked", (page, label) => {
    render(
      <MemoryRouter>
        <ChooseNav current={page} />
      </MemoryRouter>,
    );
    const nav = screen.getByRole("navigation", { name: "えらびかた" });
    expect(within(nav).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["レシピ", "/recipes"],
      ["ガチャ", "/gacha"],
    ]);
    expect(current(nav)).toEqual([label]);
  });
});
