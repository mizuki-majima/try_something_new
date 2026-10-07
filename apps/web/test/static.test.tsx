import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { API } from "@thirty/shared";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { Layout } from "../src/components/Layout";
import { ToastProvider } from "../src/components/Toast";
import { createAppStore } from "../src/lib/appStore";
import { clearSession, getToken } from "../src/lib/session";
import { AppProvider } from "../src/lib/store";
import AboutPage from "../src/pages/AboutPage";
import ContactPage, { reportedShareId } from "../src/pages/ContactPage";
import NotFoundPage from "../src/pages/NotFoundPage";
import PrivacyPage from "../src/pages/PrivacyPage";
import TermsPage from "../src/pages/TermsPage";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const renderPage = (el: ReactElement, path = "/") => render(<MemoryRouter initialEntries={[path]}>{el}</MemoryRouter>);

let fetchMock: Mock<typeof fetch>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AboutPage", () => {
  it("explains the service, credits the talk as text and states it is unofficial", () => {
    renderPage(<AboutPage />);
    expect(screen.getByRole("heading", { level: 1, name: "「30日だけ」について" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "使い方" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "1日組" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "ひらめき提案（AI は使っていません）" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "よくある質問" })).toBeTruthy();
    expect(screen.getByText(/やめても失敗ではありません/)).toBeTruthy();

    const link = screen.getByRole("link", { name: /Matt Cutts “Try something new for 30 days”（TED2011）/ });
    expect(link.getAttribute("href")).toBe("https://www.ted.com/talks/matt_cutts_try_something_new_for_30_days");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(screen.getByText("このサイトは TED とは関係のない非公式の個人サービスです。")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull(); // no logos
  });

  it("answers the FAQ, including the price", () => {
    renderPage(<AboutPage />);
    for (const q of ["データはどこに保存されますか？", "機種変更したら、記録はどうなりますか？", "通知が来ません。", "写真はどうなりますか？", "費用はかかりますか？"]) {
      expect(screen.getByText(q)).toBeTruthy();
    }
    expect(screen.getByText("無料です。広告や課金もありません。")).toBeTruthy();
  });
});

describe("TermsPage", () => {
  it("has a table of contents and the required sections", () => {
    renderPage(<TermsPage />);
    expect(screen.getByRole("heading", { level: 1, name: "利用規約" })).toBeTruthy();
    const toc = screen.getByRole("navigation", { name: "目次" });
    expect(toc.querySelectorAll("a").length).toBeGreaterThanOrEqual(10);
    for (const h of ["禁止事項", "投稿の扱い", "通報と削除", "健康と安全", "免責", "規約の変更", "準拠法と管轄"]) {
      expect(screen.getByRole("heading", { level: 2, name: new RegExp(h) })).toBeTruthy();
    }
    expect(screen.getAllByText(/30日だけ 運営事務局（個人運営）/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/2026年10月6日/).length).toBeGreaterThan(0);
  });
});

describe("PrivacyPage", () => {
  it("lists what is stored and what is not, retention and how to delete", () => {
    renderPage(<PrivacyPage />);
    expect(screen.getByRole("heading", { level: 1, name: "プライバシーポリシー" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "サーバーに保存する情報" })).toBeTruthy();
    expect(screen.getByText(/アカウントのためのメールアドレスや電話番号、本名、住所、位置情報、写真、IP アドレスそのもの/)).toBeTruthy();
    expect(screen.getByText(/AWS の東京リージョン/)).toBeTruthy();
    expect(screen.getByText(/Google、Apple、Mozilla、Microsoft/)).toBeTruthy();
    expect(screen.getByText("お問い合わせ（内容と返信先）：180日")).toBeTruthy();
    expect(screen.getByRole("link", { name: "設定 →「すべてのデータを削除」" }).getAttribute("href")).toBe("/settings#danger");
    expect(screen.getAllByText(/2026年10月6日/).length).toBeGreaterThan(0);
  });

  it("says what is really stored: the optional reply contact, keyed IP hashes, the card's nickname, Google Calendar", () => {
    renderPage(<PrivacyPage />);
    const text = document.body.textContent ?? "";
    // The contact form's optional reply contact is stored (180 days); no blanket "no email" claim.
    expect(screen.getByText(/任意で入力された返信先（メールアドレスなど）。返信先は返信のためだけに使い、内容とともに180日で削除します/)).toBeTruthy();
    expect(text).not.toContain("メールアドレスは集めず");
    expect(text).not.toContain("保存しないもの：メールアドレス");
    // Rate-limit keys: a keyed hash, IPv6 by /64, 2 days — not "cannot be reversed".
    expect(screen.getByText(/秘密鍵つきのハッシュ（HMAC）。IPv6 は上位64ビット/)).toBeTruthy();
    expect(text).not.toContain("元に戻せない形（ハッシュ値）");
    // Public cards carry the nickname; the Google Calendar link sends the title to Google.
    expect(screen.getByText(/公開リンクを作った振り返りカード：ニックネーム/)).toBeTruthy();
    expect(screen.getByText(/「Google カレンダーに追加」のリンク/)).toBeTruthy();
  });
});

describe("ContactPage", () => {
  it("validates, sends without creating an account and shows the success state", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    renderPage(<ContactPage />);
    expect(screen.getByText(/投稿の削除依頼は各投稿の『通報』からもできます/)).toBeTruthy();
    expect(screen.getByLabelText("返信先（任意）")).toBeTruthy();
    expect(screen.getByText("返信が必要な場合だけ。書いたものは返信のためだけに使い、180日で削除します")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "送信する" }));
    expect(screen.getByText("お問い合わせ内容を入力してください")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("お問い合わせ内容"), { target: { value: "使いやすいです" } });
    fireEvent.click(screen.getByRole("button", { name: "送信する" }));
    expect(await screen.findByRole("heading", { name: "送信しました" })).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(API.contact);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ message: "使いやすいです" });
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("explains the daily limit on 429", async () => {
    fetchMock.mockResolvedValue(json(429, { error: { code: "rate_limited", message: "多すぎます" } }));
    renderPage(<ContactPage />);
    fireEvent.change(screen.getByLabelText("お問い合わせ内容"), { target: { value: "テスト" } });
    fireEvent.change(screen.getByLabelText("返信先（任意）"), { target: { value: "me@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "送信する" }));
    await waitFor(() => expect(screen.getByText(/お問い合わせは1日3件までです/)).toBeTruthy());
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ message: "テスト", replyTo: "me@example.com" });
    expect((screen.getByLabelText("お問い合わせ内容") as HTMLTextAreaElement).value).toBe("テスト");
  });
});

describe("ContactPage — 通報 for a public card (/contact?report=share:<id>)", () => {
  const SHARE_ID = "s1234567890abcd0";
  const session = { token: "tok-new", user: { id: "u0000000000009", nickname: "", tz: "Asia/Tokyo", shareProgress: true, reminder: { enabled: false, time: "21:00" }, createdAt: 1 } };

  beforeEach(() => clearSession());

  it("reads only share:<id> with a valid id", () => {
    expect(reportedShareId(`share:${SHARE_ID}`)).toBe(SHARE_ID);
    expect(reportedShareId(null)).toBeNull();
    expect(reportedShareId(SHARE_ID)).toBeNull();
    expect(reportedShareId("recipe:photo")).toBeNull();
    expect(reportedShareId("share:../../x")).toBeNull();
  });

  it("shows a report form for the card instead of the contact form and posts the report, creating the account", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === API.session) return json(201, session);
      if (String(input) === API.reports && init?.method === "POST") return new Response(null, { status: 204 });
      return json(404, { error: { code: "not_found", message: "no" } });
    });
    renderPage(<ContactPage />, `/contact?report=share:${SHARE_ID}`);
    expect(screen.getByRole("heading", { level: 1, name: "カードを通報する" })).toBeTruthy();
    expect(screen.queryByLabelText("お問い合わせ内容")).toBeNull();
    expect(screen.getByRole("link", { name: "カードに戻る" }).getAttribute("href")).toBe(`/s/${SHARE_ID}`);

    fireEvent.change(screen.getByLabelText("理由（任意）"), { target: { value: "  人を傷つける内容です  " } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(await screen.findByRole("heading", { name: "通報しました" })).toBeTruthy();

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([API.session, API.reports]);
    const [, init] = fetchMock.mock.calls[1]!;
    expect(JSON.parse(String(init?.body))).toEqual({ targetType: "share", targetId: SHARE_ID, reason: "人を傷つける内容です" });
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok-new");
    expect(getToken()).toBe("tok-new");
    expect(screen.getByRole("link", { name: "カードに戻る" }).getAttribute("href")).toBe(`/s/${SHARE_ID}`);
  });

  it("shows the API's refusal in the form (e.g. the daily report limit)", async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input) === API.session ? json(201, session) : json(429, { error: { code: "rate_limited", message: "今日はここまで" } }),
    );
    renderPage(<ContactPage />, `/contact?report=share:${SHARE_ID}`);
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect((await screen.findByRole("alert")).textContent).toBe("今日の通報はここまでです。明日また送れます。");
    expect(screen.getByRole("heading", { level: 1, name: "カードを通報する" })).toBeTruthy();
  });

  it("falls back to the contact form for anything else", () => {
    renderPage(<ContactPage />, "/contact?report=share:NOT-AN-ID");
    expect(screen.getByRole("heading", { level: 1, name: "お問い合わせ" })).toBeTruthy();
    expect(screen.getByLabelText("お問い合わせ内容")).toBeTruthy();
  });
});

describe("Layout footer", () => {
  it("links about, terms, privacy and contact from every page", () => {
    localStorage.removeItem("thirty-days.token");
    render(
      <MemoryRouter initialEntries={["/"]}>
        <ToastProvider>
          <AppProvider store={createAppStore()}>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<h1>きょう</h1>} />
              </Route>
            </Routes>
          </AppProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
    const footer = screen.getByRole("contentinfo");
    const nav = within(footer).getByRole("navigation", { name: "このサイトについて" });
    expect(within(nav).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["このサービスについて", "/about"],
      ["利用規約", "/terms"],
      ["プライバシーポリシー", "/privacy"],
      ["お問い合わせ", "/contact"],
    ]);
  });
});

describe("NotFoundPage", () => {
  it("shows the 404 sticker and a way home", () => {
    renderPage(<NotFoundPage />);
    expect(screen.getByText("404")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "ページが見つかりません" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "きょうに戻る" }).getAttribute("href")).toBe("/");
  });
});
