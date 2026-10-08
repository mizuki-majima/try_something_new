import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { OFFICIAL_RECIPES, type Recipe, type Story } from "@thirty/shared";
import { ToastHost, ToastProvider } from "../src/components/Toast";
import { filterRecipes, mergeRecipes, officialRecipe, resetRecipesCache, sortRecipes } from "../src/lib/recipes";
import { KEYS, writeString } from "../src/lib/storage";
import { AppProvider, type AppSnapshot, type AppStore } from "../src/lib/store";
import type { AppActions } from "../src/lib/appStore";
import RecipeDetailPage from "../src/pages/RecipeDetailPage";
import RecipeNewPage, { draftFromState } from "../src/pages/RecipeNewPage";
import RecipesPage from "../src/pages/RecipesPage";
import { armed } from "./confirm";

vi.mock("../src/features/start/StartChallengeSheet", () => ({
  StartChallengeSheet: (p: { open: boolean; recipe?: { title: string } | null; preset?: { title?: string } | null }) =>
    p.open ? <div data-testid="start-sheet">{p.recipe?.title ?? p.preset?.title ?? ""}</div> : null,
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
    stillShown: [],
    syncStatus: "synced",
    lastSyncError: null,
    lastSyncedAt: null,
    lastStamped: null,
    throttle: null,
    profileLimitedUntil: null,
    ...over,
  };
  return { getSnapshot: () => snap, subscribe: () => () => {}, onNotice: () => () => {}, actions: {} as AppActions, start: () => () => {} };
}

function LocationProbe() {
  const loc = useLocation();
  return <p data-testid="location">{loc.pathname}</p>;
}

function renderAt(path: string, routes: ReactNode, store = fakeStore()) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <AppProvider store={store}>
          <Routes>{routes}</Routes>
          <ToastHost />
        </AppProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

function community(over: Partial<Recipe> = {}): Recipe {
  return {
    id: "c0000000000001",
    seal: "縄",
    title: "毎日なわとび100回",
    category: "body",
    minutes: 5,
    place: "out",
    difficulty: 2,
    summary: "外で100回だけ跳ぶ。",
    how: ["回数だけ数える"],
    after: "息切れしにくくなるかもしれません。",
    source: "community",
    authorName: "みず",
    isMine: false,
    featured: false,
    startCount: 0,
    storyCount: 0,
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

const official = (id: string, over: Partial<Recipe> = {}): Recipe => ({ ...officialRecipe(OFFICIAL_RECIPES.find((r) => r.id === id)!), ...over });

let fetchMock: Mock<typeof fetch>;

beforeEach(() => {
  resetRecipesCache();
  writeString(KEYS.token, "tok");
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const titles = () => screen.getAllByTestId("recipe-card").map((el) => el.querySelector(".rp-title")?.textContent);

describe("recipe list helpers", () => {
  it("starts from the bundled official recipes and merges the server's counters and community recipes", () => {
    expect(mergeRecipes(null)).toHaveLength(OFFICIAL_RECIPES.length);
    const merged = mergeRecipes([
      { ...official("walk"), startCount: 7, storyCount: 2, featured: true, title: "server title is ignored" },
      community(),
      { broken: true },
    ]);
    expect(merged).toHaveLength(OFFICIAL_RECIPES.length + 1);
    const walk = merged.find((r) => r.id === "walk")!;
    expect(walk).toMatchObject({ startCount: 7, storyCount: 2, featured: true, title: "毎日20分歩く" });
    expect(merged.at(-1)).toMatchObject({ id: "c0000000000001", source: "community" });
  });

  it("searches title, summary and minutes (full-width digits too) and filters by category", () => {
    const list = mergeRecipes([community()]);
    expect(filterRecipes(list, { q: "写真" }).map((r) => r.id)).toEqual(["photo"]);
    expect(filterRecipes(list, { q: "なわとび" }).map((r) => r.id)).toEqual(["c0000000000001"]);
    const fiveMin = filterRecipes(list, { q: "５分" }).map((r) => r.id);
    expect(fiveMin).toContain("photo");
    expect(fiveMin).not.toContain("walk");
    expect(filterRecipes(list, { category: "quit" }).every((r) => r.category === "quit")).toBe(true);
    expect(filterRecipes(list, { q: "写真 1日", category: "body" })).toEqual([]);
  });

  it("sorts: おすすめ = featured then starts, 人気 = starts, 新着 = newest community first and official last", () => {
    const a = community({ id: "c1", createdAt: 1, startCount: 1 });
    const b = community({ id: "c2", createdAt: 2, startCount: 9 });
    const list = [official("photo"), official("walk", { featured: true }), official("diary", { startCount: 5 }), a, b];
    expect(sortRecipes(list, "recommended").map((r) => r.id)).toEqual(["walk", "c2", "diary", "c1", "photo"]);
    expect(sortRecipes(list, "popular").map((r) => r.id)).toEqual(["c2", "diary", "c1", "photo", "walk"]);
    expect(sortRecipes(list, "new").map((r) => r.id)).toEqual(["c2", "c1", "photo", "walk", "diary"]);
  });
});

describe("RecipesPage", () => {
  it("shows the official recipes at once, then merges community recipes with their tags", async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    renderAt("/recipes", <Route path="/recipes" element={<RecipesPage />} />);

    expect(screen.getByRole("heading", { name: "チャレンジレシピ" })).toBeTruthy();
    expect(screen.getAllByTestId("recipe-card")).toHaveLength(OFFICIAL_RECIPES.length);
    expect(screen.getByText("みんなのレシピを読み込んでいます…")).toBeTruthy();
    expect(screen.getByRole("link", { name: "＋ レシピを書く" }).getAttribute("href")).toBe("/recipes/new");
    // #20: 「えらぶ」 holds レシピ and ガチャ; the switch above the h1 marks this page.
    const choose = screen.getByRole("navigation", { name: "えらびかた" });
    expect(within(choose).getByRole("link", { name: "レシピ" }).getAttribute("aria-current")).toBe("page");
    expect(within(choose).getByRole("link", { name: "ガチャ" }).getAttribute("href")).toBe("/gacha");

    await act(async () => {
      resolve(
        json(200, {
          recipes: [
            { ...official("walk"), startCount: 3, storyCount: 1 },
            community({ isMine: true, title: "あなたのなわとび" }),
            community({ id: "c0000000000002", title: "みんなのなわとび" }),
          ],
        }),
      );
    });
    await screen.findByText("あなたのなわとび");
    expect(screen.getAllByTestId("recipe-card")).toHaveLength(OFFICIAL_RECIPES.length + 2);
    const mine = screen.getByText("あなたのなわとび").closest("a")!;
    expect(within(mine).getByText("あなたの投稿")).toBeTruthy();
    const theirs = screen.getByText("みんなのなわとび").closest("a")!;
    expect(within(theirs).getByText("みんなの投稿")).toBeTruthy();
    const walk = screen.getByText("毎日20分歩く").closest("a")!;
    expect(within(walk).getByText("体験談あり")).toBeTruthy();
    // startCount counts starts (create/delete included), not people.
    expect(within(walk).getByText("3回はじめられました")).toBeTruthy();
    expect(within(walk).queryByText(/人がはじめた/)).toBeNull();
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/recipes");
  });

  it("filters by category and search, sorts, and shows an empty state", async () => {
    fetchMock.mockResolvedValue(json(200, { recipes: [{ ...official("diary"), startCount: 4 }, { ...official("read"), startCount: 9 }] }));
    renderAt("/recipes", <Route path="/recipes" element={<RecipesPage />} />);
    await waitFor(() => expect(screen.queryByText("みんなのレシピを読み込んでいます…")).toBeNull());

    fireEvent.click(screen.getByRole("radio", { name: "やめる" }));
    await waitFor(() => expect(titles()).toEqual(["甘いものを断つ", "SNSを見ない", "新しいものを買わない"]));

    fireEvent.click(screen.getByRole("radio", { name: "あたま" }));
    fireEvent.click(screen.getByRole("radio", { name: "人気" }));
    await waitFor(() => expect(titles().slice(0, 2)).toEqual(["毎日10ページ読む", "3行日記"]));

    fireEvent.change(screen.getByLabelText("レシピをさがす"), { target: { value: "存在しないことば" } });
    await screen.findByText("見つかりませんでした");
    fireEvent.click(screen.getByRole("button", { name: "条件をクリア" }));
    await waitFor(() => expect(screen.getAllByTestId("recipe-card")).toHaveLength(OFFICIAL_RECIPES.length));
  });

  it("keeps the official list on an API error and offers a retry", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(json(200, { recipes: [community()] }));
    renderAt("/recipes", <Route path="/recipes" element={<RecipesPage />} />);
    await screen.findByText(/みんなのレシピを読み込めませんでした/);
    expect(screen.getAllByTestId("recipe-card")).toHaveLength(OFFICIAL_RECIPES.length);

    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    await screen.findByText("毎日なわとび100回");
    // The retry bypasses the service worker's stale copy.
    expect(fetchMock.mock.calls[1]![1]?.cache).toBe("no-cache");
  });
});

describe("RecipeDetailPage", () => {
  const stories: Story[] = [
    { id: "s0000000000001", recipeId: "photo", authorName: "みず", body: "古い体験談です", days: 30, verdict: "continue", createdAt: Date.UTC(2026, 8, 1), isMine: false },
    { id: "s0000000000002", recipeId: "photo", authorName: "たろう", body: "新しい体験談です", days: 12, verdict: "stop", createdAt: Date.UTC(2026, 9, 1), isMine: true },
  ];

  it("renders the recipe, stories newest first and the start CTA", async () => {
    fetchMock.mockResolvedValue(json(200, { recipe: { ...official("photo"), storyCount: 2 }, stories }));
    renderAt("/recipes/photo", <Route path="/recipes/:id" element={<RecipeDetailPage />} />);

    // Official recipes render from the bundle before the API answers.
    expect(screen.getByRole("heading", { level: 1, name: "毎日1枚、写真を撮る" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "何をする" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "やり方のコツ" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "30日後に起こりそうなこと" })).toBeTruthy();

    const items = await screen.findAllByTestId("story");
    expect(items.map((el) => el.querySelector("blockquote")?.textContent)).toEqual(["新しい体験談です", "古い体験談です"]);
    expect(within(items[0]!).getByText("12日")).toBeTruthy();
    expect(within(items[0]!).getByText("やめる")).toBeTruthy();
    expect(within(items[0]!).getByRole("button", { name: "削除（あなたの体験談）" })).toBeTruthy();
    expect(within(items[1]!).getByRole("button", { name: "通報（みずさんの体験談）" })).toBeTruthy();

    expect(screen.queryByTestId("start-sheet")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "これを30日やる" }));
    expect(screen.getByTestId("start-sheet").textContent).toBe("毎日1枚、写真を撮る");
  });

  it("posts a story with the nickname as the default name", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return json(201, { story: { id: "s0000000000009", recipeId: "photo", authorName: body.authorName, body: body.body, days: body.days ?? null, verdict: body.verdict ?? null, createdAt: Date.UTC(2026, 9, 6), isMine: true } });
      }
      return json(200, { recipe: official("photo"), stories: [] });
    });
    const user = { id: "u0000000000001", nickname: "はな", tz: "Asia/Tokyo", shareProgress: true, reminder: { enabled: false, time: "21:00" }, createdAt: 1 };
    renderAt("/recipes/photo", <Route path="/recipes/:id" element={<RecipeDetailPage />} />, fakeStore({ user }));
    await screen.findByText("まだ体験談はありません");

    fireEvent.click(screen.getByRole("button", { name: "体験談を書く" }));
    const dialog = screen.getByRole("dialog", { name: "体験談を書く" });
    expect((within(dialog).getByLabelText("名前") as HTMLInputElement).value).toBe("はな");
    const consent = dialog.querySelector<HTMLElement>(".consent-note")!;
    expect(consent.textContent).toBe("投稿すると利用規約とプライバシーポリシーに同意したことになります。");
    expect(within(consent).getByRole("link", { name: "利用規約" }).getAttribute("href")).toBe("/terms");
    fireEvent.click(within(dialog).getByRole("button", { name: "公開する" }));
    expect(await within(dialog).findByText("体験談を入力してください")).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText("体験談"), { target: { value: "30日続きました。" } });
    fireEvent.change(within(dialog).getByLabelText("続いた日数（任意）"), { target: { value: "30" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: "続ける" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "公開する" }));

    await screen.findByText("30日続きました。");
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(post[0]).toBe("/api/recipes/photo/stories");
    expect(JSON.parse(String(post[1]!.body))).toEqual({ body: "30日続きました。", authorName: "はな", days: 30, verdict: "continue" });
    expect((post[1]!.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(screen.queryByRole("dialog")).toBeNull();
    // The list refetches past the service worker's cache.
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/recipes/photo" && init?.cache === "no-cache")).toBe(true));
  });

  it("community recipe: author line, report for others, delete for the author", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { recipe: community(), stories: [] }));
    const { unmount } = renderAt("/recipes/c0000000000001", <Route path="/recipes/:id" element={<RecipeDetailPage />} />);
    await screen.findByText(/みずさんの投稿/);
    expect(screen.getByRole("button", { name: "通報（このレシピ）" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "このレシピを削除" })).toBeNull();
    unmount();

    fetchMock.mockImplementation(async (_url, init) => (init?.method === "DELETE" ? new Response(null, { status: 204 }) : json(200, { recipe: community({ isMine: true }), stories: [] })));
    renderAt(
      "/recipes/c0000000000001",
      <>
        <Route path="/recipes/:id" element={<RecipeDetailPage />} />
        <Route path="/recipes" element={<LocationProbe />} />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "このレシピを削除" }));
    fireEvent.click(await armed(within(screen.getByRole("alertdialog")).getByRole("button", { name: "削除する" })));
    expect((await screen.findByTestId("location")).textContent).toBe("/recipes");
    const del = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE")!;
    expect(del[0]).toBe("/api/recipes/c0000000000001");
  });

  it("shows not-found on 404 and the bundled recipe without stories when offline", async () => {
    fetchMock.mockResolvedValueOnce(json(404, { error: { code: "not_found", message: "レシピが見つかりませんでした" } }));
    const { unmount } = renderAt("/recipes/zzzzzzzzzzzz", <Route path="/recipes/:id" element={<RecipeDetailPage />} />);
    expect(await screen.findByText("レシピが見つかりませんでした")).toBeTruthy();
    unmount();

    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderAt("/recipes/walk", <Route path="/recipes/:id" element={<RecipeDetailPage />} />);
    expect(await screen.findByText("体験談を読み込めませんでした")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "毎日20分歩く" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "これを30日やる" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "再試行" })).toBeTruthy();
  });
});

describe("RecipeNewPage", () => {
  const routes = (
    <>
      <Route path="/recipes/new" element={<RecipeNewPage />} />
      <Route path="/recipes/:id" element={<LocationProbe />} />
    </>
  );

  it("validates with RecipeInputSchema before sending", async () => {
    renderAt("/recipes/new", routes);
    const consent = document.querySelector<HTMLElement>(".consent-note")!;
    expect(consent.textContent).toBe("投稿すると利用規約とプライバシーポリシーに同意したことになります。");
    expect(within(consent).getByRole("link", { name: "プライバシーポリシー" }).getAttribute("href")).toBe("/privacy");
    fireEvent.click(screen.getByRole("button", { name: "レシピを公開する" }));
    expect(await screen.findByText("タイトルを入力してください")).toBeTruthy();
    expect(screen.getByText("何をするかを入力してください")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/入力内容を確認してください/);
    await waitFor(() => expect(document.activeElement?.id).toBe("rn-title"));

    fireEvent.change(screen.getByLabelText("1日あたり（分）"), { target: { value: "500" } });
    fireEvent.change(screen.getByLabelText("コツ 1"), { target: { value: "x".repeat(61) } });
    fireEvent.click(screen.getByRole("button", { name: "レシピを公開する" }));
    expect(await screen.findByText("1日あたりの時間は0〜180分の数字で入力してください")).toBeTruthy();
    expect(screen.getByText("コツは60文字以内で入力してください")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the recipe, shows API field errors, then opens the new recipe", async () => {
    fetchMock
      .mockResolvedValueOnce(json(400, { error: { code: "bad_request", message: "入力内容を確認してください", fields: { summary: "何をするかにURLは入れられません" } } }))
      .mockResolvedValueOnce(json(201, { recipe: community({ id: "n0000000000001", isMine: true }) }));
    renderAt("/recipes/new", routes);

    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "毎日スクワット" } });
    // Live seal preview: the first character of the title until a seal is typed.
    expect((screen.getByLabelText("印（1文字）") as HTMLInputElement).placeholder).toBe("毎");
    fireEvent.change(screen.getByLabelText("何をする（1文）"), { target: { value: "毎日10回だけスクワットする。" } });
    fireEvent.click(screen.getByRole("radio", { name: "からだ" }));
    fireEvent.click(screen.getByRole("radio", { name: "家で" }));
    fireEvent.click(screen.getByRole("radio", { name: "ふつう" }));
    fireEvent.change(screen.getByLabelText("コツ 1"), { target: { value: "歯みがきの前にやる" } });
    fireEvent.click(screen.getByRole("button", { name: /コツを足す/ }));
    expect(screen.getByLabelText("コツ 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "レシピを公開する" }));

    expect(await screen.findByText("何をするかにURLは入れられません")).toBeTruthy();
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body).toEqual({
      seal: "毎",
      title: "毎日スクワット",
      category: "body",
      minutes: 10,
      place: "home",
      difficulty: 2,
      summary: "毎日10回だけスクワットする。",
      how: ["歯みがきの前にやる"],
      after: "",
    });
    expect(fetchMock.mock.calls[0]![1]!.method).toBe("POST");

    fireEvent.click(screen.getByRole("button", { name: "レシピを公開する" }));
    expect((await screen.findByTestId("location")).textContent).toBe("/recipes/n0000000000001");
  });

  it("prefills from a ひらめき提案 in router state", () => {
    const suggestion = {
      seal: "空",
      title: "毎朝、空の写真を撮る",
      category: "hands",
      minutes: 3,
      place: "out",
      difficulty: 1,
      summary: "起きたら空を1枚撮る。",
      how: ["窓を開けて撮る", "同じ場所から"],
      after: "天気に敏感になるかもしれません。",
    };
    expect(draftFromState({ suggestion })).toMatchObject({ title: "毎朝、空の写真を撮る", seal: "空", minutes: "3", place: "out", how: ["窓を開けて撮る", "同じ場所から"] });
    expect(draftFromState(null).title).toBe("");

    render(
      <MemoryRouter initialEntries={[{ pathname: "/recipes/new", state: { suggestion } }]}>
        <AppProvider store={fakeStore()}>
          <Routes>{routes}</Routes>
        </AppProvider>
      </MemoryRouter>,
    );
    expect((screen.getByLabelText("タイトル") as HTMLInputElement).value).toBe("毎朝、空の写真を撮る");
    expect((screen.getByLabelText("コツ 2") as HTMLInputElement).value).toBe("同じ場所から");
    expect(screen.getByText(/ひらめき提案から下書きしました/)).toBeTruthy();
  });
});
