import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { CohortMember } from "@thirty/shared";
import { ToastHost, ToastProvider } from "../src/components/Toast";
import type { AppActions } from "../src/lib/appStore";
import { KEYS, writeString } from "../src/lib/storage";
import { AppProvider, type AppSnapshot, type AppStore } from "../src/lib/store";
import TogetherPage, { cohortMonths, sortMembers } from "../src/pages/TogetherPage";

vi.mock("../src/features/start/StartChallengeSheet", () => ({
  StartChallengeSheet: (p: { open: boolean; recipe?: { title: string } | null; preset?: { title?: string; firstOfMonth?: boolean } | null }) =>
    p.open ? (
      <div data-testid="start-sheet">
        {p.recipe?.title ?? p.preset?.title ?? "(free)"}
        {p.preset?.firstOfMonth ? "|1日組" : ""}
      </div>
    ) : null,
}));

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fakeStore(over: Partial<AppSnapshot> = {}): AppStore {
  const snap: AppSnapshot = {
    user: null,
    pendingNickname: null,
    challenges: [],
    tz: "Asia/Tokyo",
    today: "2026-10-06",
    ready: true,
    refreshing: false,
    online: true,
    hasSession: true,
    sessionInvalid: false,
    pending: 0,
    syncStatus: "synced",
    lastSyncError: null,
    lastSyncedAt: null,
    lastStamped: null,
    ...over,
  };
  return { getSnapshot: () => snap, subscribe: () => () => {}, onNotice: () => () => {}, actions: {} as AppActions, start: () => () => {} };
}

function renderTogether(path = "/together", store = fakeStore()) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <AppProvider store={store}>
          <Routes>
            <Route path="/together" element={<TogetherPage />} />
          </Routes>
          <ToastHost />
        </AppProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

function member(over: Partial<CohortMember>): CohortMember {
  return {
    challengeId: "ch00000000000001",
    nickname: "みず",
    seal: "写",
    title: "毎日1枚、写真を撮る",
    recipeId: "photo",
    startDate: "2026-10-01",
    stampDays: [1, 2, 3],
    done: false,
    verdict: null,
    cheers: 2,
    cheeredToday: false,
    isMine: false,
    updatedAt: 10,
    ...over,
  };
}

const MEMBERS: CohortMember[] = [
  member({ challengeId: "ch00000000000001", nickname: "みず", updatedAt: 30 }),
  member({ challengeId: "ch00000000000002", nickname: "たろう", seal: "歩", title: "毎日20分歩く", startDate: "2026-10-04", stampDays: [1, 2, 3], cheeredToday: true, cheers: 5, updatedAt: 20 }),
  member({ challengeId: "ch00000000000003", nickname: "わたし", seal: "記", title: "3行日記", stampDays: [1, 2, 3, 4, 5, 6], isMine: true, cheers: 1, updatedAt: 5 }),
];

let fetchMock: Mock<typeof fetch>;

beforeEach(() => {
  writeString(KEYS.token, "tok");
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const cheerButton = (card: HTMLElement) => within(card).getByTestId("cheer") as HTMLButtonElement;

describe("cohort helpers", () => {
  it("derives this month, last month and the next 1st from today", () => {
    expect(cohortMonths("2026-10-06")).toEqual({ now: "2026-10", prev: "2026-09", nextFirst: "2026-11-01" });
    expect(cohortMonths("2027-01-31")).toEqual({ now: "2027-01", prev: "2026-12", nextFirst: "2027-02-01" });
  });

  it("puts your own challenge first, then the most recently active", () => {
    expect(sortMembers(MEMBERS).map((m) => m.nickname)).toEqual(["わたし", "みず", "たろう"]);
  });
});

describe("TogetherPage", () => {
  it("lists this month's members with 1日組, counts and cheer states", async () => {
    fetchMock.mockResolvedValue(json(200, { month: "2026-10", members: MEMBERS }));
    renderTogether();
    expect(screen.getByRole("tab", { name: /今月の組/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText(/ひとことは表示されません/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "表示をOFFにする" }).getAttribute("href")).toBe("/settings#profile");

    const cards = await screen.findAllByTestId("member");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/cohorts/2026-10");
    expect(cards.map((c) => c.querySelector(".who")?.textContent)).toEqual(["わたしあなた", "みず", "たろう"]);

    const [mine, mizu, taro] = cards as [HTMLElement, HTMLElement, HTMLElement];
    expect(mine.className).toContain("me");
    expect(within(mine).getByText("1日組")).toBeTruthy();
    expect(within(mine).getByRole("img", { name: "30日中6日押した" })).toBeTruthy();
    expect(cheerButton(mine).disabled).toBe(true);
    expect(within(mine).queryByRole("button", { name: /通報/ })).toBeNull();

    expect(cheerButton(mizu).disabled).toBe(false);
    expect(cheerButton(mizu).textContent).toContain("応援2");
    expect(within(mizu).getByRole("button", { name: "通報（みずさんの表示）" })).toBeTruthy();

    expect(within(taro).queryByText("1日組")).toBeNull();
    expect(within(taro).getByText("10月4日から")).toBeTruthy();
    expect(cheerButton(taro).disabled).toBe(true);
    expect(cheerButton(taro).textContent).toContain("応援済み5");
  });

  it("cheers optimistically (+1 at once, then the server count)", async () => {
    let resolveCheer!: (r: Response) => void;
    fetchMock.mockImplementation((input, init) => {
      if (init?.method === "POST") return new Promise<Response>((r) => (resolveCheer = r));
      return Promise.resolve(json(200, { month: "2026-10", members: MEMBERS }));
    });
    renderTogether();
    const mizu = (await screen.findAllByTestId("member"))[1]!;
    fireEvent.click(cheerButton(mizu));

    expect(cheerButton(mizu).textContent).toContain("応援済み3");
    expect(cheerButton(mizu).disabled).toBe(true);
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(post[0]).toBe("/api/cheers/ch00000000000001");
    const headers = post[1]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["Content-Type"]).toBe("application/json");

    await act(async () => resolveCheer(json(200, { cheers: 4, cheeredToday: true })));
    expect(cheerButton(mizu).textContent).toContain("応援済み4");
    expect(await screen.findByText("みずさんを応援しました")).toBeTruthy();
  });

  it("409: already cheered today — rolls the count back and says so", async () => {
    fetchMock.mockImplementation(async (_input, init) =>
      init?.method === "POST"
        ? json(409, { error: { code: "conflict", message: "今日はもう応援しました" } })
        : json(200, { month: "2026-10", members: MEMBERS }),
    );
    renderTogether();
    const mizu = (await screen.findAllByTestId("member"))[1]!;
    fireEvent.click(cheerButton(mizu));
    expect(await screen.findByText("今日はもう応援しました")).toBeTruthy();
    expect(cheerButton(mizu).textContent).toContain("応援済み2");
    expect(cheerButton(mizu).disabled).toBe(true);
  });

  it("a failed cheer is undone", async () => {
    fetchMock.mockImplementation(async (_input, init) =>
      init?.method === "POST" ? Promise.reject(new TypeError("Failed to fetch")) : json(200, { month: "2026-10", members: MEMBERS }),
    );
    renderTogether();
    const mizu = (await screen.findAllByTestId("member"))[1]!;
    fireEvent.click(cheerButton(mizu));
    await waitFor(() => expect(cheerButton(mizu).disabled).toBe(false));
    expect(cheerButton(mizu).textContent).toContain("応援2");
  });

  it("shows an error with retry, and the empty state", async () => {
    fetchMock.mockResolvedValueOnce(json(500, { error: { code: "internal", message: "サーバーで問題が起きました。" } }));
    fetchMock.mockResolvedValueOnce(json(200, { month: "2026-10", members: [] }));
    renderTogether();
    expect(await screen.findByText("読み込めませんでした")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    expect(await screen.findByText("まだ誰もいません。最初の1人になりませんか？")).toBeTruthy();
    expect(screen.getByRole("link", { name: "レシピから選ぶ" })).toBeTruthy();
  });

  it("tabs: last month and the next 1日組 with its recipes", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/cohorts/upcoming") {
        return json(200, {
          startDate: "2026-11-01",
          count: 3,
          byRecipe: [
            { recipeId: "walk", title: "毎日20分歩く", seal: "歩", count: 2 },
            { recipeId: null, title: "毎日ギター", seal: "弦", count: 1 },
          ],
        });
      }
      if (url === "/api/cohorts/2026-09") return json(200, { month: "2026-09", members: [member({ done: true, verdict: "modify", startDate: "2026-09-01" })] });
      return json(200, { month: "2026-10", members: [] });
    });
    renderTogether();
    await screen.findByText("まだ誰もいません。最初の1人になりませんか？");

    fireEvent.keyDown(screen.getByRole("tab", { name: /今月の組/ }), { key: "ArrowLeft" });
    const prevTab = screen.getByRole("tab", { name: /先月の組/ });
    expect(prevTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(prevTab);
    const card = await screen.findByTestId("member");
    expect(within(card).getByText("形を変える")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /次の1日組/ }));
    expect(await screen.findByText(/3人が待っています/)).toBeTruthy();
    expect(screen.getByText("11月1日", { selector: "b" })).toBeTruthy();
    expect(screen.getByText("26", { selector: "b" })).toBeTruthy(); // あと26日
    const rows = screen.getAllByTestId("upcoming");
    expect(within(rows[0]!).getByText("2人")).toBeTruthy();

    fireEvent.click(within(rows[0]!).getByRole("button", { name: "この組で始める：毎日20分歩く" }));
    expect(screen.getByTestId("start-sheet").textContent).toBe("毎日20分歩く|1日組");
  });

  it("tells you when your own progress is private", async () => {
    fetchMock.mockResolvedValue(json(200, { month: "2026-10", members: [] }));
    const user = { id: "u0000000000001", nickname: "はな", tz: "Asia/Tokyo", shareProgress: false, reminder: { enabled: false, time: "21:00" }, createdAt: 1 };
    renderTogether("/together", fakeStore({ user }));
    expect(screen.getByText(/あなたの進捗は、いま非公開です/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "設定で公開する" }).getAttribute("href")).toBe("/settings#profile");
    await screen.findByText("まだ誰もいません。最初の1人になりませんか？");
  });
});
