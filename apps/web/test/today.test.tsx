import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API, addDays, jpDate, nextFirst, todayIn, type Challenge } from "@thirty/shared";
import { ToastProvider } from "../src/components/Toast";
import { createAppStore } from "../src/lib/appStore";
import { deviceTimeZone } from "../src/lib/session";
import { AppProvider } from "../src/lib/store";
import TodayPage from "../src/pages/TodayPage";

const today = todayIn(deviceTimeZone());

function ch(over: Partial<Challenge>): Challenge {
  return {
    id: "abc123def4567890",
    recipeId: "photo",
    title: "毎日1枚、写真を撮る",
    seal: "写",
    startDate: today,
    status: "active",
    stamps: {},
    verdict: null,
    reflection: null,
    finishedAt: null,
    finishedDay: null,
    cheers: 0,
    shareId: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function setOnline(online: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
}

afterEach(() => {
  delete (navigator as { onLine?: boolean }).onLine;
  vi.unstubAllGlobals();
});

function renderToday(challenges: Challenge[] = [], { online = false }: { online?: boolean } = {}) {
  setOnline(online);
  if (challenges.length) localStorage.setItem("thirty-days.state.v1", JSON.stringify({ v: 1, base: { user: null, challenges }, pendingNickname: null }));
  const store = createAppStore();
  render(
    <MemoryRouter>
      <ToastProvider>
        <AppProvider store={store}>
          <TodayPage />
        </AppProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
  return store;
}

describe("TodayPage", () => {
  it("shows the hero with three ways to start on the first visit (CUF-1 step 1)", () => {
    renderToday();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("どうせ過ぎる30日なら、ひとつ試してみる。");
    expect(screen.getByRole("link", { name: "レシピから選ぶ" }).getAttribute("href")).toBe("/recipes");
    expect(screen.getByRole("link", { name: "ガチャで決める" }).getAttribute("href")).toBe("/gacha");
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("ひとつ選ぶ"), expect.stringContaining("毎日1タップ"), expect.stringContaining("30日目に決める")]),
    );
    const ted = screen.getByRole("link", { name: /Matt Cutts “Try something new for 30 days”（TED）/ });
    expect(ted.getAttribute("href")).toBe("https://www.ted.com/talks/matt_cutts_try_something_new_for_30_days");
    expect(ted.getAttribute("rel")).toContain("noopener");

    fireEvent.click(screen.getByRole("button", { name: "自分で決める" }));
    const dialog = screen.getByRole("dialog", { name: "新しい30日" });
    expect((screen.getByLabelText("チャレンジ名") as HTMLInputElement).value).toBe("");
    expect(dialog).toBeTruthy();
  });

  it("shows the next 1日組 teaser offline without asking the API", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderToday();
    expect(screen.getByRole("heading", { name: "次の1日組" })).toBeTruthy();
    expect(screen.getByText(jpDate(nextFirst(today)))).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads how many people are waiting for the next 1st", async () => {
    const nf = nextFirst(today);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === API.cohortUpcoming) {
        return new Response(JSON.stringify({ startDate: nf, count: 3, byRecipe: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderToday([], { online: true });
    expect(await screen.findByText("3人")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "1日組で予約する" }));
    expect((screen.getAllByRole("radio")[1] as HTMLInputElement).checked).toBe(true);
  });

  it("offers a retry when the cohort count cannot be loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "internal", message: "x" } }), { status: 500, headers: { "Content-Type": "application/json" } })),
    );
    renderToday([], { online: true });
    expect(await screen.findByText(/予約の人数を読み込めませんでした/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "再試行" })).toBeTruthy();
  });

  it("shows an active card and stamps today with one tap (CUF-1 step 4)", async () => {
    const store = renderToday([ch({})]);
    expect(screen.getByRole("heading", { name: "毎日1枚、写真を撮る" })).toBeTruthy();
    expect(screen.getByText("1日目")).toBeTruthy();
    const count = document.querySelector(".td-count")!;
    expect(count.textContent).toContain("0/30");

    fireEvent.click(screen.getByRole("button", { name: "きょう（1日目）の分を押す" }));

    expect(await screen.findByText("1日目、押しました")).toBeTruthy();
    expect(count.textContent).toContain("1/30");
    expect(screen.getByRole("button", { name: "1日目（済）" }).textContent).toContain("写");
    expect(screen.queryByRole("button", { name: /の分を押す/ })).toBeNull();
    expect(store.getSnapshot().challenges[0]!.stamps["1"]).toBeTruthy();

    // The one-line ひとこと saves on Enter.
    const note = screen.getByLabelText("きょうのひとこと（任意・自分だけに見えます）");
    fireEvent.change(note, { target: { value: "朝の光" } });
    fireEvent.keyDown(note, { key: "Enter" });
    expect(store.getSnapshot().challenges[0]!.stamps["1"]?.note).toBe("朝の光");
    expect(screen.getByText("保存しました")).toBeTruthy();

    // Undo with a note asks first.
    fireEvent.click(screen.getByRole("button", { name: "取り消す" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("朝の光");
    fireEvent.click(screen.getAllByRole("button", { name: "取り消す" }).find((b) => dialog.contains(b))!);
    expect(await screen.findByRole("button", { name: "きょう（1日目）の分を押す" })).toBeTruthy();
    expect(store.getSnapshot().challenges[0]!.stamps["1"]).toBeUndefined();
  });

  it("toggles a past day from the grid and keeps future days disabled", () => {
    const store = renderToday([ch({ startDate: addDays(today, -4) })]);
    expect(screen.getByText("5日目")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "2日目" }));
    expect(store.getSnapshot().challenges[0]!.stamps["2"]).toBeTruthy();
    expect((screen.getByRole("button", { name: "6日目" }) as HTMLButtonElement).disabled).toBe(true);
    // Not yet day 7: no early finish.
    expect(screen.queryByRole("link", { name: "ここで区切る" })).toBeNull();
    expect(screen.getByRole("link", { name: "詳細・メモ" }).getAttribute("href")).toBe("/c/abc123def4567890");
  });

  it("offers ここで区切る from day 7", () => {
    renderToday([ch({ startDate: addDays(today, -6) })]);
    expect(screen.getByRole("link", { name: "ここで区切る" }).getAttribute("href")).toBe("/c/abc123def4567890/reflect");
  });

  it("shows a reservation that can start today instead", async () => {
    const nf = nextFirst(today);
    const store = renderToday([ch({ startDate: nf })]);
    expect(screen.getByText(`${jpDate(nf)}にスタート`)).toBeTruthy();
    expect(screen.getByText("予約中")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /の分を押す/ })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "今日から始める" }));
    });
    expect(store.getSnapshot().challenges[0]!.startDate).toBe(today);
    expect(await screen.findByRole("button", { name: "きょう（1日目）の分を押す" })).toBeTruthy();
  });

  it("asks for the reflection when the 30 days are over (CUF-2 step 1)", () => {
    renderToday([ch({ startDate: addDays(today, -30), stamps: { "1": { at: 1 }, "30": { at: 2 } } })]);
    expect(screen.getByText("30日が終わりました")).toBeTruthy();
    expect(screen.getByText(/2日押せました/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "振り返る" }).getAttribute("href")).toBe("/c/abc123def4567890/reflect");
  });

  it("shows the hero and a link to the log when only finished challenges remain", () => {
    renderToday([ch({ status: "done", verdict: "continue", startDate: addDays(today, -40), finishedDay: 30, finishedAt: 5 })]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("どうせ過ぎる30日なら");
    expect(screen.getByText(/振り返りを終えた30日：/).textContent).toContain("1件");
    expect(screen.getByRole("link", { name: "記録を見る" }).getAttribute("href")).toBe("/log");
  });

  it("shows a loading state before the first sync and an error with retry when it fails", async () => {
    localStorage.setItem("thirty-days.token", "tok");
    setOnline(true);
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fail
          ? new Response(JSON.stringify({ error: { code: "internal", message: "落ちています" } }), { status: 500, headers: { "Content-Type": "application/json" } })
          : new Response(JSON.stringify({ challenges: [], today, user: null, startDate: nextFirst(today), count: 0, byRecipe: [] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
      ),
    );
    const store = createAppStore();
    render(
      <MemoryRouter>
        <ToastProvider>
          <AppProvider store={store}>
            <TodayPage />
          </AppProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText("記録を読み込んでいます…")).toBeTruthy();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("記録を読み込めませんでした");
    expect(alert.textContent).toContain("落ちています");
    fail = false;
    fireEvent.click(within(alert).getByRole("button", { name: "再試行" }));
    await waitFor(() => expect(screen.queryByText("記録を読み込めませんでした")).toBeNull());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("どうせ過ぎる30日なら");
  });
});
