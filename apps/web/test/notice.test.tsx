/**
 * #17 (ADR 0007), notice first: the revised Terms and Privacy policy are announced on every screen
 * before they take effect (TermsPage 「規約の変更」). NoticeBanner in Layout: what it says, closing it,
 * no storage, and going away by itself NOTICE_DAYS after the effective date.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { addDays, diffDays } from "@thirty/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Layout } from "../src/components/Layout";
import { noticeVisible } from "../src/components/NoticeBanner";
import { ToastProvider } from "../src/components/Toast";
import { createAppStore } from "../src/lib/appStore";
import { EFFECTIVE, EFFECTIVE_ON, ENACTED, NOTICE_DAYS, NOTICE_HIDDEN_FROM, REVISED, REVISED_ON, jpFullDate, noticeShowsOn } from "../src/lib/legal";
import { KEYS, removeKey } from "../src/lib/storage";
import { AppProvider } from "../src/lib/store";

const TEXT = `お知らせ ${EFFECTIVE}以降、ひとことメモを日ごとに選んで「みんな」に見せられるようになります。選ばないひとことは、今までに書いたものも含めて、これまでどおり自分だけに見えます。利用規約とプライバシーポリシーの改定`;

/** Midday in Japan on `day`: the same date in every nearby time zone. */
const middayOn = (day: string) => new Date(`${day}T12:00:00+09:00`);

function renderLayout(path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <AppProvider store={createAppStore()}>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<h1>きょう</h1>} />
              <Route path="together" element={<h1>みんなの30日</h1>} />
              <Route path="terms" element={<h1>利用規約</h1>} />
              <Route path="privacy" element={<h1>プライバシーポリシー</h1>} />
            </Route>
          </Routes>
        </AppProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

const band = () => screen.queryByRole("region", { name: "お知らせ" });

beforeEach(() => {
  // Only Date: the store's "today" comes from it; timers and promises stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(middayOn(REVISED_ON));
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(null, { status: 404 })));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  removeKey(KEYS.noticeNoteShow); // also the in-memory copy kept while storage throws
});

describe("the legal dates", () => {
  it("are written once, and never apply before the revision", () => {
    expect(REVISED_ON).toBe("2026-10-08");
    // The CEO brought the effective date forward to the revision day (ADR 0007).
    expect(EFFECTIVE_ON).toBe("2026-10-08");
    expect(diffDays(REVISED_ON, EFFECTIVE_ON)).toBeGreaterThanOrEqual(0);
    expect(NOTICE_HIDDEN_FROM).toBe(addDays(EFFECTIVE_ON, 14));
    expect([ENACTED, REVISED, EFFECTIVE]).toEqual(["2026年10月6日", "2026年10月8日", jpFullDate(EFFECTIVE_ON)]);
    expect(jpFullDate("2026-10-14")).toBe("2026年10月14日");
    expect(jpFullDate("2027-01-05")).toBe("2027年1月5日");
  });
});

describe("NoticeBanner", () => {
  it("shows the notice under the header, in the page flow before the page, with the Terms link and a close button", () => {
    renderLayout();
    const notice = band()!;
    expect(notice).toBeTruthy();
    expect(notice.querySelector("p")?.textContent).toBe(TEXT);
    expect(within(notice).getByRole("link", { name: "利用規約とプライバシーポリシーの改定" }).getAttribute("href")).toBe("/terms");
    const close = within(notice).getByRole("button", { name: "お知らせを閉じる" });
    expect(close.textContent).toBe("閉じる");
    expect(close.getAttribute("type")).toBe("button");

    const main = screen.getByRole("main");
    expect(main.contains(notice)).toBe(false);
    expect(notice.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("banner").compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Not a live region: it is not read out again on every screen.
    expect(notice.closest("[role=status],[role=alert],[aria-live]")).toBeNull();
  });

  it("closing hides it, keeps the keyboard on the page and remembers it on this device", () => {
    const { unmount } = renderLayout();
    const close = within(band()!).getByRole("button", { name: "お知らせを閉じる" });
    close.focus();
    fireEvent.click(close);
    expect(band()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("main"));
    expect(localStorage.getItem(KEYS.noticeNoteShow)).toBe(EFFECTIVE_ON);

    unmount();
    renderLayout();
    expect(band()).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "きょう" })).toBeTruthy();
  });

  it("is on every screen but the Terms and the Privacy policy, which show the notice at their top", () => {
    for (const [path, shown] of [
      ["/together", true],
      ["/terms", false],
      ["/privacy", false],
    ] as const) {
      const { unmount } = renderLayout(path);
      expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
      expect(!!band(), path).toBe(shown);
      unmount();
    }
  });

  it("shows again when it was closed for another effective date", () => {
    localStorage.setItem(KEYS.noticeNoteShow, "2026-10-01");
    renderLayout();
    expect(band()).toBeTruthy();
  });

  it("renders and closes when storage throws (blocked site data)", () => {
    const blocked = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(blocked);
    expect(() => localStorage.getItem(KEYS.noticeNoteShow)).toThrow();

    const { unmount } = renderLayout();
    expect(band()?.querySelector("p")?.textContent).toBe(TEXT);
    fireEvent.click(within(band()!).getByRole("button", { name: "お知らせを閉じる" }));
    expect(band()).toBeNull();

    // Closed for the rest of this visit (the in-memory copy), even without storage.
    unmount();
    renderLayout();
    expect(band()).toBeNull();
  });

  it(`goes away by itself ${NOTICE_DAYS} days after the effective date`, () => {
    vi.setSystemTime(middayOn(addDays(EFFECTIVE_ON, NOTICE_DAYS - 1)));
    const { unmount } = renderLayout();
    expect(band()).toBeTruthy();
    unmount();

    vi.setSystemTime(middayOn(NOTICE_HIDDEN_FROM));
    renderLayout();
    expect(band()).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "きょう" })).toBeTruthy();
  });

  it("noticeVisible: before the end date, unless closed for this effective date", () => {
    expect(noticeVisible(REVISED_ON, null)).toBe(true);
    expect(noticeVisible(EFFECTIVE_ON, null)).toBe(true);
    expect(noticeVisible(addDays(NOTICE_HIDDEN_FROM, -1), null)).toBe(true);
    expect(noticeVisible(NOTICE_HIDDEN_FROM, null)).toBe(false);
    expect(noticeVisible(REVISED_ON, EFFECTIVE_ON)).toBe(false);
    expect(noticeVisible(REVISED_ON, "2026-10-01")).toBe(true);
    // The same end date as the pages' 改定のお知らせ (static.test.tsx), which cannot be closed.
    expect(noticeShowsOn(addDays(NOTICE_HIDDEN_FROM, -1))).toBe(true);
    expect(noticeShowsOn(NOTICE_HIDDEN_FROM)).toBe(false);
  });
});
