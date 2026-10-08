import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { API } from "@thirty/shared";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { Layout } from "../src/components/Layout";
import { ToastProvider } from "../src/components/Toast";
import { resumeText } from "../src/components/OfflineBanner";
import { createAppStore, type AppActions, type AppSnapshot, type AppStore } from "../src/lib/appStore";
import { EFFECTIVE, REVISED } from "../src/lib/legal";
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

  it("#17: says day notes are shown only when their owner chooses to, and photos never", () => {
    renderPage(<AboutPage />);
    const section = screen.getByRole("heading", { name: "1日組" }).closest("section")!;
    expect(section.textContent).toContain(
      "進捗の表示は、設定でいつでもオフにできます。ひとことメモは、本人が「みんなに見せる」を選んだものだけ表示されます。写真は表示されません。",
    );
    expect(section.textContent).not.toContain("ひとことメモや写真は表示されません");
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

  it("r2-web-2: every report is checked by the operator; auto-hide is conditional, never promised", () => {
    renderPage(<TermsPage />);
    const text = document.body.textContent ?? "";
    expect(screen.getByText("通報はすべて運営者が確認し、必要なら投稿を非表示にしたり削除したりします。")).toBeTruthy();
    expect(text).toContain("一定の条件（利用を始めて24時間以上たっていることなど）を満たす3人から通報があった投稿は、運営者の確認の前に自動で非表示になることがあります。");
    expect(text).not.toContain("3人から通報された投稿は、自動で非表示になります");
  });

  it("#17: dates the revision (改定日・適用日) and says, from that day, only day notes their owner chose are public", () => {
    renderPage(<TermsPage />);
    const text = document.body.textContent ?? "";
    expect(screen.getByText(`制定日 2026年10月6日 ／ 改定日 ${REVISED}（${EFFECTIVE}から適用） ／ 運営者 30日だけ 運営事務局（個人運営）`)).toBeTruthy();
    expect(text).toContain(`2026年10月6日 制定 ／ ${REVISED} 改定（${EFFECTIVE}から適用）`);

    const notice = screen.getByRole("region", { name: "改定のお知らせ" });
    expect(notice.textContent).toBe(
      `改定のお知らせ${EFFECTIVE}から、本人が「みんなに見せる」を選んだひとことメモを公開する内容に改めます（投稿の扱い・通報と削除）。選ばないひとことメモは、これまでどおり公開しません。それまでは、ひとことメモは公開されません。同じ日にプライバシーポリシーも改めます。`,
    );
    expect(within(notice).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["投稿の扱い", "#posts"],
      ["通報と削除", "#report"],
      ["プライバシーポリシー", "/privacy"],
    ]);

    // True before the effective date too: every new statement says from when.
    const posts = screen.getByRole("region", { name: /投稿の扱い/ }).textContent ?? "";
    expect(posts).toContain(
      `「みんなに進捗を表示する」がオンのときの、1日組の表示（ニックネーム、チャレンジのタイトルと印、印を押した日、振り返りの判定、応援の数。${EFFECTIVE}からは、本人が「みんなに見せる」を選んだひとことメモも）`,
    );
    expect(posts).toContain(
      `ひとことメモは、${EFFECTIVE}から、本人が「みんなに見せる」を選んだものだけ公開されます（それより前は、ひとことメモは公開されません）。写真は公開されません。この規約の「投稿」には、「みんなに見せる」を選んだひとことメモも含みます。`,
    );
    expect(posts).toContain("「みんなに見せる」を選んだひとことメモは、いつでも自分だけに戻せます（振り返りのあとも。通信できるときに行えます）。書き換えたときも、その書き換えがサーバーに届いた時点で自分だけに戻ります。");
    expect(screen.getByRole("region", { name: /通報と削除/ }).textContent).toContain(
      "レシピ・体験談・公開カード・1日組の表示（「みんなに見せる」を選んだひとことメモを含みます）には「通報」があります",
    );
    expect(text).not.toContain("ひとことメモと写真は公開されません");
    // The promise this notice keeps.
    expect(text).toContain("変えるときは、変更後の内容と、変更が効力を持つ日を、その日より前に本サービスの画面でお知らせします。");
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
    // Rate-limit keys: a keyed hash, IPv6 by /56 (R7: Japanese IPoE homes get a /56), 2 days — not "cannot be reversed".
    expect(screen.getByText(/秘密鍵つきのハッシュ（HMAC）。IPv6 は上位56ビット/)).toBeTruthy();
    // R11: new accounts are also counted per network (IPv4 /16, IPv6 /48), with the same kind of keyed hash.
    expect(screen.getByText(/アカウントの作成は、ネットワーク（IPv4 は上位16ビット、IPv6 は上位48ビット）ごとにも数えます/)).toBeTruthy();
    // R8: a report keeps a keyed hash of the reporter's network, until the account is deleted.
    expect(screen.getByText(/通報したネットワークを見分ける値（IP\s*アドレスから作った秘密鍵つきのハッシュ値）も、通報の記録と一緒に保存します/)).toBeTruthy();
    expect(screen.getByText("通報した記録（通報したネットワークを見分ける値を含む）：アカウントを削除するまで")).toBeTruthy();
    expect(text).not.toContain("元に戻せない形（ハッシュ値）");
    // Public cards carry the nickname; the Google Calendar link sends the title to Google.
    expect(screen.getByText(/公開リンクを作った振り返りカード：ニックネーム/)).toBeTruthy();
    expect(screen.getByText(/「Google カレンダーに追加」のリンク/)).toBeTruthy();
  });

  it("#17: dates the revision and says what is stored and public for a day note its owner chose to show", () => {
    renderPage(<PrivacyPage />);
    const text = document.body.textContent ?? "";
    expect(screen.getByText(`制定日 2026年10月6日 ／ 改定日 ${REVISED}（${EFFECTIVE}から適用） ／ 運営者 30日だけ 運営事務局（個人運営）`)).toBeTruthy();
    expect(text).toContain(`2026年10月6日 制定 ／ ${REVISED} 改定（${EFFECTIVE}から適用）`);

    const notice = screen.getByRole("region", { name: "改定のお知らせ" });
    expect(notice.textContent).toBe(
      `改定のお知らせ${EFFECTIVE}から、本人が「みんなに見せる」を選んだひとことメモを公開する内容に改めます（保存する情報・公開される情報・削除と、開示などのご請求）。選ばないひとことメモは、これまでどおり公開しません。それまでは、ひとことメモは公開されません。同じ日に利用規約も改めます。`,
    );
    expect(within(notice).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["#collect", "#public", "#delete", "/terms"]);

    // Stored: the choice is a copy of the chosen text.
    const table = screen.getByRole("table", { name: "サーバーに保存する情報" });
    expect(within(table).getByRole("rowheader", { name: "ひとことメモ" }).nextElementSibling?.textContent).toBe(
      `毎日の印に添えたメモ。ふだんは本人だけが見られます。${EFFECTIVE}からは、本人が「みんなに見せる」を選んだメモは、進捗の表示がオンで1日組に表示されているあいだ、誰でも見られます（選んだことの記録として、選んだときのメモの写しも保存します）`,
    );

    // Public: dated; what stays private; how it goes private again.
    const pub = screen.getByRole("region", { name: /公開される情報/ }).textContent ?? "";
    expect(pub).toContain(
      `「みんなに進捗を表示する」がオンのときの1日組の表示：ニックネーム、チャレンジのタイトルと印、印を押した日、振り返りの判定、応援の数。${EFFECTIVE}からは、本人が「みんなに見せる」を選んだひとことメモ（何日目のメモか、見せている数）も`,
    );
    expect(pub).toContain(`「みんなに見せる」を選んでいないひとことメモ、写真、設定、通知の登録は公開しません（${EFFECTIVE}より前は、ひとことメモはすべて公開しません）。`);
    expect(pub).toContain(
      "見せたひとことメモは、書き換えると非公開に戻ります。進捗の表示をオフにすると、見せたひとことメモも表示されなくなり、オンに戻すとまた表示されます。書き換え・オフ・オンは、変更がサーバーに届いた時点で反映されます（通信できないあいだは、前の状態のままです）。",
    );
    expect(pub).toContain("バックアップから読み込んだひとことメモは、すべて非公開になります。");
    expect(pub).toContain("進捗の表示は設定で、見せたひとことメモはその日のひとことの欄で、いつでも非公開に戻せます（振り返りのあとも。通信できるときに行えます）。");
    expect(screen.getByRole("region", { name: /削除と、開示などのご請求/ }).textContent).toContain(
      "「みんなに見せる」を選んだひとことメモは、その日のひとことの欄から、いつでも自分だけに戻せます（振り返りのあとも。通信できるときに行えます）。",
    );
    expect(text).not.toContain("毎日の印に添えたメモ。本人だけが見られます");
    expect(text).not.toContain("ひとことメモ、写真、設定、通知の登録は公開しません。");
    // Photos stay on the device.
    expect(text).toContain("写真はサーバーに送りません");
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

  it("R7: when creating the account is refused (429), shows that reason instead of the daily report limit", async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input) === API.session
        ? json(429, { error: { code: "rate_limited", message: "いまは新しく始める人が集中しています。しばらくしてからお試しください" } })
        : new Response(null, { status: 204 }),
    );
    renderPage(<ContactPage />, `/contact?report=share:${SHARE_ID}`);
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect((await screen.findByRole("alert")).textContent).toBe("いまは新しく始める人が集中しています。しばらくしてからお試しください");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([API.session]);
  });

  it("r2-web-2: says every report is checked by the operator and auto-hide only happens under conditions", () => {
    renderPage(<ContactPage />, `/contact?report=share:${SHARE_ID}`);
    const lead = screen.getByText(/を運営者に知らせます/).textContent ?? "";
    expect(lead).toContain("通報はすべて運営者が確認し、必要なら非表示にします。");
    expect(lead).toMatch(/一定の条件（利用を始めて24時間以上たっていることなど）を満たす3人から通報があると、確認の前に自動で非表示になることもあります。/);
    expect(lead).not.toContain("人から通報があると、自動で非表示になります");
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

describe("Layout — waiting after a 429 (r2-web-6)", () => {
  function waitingStore(throttle: { until: number; reason: string } | null, syncStatus: AppSnapshot["syncStatus"] = "waiting"): AppStore {
    const snap: AppSnapshot = {
      user: null,
      pendingNickname: null,
      challenges: [],
      tz: "Asia/Tokyo",
      today: "2026-10-06",
      ready: true,
      refreshing: false,
      online: true,
      hasSession: false,
      sessionInvalid: false,
      pending: 2,
      stillShown: [],
      syncStatus,
      lastSyncError: "短い時間に操作が集中しています。しばらくしてからもう一度お試しください",
      lastSyncedAt: null,
      lastStamped: null,
      throttle,
      profileLimitedUntil: null,
    };
    return { getSnapshot: () => snap, subscribe: () => () => {}, onNotice: () => () => {}, actions: {} as AppActions, start: () => () => {} };
  }

  function renderLayout(store: AppStore) {
    return render(
      <MemoryRouter initialEntries={["/"]}>
        <ToastProvider>
          <AppProvider store={store}>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<h1>きょう</h1>} />
              </Route>
            </Routes>
          </AppProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  it("shows a visible band with the reason and when sending resumes, and 「送信待ち」 instead of 同期中…", () => {
    renderLayout(waitingStore({ until: Date.now() + 20 * 60_000, reason: "混み合っています。" }));
    expect(screen.getByTestId("throttle-band").textContent).toBe("混み合っています。約20分後に自動で送ります。記録はこの端末に保存されています。");
    expect(screen.getByTestId("sync-status").textContent).toBe("送信待ち");
  });

  it("says 「まもなく」 for a wait under a minute, and shows no band otherwise", () => {
    expect(resumeText(Date.now() + 30_000, Date.now())).toBe("まもなく自動で送ります");
    expect(resumeText(Date.now() + 61_000, Date.now())).toBe("約2分後に自動で送ります");
    renderLayout(waitingStore(null, "pending"));
    expect(screen.queryByTestId("throttle-band")).toBeNull();
    expect(screen.getByTestId("sync-status").textContent).toBe("同期中…");
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
