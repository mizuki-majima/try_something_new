import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { OFFICIAL_RECIPES, type Challenge, type Recipe, type Suggestion } from "@thirty/shared";
import { ToastHost, ToastProvider } from "../src/components/Toast";
import type { AppActions } from "../src/lib/appStore";
import { gachaPool, matchesGacha, officialRecipe, resetRecipesCache, type GachaFilters } from "../src/lib/recipes";
import { THROTTLED_MESSAGE } from "../src/lib/api";
import { clearSession } from "../src/lib/session";
import { KEYS, writeString } from "../src/lib/storage";
import { AppProvider, type AppSnapshot, type AppStore } from "../src/lib/store";
import GachaPage, { suggestBody } from "../src/pages/GachaPage";

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

function NewRecipeProbe() {
  const loc = useLocation();
  const s = (loc.state as { suggestion?: Suggestion } | null)?.suggestion;
  return <p data-testid="new-recipe">{s?.title ?? "(no state)"}</p>;
}

function renderGacha(store = fakeStore()) {
  return render(
    <MemoryRouter initialEntries={["/gacha"]}>
      <ToastProvider>
        <AppProvider store={store}>
          <Routes>
            <Route path="/gacha" element={<GachaPage />} />
            <Route path="/recipes/new" element={<NewRecipeProbe />} />
          </Routes>
          <ToastHost />
        </AppProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

const ALL: GachaFilters = { maxMinutes: null, category: null, place: "any" };
const recipes: Recipe[] = OFFICIAL_RECIPES.map(officialRecipe);
const r = (over: Partial<Recipe>): Recipe => ({ ...recipes[0]!, ...over });

const suggestion = (n: number): Suggestion => ({
  seal: ["空", "茶", "鳥"][n]!,
  title: ["毎朝、空の写真を撮る", "お茶を丁寧にいれる", "鳥の声を数える"][n]!,
  category: "hands",
  minutes: 5,
  place: "any",
  difficulty: 1,
  summary: "小さく試す案です。",
  how: ["ひとつめのコツ"],
  after: "気づくことが増えるかもしれません。",
});

let fetchMock: Mock<typeof fetch>;
let reduceMotion = true;

beforeEach(() => {
  resetRecipesCache();
  writeString(KEYS.token, "tok");
  fetchMock = vi.fn<typeof fetch>(async (input) => (String(input) === "/api/recipes" ? json(200, { recipes: [] }) : json(500, {})));
  vi.stubGlobal("fetch", fetchMock);
  reduceMotion = true;
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") && reduceMotion, media: q, addEventListener() {}, removeEventListener() {} }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("gacha pool", () => {
  it("filters by time, genre and place (a どこでも recipe fits every place)", () => {
    const f: GachaFilters = { maxMinutes: 5, category: "mind", place: "home" };
    const pool = gachaPool(recipes, f).pool;
    expect(pool.length).toBeGreaterThan(0);
    expect(pool.every((x) => x.minutes <= 5 && x.category === "mind" && (x.place === "home" || x.place === "any"))).toBe(true);
    expect(matchesGacha(r({ place: "any", minutes: 0, category: "quit" }), { maxMinutes: 5, category: "quit", place: "out" })).toBe(true);
    expect(matchesGacha(r({ place: "home" }), { ...ALL, place: "out" })).toBe(false);
    expect(gachaPool(recipes, ALL)).toEqual({ pool: recipes, relaxed: [] });
  });

  it("relaxes place, then genre, then time when nothing fits", () => {
    const list = [r({ id: "a", minutes: 30, category: "body", place: "out" }), r({ id: "b", minutes: 60, category: "mind", place: "home" })];
    expect(gachaPool(list, { maxMinutes: 30, category: "body", place: "home" })).toMatchObject({ pool: [{ id: "a" }], relaxed: ["place"] });
    expect(gachaPool(list, { maxMinutes: 30, category: "mind", place: "home" })).toMatchObject({ pool: [{ id: "a" }], relaxed: ["place", "category"] });
    expect(gachaPool(list, { maxMinutes: 5, category: "people", place: "out" })).toMatchObject({ relaxed: ["place", "category", "time"] });
    expect(gachaPool(list, { maxMinutes: 5, category: "people", place: "out" }).pool).toHaveLength(2);
    expect(gachaPool([], { maxMinutes: 5, category: null, place: "any" })).toEqual({ pool: [], relaxed: ["time"] });
  });

  it("skips recipes the user is already doing unless nothing else fits", () => {
    const list = [r({ id: "a" }), r({ id: "b" })];
    expect(gachaPool(list, ALL, new Set(["a"])).pool.map((x) => x.id)).toEqual(["b"]);
    expect(gachaPool(list, ALL, new Set(["a", "b"])).pool.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("sends only the conditions that narrow something", () => {
    expect(suggestBody(ALL, "  ")).toEqual({});
    expect(suggestBody({ maxMinutes: 15, category: "body", place: "out" }, " 朝が苦手 ")).toEqual({ maxMinutes: 15, category: "body", place: "out", hint: "朝が苦手" });
  });
});

describe("GachaPage", () => {
  it("rolls a recipe (no animation under reduced motion) and starts it from the result", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    renderGacha();
    expect(screen.getByTestId("slot").textContent).toBe(`候補 ${OFFICIAL_RECIPES.length}件`);
    fireEvent.click(screen.getByRole("radio", { name: "5分" }));
    fireEvent.click(screen.getByRole("radio", { name: "あたま" }));
    fireEvent.click(screen.getByRole("button", { name: "ガチャを回す" }));

    const card = screen.getByTestId("gacha-result");
    expect(within(card).getByRole("heading", { name: "3行日記" })).toBeTruthy();
    expect(within(card).getByRole("link", { name: "くわしく" }).getAttribute("href")).toBe("/recipes/diary");
    fireEvent.click(within(card).getByRole("button", { name: "これを30日やる" }));
    expect(screen.getByTestId("start-sheet").textContent).toBe("3行日記");
    expect(screen.getByRole("button", { name: "もう一回まわす" })).toBeTruthy();
  });

  it("spins the slot for ~1.2 s with motion allowed", async () => {
    reduceMotion = false;
    vi.useFakeTimers();
    renderGacha();
    fireEvent.click(screen.getByRole("button", { name: "ガチャを回す" }));
    expect(screen.getByRole("button", { name: "回しています…" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByTestId("gacha-result")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1300);
    });
    expect(screen.getByTestId("gacha-result")).toBeTruthy();
  });

  it("notes when conditions were relaxed", () => {
    renderGacha();
    fireEvent.click(screen.getByRole("radio", { name: "5分" }));
    fireEvent.click(screen.getByRole("radio", { name: "外で" }));
    fireEvent.click(screen.getByRole("radio", { name: "あたま" }));
    // The ≤5 min あたま recipes are all at home: the place condition is dropped.
    expect(screen.getByText(/場所の条件をはずして選びます/)).toBeTruthy();
    expect(screen.getByTestId("slot").textContent).toBe("候補 3件");
  });

  it("ひらめき提案: shows the no-AI note, renders up to 3 cards and the remaining count", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/suggestions" && init?.method === "POST") {
        return json(200, { suggestions: [suggestion(0), suggestion(1), suggestion(2), suggestion(0)], remainingToday: 7 });
      }
      return json(200, { recipes: [] });
    });
    renderGacha();
    expect(screen.getByTestId("no-ai-note").textContent).toContain("いまは AI を使わず、ルールで選んでいます");
    expect(screen.getByTestId("remaining").textContent).toBe("1日10回まで");

    fireEvent.click(screen.getByRole("radio", { name: "15分" }));
    fireEvent.change(screen.getByLabelText("ひとこと（任意）"), { target: { value: "朝が苦手" } });
    fireEvent.click(screen.getByRole("button", { name: "提案してもらう" }));

    const cards = await screen.findAllByTestId("suggestion");
    expect(cards).toHaveLength(3);
    expect(within(cards[0]!).getByRole("heading", { name: "毎朝、空の写真を撮る" })).toBeTruthy();
    expect(within(cards[0]!).getByText("ひとつめのコツ")).toBeTruthy();
    expect(within(cards[0]!).getByText(/30日後に起こりそうなこと/)).toBeTruthy();
    expect(screen.getByTestId("remaining").textContent).toBe("今日はあと 7 回");

    const call = fetchMock.mock.calls.find(([url]) => url === "/api/suggestions")!;
    expect(JSON.parse(String(call[1]!.body))).toEqual({ maxMinutes: 15, hint: "朝が苦手" });
    expect((call[1]!.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect((call[1]!.headers as Record<string, string>).Authorization).toBe("Bearer tok");

    fireEvent.click(within(cards[1]!).getByRole("button", { name: "これを30日やる：お茶を丁寧にいれる" }));
    expect(screen.getByTestId("start-sheet").textContent).toBe("お茶を丁寧にいれる");

    fireEvent.click(within(cards[2]!).getByRole("button", { name: "レシピとして投稿：鳥の声を数える" }));
    expect((await screen.findByTestId("new-recipe")).textContent).toBe("鳥の声を数える");
  });

  it("ひらめき提案: 429 says 今日はここまで and disables the button; other errors offer a retry", async () => {
    let mode: "limit" | "down" = "down";
    fetchMock.mockImplementation(async (input) => {
      if (String(input) !== "/api/suggestions") return json(200, { recipes: [] });
      return mode === "limit"
        ? json(429, { error: { code: "rate_limited", message: "今日はここまでです" } })
        : json(503, { error: { code: "ai_unavailable", message: "いまは提案を使えません。" } });
    });
    renderGacha();
    fireEvent.click(screen.getByRole("button", { name: "提案してもらう" }));
    expect(await screen.findByText("提案を作れませんでした")).toBeTruthy();
    expect(screen.getByRole("button", { name: "ガチャを回す" }).hasAttribute("disabled")).toBe(false);

    mode = "limit";
    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    expect(await screen.findByText(/今日はここまで。明日また提案できます/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "提案してもらう" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("remaining").textContent).toBe("今日はあと 0 回");
    // Never retried automatically.
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === "/api/suggestions")).toHaveLength(2));
  });

  it("ひらめき提案: a 429 from creating the account or the edge throttle is not the daily limit (the button stays usable)", async () => {
    clearSession();
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === "/api/session") return json(429, { error: { code: "rate_limited", message: "混み合っています。しばらくしてからお試しください" } });
      if (String(input) === "/api/suggestions") return json(429, { message: "Too Many Requests" });
      return json(200, { recipes: [] });
    });
    renderGacha();
    fireEvent.click(screen.getByRole("button", { name: "提案してもらう" }));
    expect(await screen.findByText(/^混み合っています。しばらくしてからお試しください/)).toBeTruthy();
    expect(screen.queryByText(/今日はここまで。明日また提案できます/)).toBeNull();

    writeString(KEYS.token, "tok");
    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    expect(await screen.findByText((text) => text.startsWith(THROTTLED_MESSAGE))).toBeTruthy();
    expect(screen.queryByText(/今日はここまで。明日また提案できます/)).toBeNull();
    expect(screen.getByRole("button", { name: "再試行" }).hasAttribute("disabled")).toBe(false);
  });

  it("skips recipes already in progress", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const ch = { id: "ch00000000000001", recipeId: "diary", status: "active", startDate: "2026-10-01", stamps: {} } as unknown as Challenge;
    renderGacha(fakeStore({ challenges: [ch] }));
    fireEvent.click(screen.getByRole("radio", { name: "5分" }));
    fireEvent.click(screen.getByRole("radio", { name: "あたま" }));
    fireEvent.click(screen.getByRole("button", { name: "ガチャを回す" }));
    expect(within(screen.getByTestId("gacha-result")).queryByRole("heading", { name: "3行日記" })).toBeNull();
  });
});
