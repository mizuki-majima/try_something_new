import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { API } from "@thirty/shared";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import AboutPage from "../src/pages/AboutPage";
import ContactPage from "../src/pages/ContactPage";
import NotFoundPage from "../src/pages/NotFoundPage";
import PrivacyPage from "../src/pages/PrivacyPage";
import TermsPage from "../src/pages/TermsPage";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const renderPage = (el: ReactElement) => render(<MemoryRouter>{el}</MemoryRouter>);

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
    expect(screen.getByText(/メールアドレス、電話番号、本名、住所、位置情報、写真、IP アドレスそのもの/)).toBeTruthy();
    expect(screen.getByText(/AWS の東京リージョン/)).toBeTruthy();
    expect(screen.getByText(/Google、Apple、Mozilla、Microsoft/)).toBeTruthy();
    expect(screen.getByText("お問い合わせ：180日")).toBeTruthy();
    expect(screen.getByRole("link", { name: "設定 →「すべてのデータを削除」" }).getAttribute("href")).toBe("/settings#danger");
    expect(screen.getAllByText(/2026年10月6日/).length).toBeGreaterThan(0);
  });
});

describe("ContactPage", () => {
  it("validates, sends without creating an account and shows the success state", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    renderPage(<ContactPage />);
    expect(screen.getByText(/投稿の削除依頼は各投稿の『通報』からもできます/)).toBeTruthy();
    expect(screen.getByText("返信が必要な場合だけ。メールアドレス等を書いた場合は返信のためだけに使います")).toBeTruthy();

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
    fireEvent.change(screen.getByLabelText("連絡先（任意）"), { target: { value: "me@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "送信する" }));
    await waitFor(() => expect(screen.getByText(/お問い合わせは1日3件までです/)).toBeTruthy());
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ message: "テスト", replyTo: "me@example.com" });
    expect((screen.getByLabelText("お問い合わせ内容") as HTMLTextAreaElement).value).toBe("テスト");
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
