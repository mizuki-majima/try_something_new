import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API, addDays, jpDate, nextFirst, todayIn, type Challenge } from "@thirty/shared";
import { ToastHost, ToastProvider } from "../src/components/Toast";
import { createAppStore } from "../src/lib/appStore";
import { deviceTimeZone } from "../src/lib/session";
import { AppProvider } from "../src/lib/store";
import ChallengePage from "../src/pages/ChallengePage";
import LogPage from "../src/pages/LogPage";
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
    // count is reservations (one person may hold several): not shown as people.
    expect(await screen.findByText("3件")).toBeTruthy();
    expect(screen.queryByText("3人")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "1日組で予約する" }));
    expect((screen.getAllByRole("radio")[1] as HTMLInputElement).checked).toBe(true);
  });

  it("shows people for the next 1st when the API counts them (peopleCount)", async () => {
    const nf = nextFirst(today);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input) === API.cohortUpcoming
          ? new Response(JSON.stringify({ startDate: nf, count: 3, peopleCount: 2, byRecipe: [] }), { status: 200, headers: { "Content-Type": "application/json" } })
          : new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } }),
      ),
    );
    renderToday([], { online: true });
    expect(await screen.findByText("2人")).toBeTruthy();
    expect(screen.getByText(/いま予約しているのは/)).toBeTruthy();
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
    const note = screen.getByLabelText("きょうのひとこと（自分だけに見えます）");
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

// ---------- the pages a card links to ----------

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderAt(path: string, challenges: Challenge[]) {
  setOnline(false);
  localStorage.setItem("thirty-days.state.v1", JSON.stringify({ v: 1, base: { user: null, challenges }, pendingNickname: null }));
  const store = createAppStore();
  render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <AppProvider store={store}>
          <Where />
          <Routes>
            <Route path="/" element={<p>きょうのページ</p>} />
            <Route path="c/:id" element={<ChallengePage />} />
            <Route path="log" element={<LogPage />} />
          </Routes>
        </AppProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
  return store;
}

describe("ChallengePage", () => {
  it("opens a day: note, forgotten stamp, and photos that need IndexedDB", async () => {
    const store = renderAt("/c/abc123def4567890", [ch({ startDate: addDays(today, -4), stamps: { "2": { at: 1, note: "駅まで遠回り" } } })]);
    expect(screen.getByRole("heading", { level: 1, name: "毎日1枚、写真を撮る" })).toBeTruthy();
    // Today (day 5) is open by default.
    expect(screen.getByRole("heading", { name: /5日目/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "3日目" }));
    expect(screen.getByRole("heading", { name: /3日目/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "この日の印を押す" }));
    expect(store.getSnapshot().challenges[0]!.stamps["3"]).toBeTruthy();

    // jsdom has no IndexedDB, like some private windows.
    expect(await screen.findByText("この端末では写真を保存できません。")).toBeTruthy();

    // Notes list → that day.
    fireEvent.click(screen.getByRole("button", { name: /2日目\s*駅まで遠回り/ }));
    const note = screen.getByLabelText("この日のひとこと（自分だけに見えます）") as HTMLTextAreaElement;
    expect(note.value).toBe("駅まで遠回り");
    fireEvent.change(note, { target: { value: "駅まで遠回りした" } });
    fireEvent.blur(note);
    expect(store.getSnapshot().challenges[0]!.stamps["2"]?.note).toBe("駅まで遠回りした");

    // Calendar reminder for the remaining days.
    const gcal = screen.getByRole("link", { name: /Googleカレンダーに入れる/ });
    expect(gcal.getAttribute("href")).toContain("recur=RRULE%3AFREQ%3DDAILY%3BCOUNT%3D26");
    expect(screen.getByRole("link", { name: "通知の設定" }).getAttribute("href")).toBe("/settings#reminder");
  });

  it("edits the title and seal through the store", () => {
    const store = renderAt("/c/abc123def4567890", [ch({})]);
    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    fireEvent.change(screen.getByLabelText("チャレンジ名"), { target: { value: "毎日2枚、写真を撮る" } });
    fireEvent.change(screen.getByLabelText("印（1文字）"), { target: { value: "撮" } });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    expect(store.getSnapshot().challenges[0]).toMatchObject({ title: "毎日2枚、写真を撮る", seal: "撮" });
  });

  it("deletes after confirmation and goes back to きょう", () => {
    const store = renderAt("/c/abc123def4567890", [ch({})]);
    fireEvent.click(screen.getByRole("button", { name: "このチャレンジを削除" }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "削除する" }));
    expect(store.getSnapshot().challenges).toHaveLength(0);
    expect(screen.getByTestId("where").textContent).toBe("/");
  });

  it("shows the reflection of a finished challenge and a not-found state for unknown ids", () => {
    renderAt("/c/abc123def4567890", [ch({ status: "done", verdict: "stop", reflection: "合わなかった", startDate: addDays(today, -20), finishedDay: 9, finishedAt: 3 })]);
    expect(screen.getByText("「合わなかった」")).toBeTruthy();
    expect(screen.getByText("9日目で区切りました。")).toBeTruthy();
    expect(screen.getByRole("link", { name: "シェア用カードを見る" }).getAttribute("href")).toBe("/c/abc123def4567890/reflect");
    expect(screen.queryByRole("button", { name: "編集" })).toBeNull();
  });

  it("shows a not-found state for an unknown id", () => {
    renderAt("/c/zzzzzzzzzzzzzzzz", []);
    expect(screen.getByText("このチャレンジはありません")).toBeTruthy();
    expect(screen.getByRole("link", { name: "きょうに戻る" }).getAttribute("href")).toBe("/");
  });
});

describe("LogPage", () => {
  it("lists finished challenges with their verdict, totals and notes (CUF-2 step 4)", () => {
    renderAt("/log", [
      ch({ id: "done000000000001", status: "done", verdict: "continue", reflection: "続けたい", startDate: addDays(today, -40), finishedDay: 30, finishedAt: 9, stamps: { "1": { at: 1 }, "2": { at: 2, note: "初日より楽" } } }),
      ch({ id: "active0000000002", startDate: addDays(today, -1), stamps: { "2": { at: 3, note: "きょうのメモ" } } }),
      ch({ id: "wait000000000003", startDate: nextFirst(today) }),
    ]);
    expect(screen.getByRole("heading", { level: 1, name: "記録" })).toBeTruthy();
    const tried = document.querySelector(".lp-stat-tried")!;
    expect(tried.textContent).toContain("2"); // the reservation is not counted yet
    expect(document.querySelector(".lp-stat-stamps")!.textContent).toContain("3");
    const finished = within(screen.getByRole("region", { name: "終わった30日" })).getByRole("link");
    expect(within(finished).getByText("続ける").className).toContain("badge");
    expect(finished.getAttribute("href")).toBe("/c/done000000000001");
    const notes = screen.getAllByRole("listitem").filter((li) => li.className === "lp-note");
    expect(notes.map((n) => n.textContent)).toEqual([expect.stringContaining("きょうのメモ"), expect.stringContaining("初日より楽")]);
  });

  it("shows an empty state with a way to start", () => {
    renderAt("/log", []);
    expect(screen.getByText("まだ記録はありません")).toBeTruthy();
    expect(screen.getByRole("link", { name: "レシピから選ぶ" }).getAttribute("href")).toBe("/recipes");
  });
});

// ---------- a day note shown in 「みんな」 (#17) ----------

describe("ひとこと: みんなに見せる (#17)", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const me = { id: "u0000000000001", nickname: "みず", tz: deviceTimeZone(), shareProgress: true, reminder: { enabled: false, time: "21:00" }, createdAt: 1 };
  const SHEET = "このひとことを「みんな」に見せますか？";

  type Seed = { online?: boolean; token?: boolean; user?: typeof me | null };
  function renderNotes(path: string, challenges: Challenge[], { online = false, token = false, user }: Seed = {}) {
    setOnline(online);
    if (token) localStorage.setItem("thirty-days.token", "tok");
    localStorage.setItem("thirty-days.state.v1", JSON.stringify({ v: 1, base: { user: user ?? (token ? me : null), challenges }, pendingNickname: null }));
    const store = createAppStore();
    render(
      <MemoryRouter initialEntries={[path]}>
        <ToastProvider>
          <AppProvider store={store}>
            <Routes>
              <Route path="/" element={<TodayPage />} />
              <Route path="c/:id" element={<ChallengePage />} />
              <Route path="log" element={<LogPage />} />
            </Routes>
            <ToastHost />
          </AppProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
    return store;
  }

  /**
   * The API for one challenge: stamps (with the reset rule) and PUT .../visibility, held until
   * release() with `hold`. `stampDown`: every stamp PUT and DELETE answers 503 (the queue keeps it
   * and retries) until up().
   */
  function serve(initial: Challenge, { hold = false, stampDown = false } = {}) {
    let c = initial;
    let down = stampDown;
    let release = () => {};
    const open = hold ? new Promise<void>((r) => (release = r)) : Promise.resolve();
    const calls: { method: string; url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = init?.body ? (JSON.parse(String(init.body)) as { note?: string; show?: boolean }) : undefined;
        calls.push({ method, url, body });
        if (url === API.me) return json(200, { user: me, today });
        if (url === API.challenges) return json(200, { challenges: [c], today });
        if (down && url === API.stamp(c.id, 1)) return json(503, { error: { code: "unavailable", message: "うまくいきませんでした" } });
        if (method === "PUT" && url === API.stamp(c.id, 1)) {
          const prev = c.stamps["1"];
          const note = body?.note ?? prev?.note;
          const keep = !!note && prev?.shown === true && note === prev.note;
          c = { ...c, stamps: { ...c.stamps, "1": { at: prev?.at ?? 1, ...(note ? { note } : {}), ...(keep ? { shown: true } : {}) } } };
          return json(200, { challenge: c });
        }
        if (method === "DELETE" && url === API.stamp(c.id, 1)) {
          const { "1": _gone, ...rest } = c.stamps;
          c = { ...c, stamps: rest };
          return json(200, { challenge: c });
        }
        if (method === "PUT" && url === API.noteVisibility(c.id, 1)) {
          // Like the API: with no stamp that day (an undo that arrived first), hiding answers as it is.
          const s = c.stamps["1"];
          if (s) c = { ...c, stamps: { ...c.stamps, "1": body?.show ? { ...s, shown: true } : { at: s.at, ...(s.note ? { note: s.note } : {}) } } };
          const answer = { challenge: c };
          await open;
          return json(200, answer);
        }
        return json(404, { error: { code: "not_found", message: "見つかりません" } });
      }),
    );
    return {
      calls,
      release: () => release(),
      up: () => {
        down = false;
      },
    };
  }

  const theSwitch = () => screen.getByRole("switch", { name: "みんなに見せる" }) as HTMLInputElement;
  const described = (el: HTMLElement) => document.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent;

  it("an existing note is private: the switch is off, says what turning it on does, and there is no tag", () => {
    renderNotes("/c/abc123def4567890", [ch({ startDate: addDays(today, -4), stamps: { "2": { at: 1, note: "駅まで遠回り" } } })]);
    const listed = screen.getByRole("button", { name: /2日目\s*駅まで遠回り/ });
    expect(within(listed).queryByText("みんな")).toBeNull();
    fireEvent.click(listed);
    expect(screen.getByLabelText("この日のひとこと（自分だけに見えます）")).toBeTruthy();
    expect(theSwitch().checked).toBe(false);
    expect(theSwitch().disabled).toBe(false);
    expect(described(theSwitch())).toBe("オンにすると、この日のひとことだけが「みんな」に表示されます。");
  });

  it("cannot be turned on without a note, with a URL, or while progress is not shown", () => {
    renderNotes("/", [ch({ stamps: { "1": { at: 1 } } })]);
    expect(theSwitch().disabled).toBe(true);
    expect(described(theSwitch())).toBe("ひとことを書くと、みんなに見せるか選べます。");
    const field = screen.getByLabelText("きょうのひとこと（自分だけに見えます）");
    fireEvent.change(field, { target: { value: "https://example.com を見た" } });
    expect(theSwitch().disabled).toBe(true);
    expect(described(theSwitch())).toBe("URLが入ったひとことは、みんなに見せられません。");
    fireEvent.change(field, { target: { value: "朝の光" } });
    expect(theSwitch().disabled).toBe(false);
  });

  it("while progress is not shown, cannot be turned on and says why", () => {
    renderNotes("/", [ch({ stamps: { "1": { at: 1, note: "朝の光" } } })], { user: { ...me, shareProgress: false } });
    expect(theSwitch().disabled).toBe(true);
    expect(described(theSwitch())).toBe("進捗の表示がオフのあいだは選べません（設定で変えられます）。");
  });

  it("a note shown before progress was turned off is seen by nobody now, and can still go back to private", () => {
    renderNotes("/", [ch({ stamps: { "1": { at: 1, note: "朝の光", shown: true } } })], { user: { ...me, shareProgress: false } });
    expect(theSwitch().checked).toBe(true);
    expect(theSwitch().disabled).toBe(false);
    expect(described(theSwitch())).toBe("進捗の表示がオフなので、いまは誰にも見えていません。");
    // The label agrees: still chosen, but not shown now.
    expect(screen.getByLabelText("きょうのひとこと（みんなに見せる選択中・進捗の表示はオフ）")).toBeTruthy();
  });

  it("progress turned off here but not sent yet: the note is still seen, and nothing says otherwise", () => {
    const store = renderNotes("/", [ch({ stamps: { "1": { at: 1, note: "朝の光", shown: true } } })], { user: me });
    expect(described(theSwitch())).toBe("「みんな」で誰でも見られます。書き換えると「自分だけ」に戻ります。");
    act(() => {
      expect(store.actions.updateMe({ shareProgress: false }).ok).toBe(true);
    });
    expect(theSwitch().checked).toBe(true);
    expect(described(theSwitch())).toBe("送信が終わるまで、このひとことは「みんな」に見えています。");
    expect(screen.getByLabelText("きょうのひとこと（みんなに見せる選択中・進捗の表示はオフ）")).toBeTruthy();
  });

  it("saves a draft first and asks with the exact cleaned text; 「やめておく」 sends nothing", async () => {
    const c = ch({ stamps: { "1": { at: 1 } } });
    const api = serve(c);
    const store = renderNotes("/", [c], { online: true, token: true });
    await waitFor(() => expect(api.calls.some((x) => x.url === API.challenges)).toBe(true));
    fireEvent.change(screen.getByLabelText("きょうのひとこと（自分だけに見えます）"), { target: { value: "  朝の   光  " } });
    fireEvent.click(theSwitch());

    const dialog = screen.getByRole("dialog", { name: SHEET });
    expect(store.getSnapshot().challenges[0]!.stamps["1"]?.note).toBe("朝の 光");
    expect(dialog.textContent).toContain("「みんな」の「詳しく見る」では、こう見えます");
    const preview = dialog.querySelector<HTMLElement>(".mn-item")!; // the same item as in 「詳しく見る」
    expect(within(preview).getByText("1日目")).toBeTruthy();
    expect(within(preview).getByText("朝の 光")).toBeTruthy();
    for (const line of [
      "アカウントがない人も含めて、誰でも見られます。",
      "見せるのは、この日のひとことだけです。ほかの日のひとことが見えるかどうかは変わりません。写真はどの日も自分だけに見えます。",
      "名前や連絡先、URL、ほかの人のことは書かないでください。",
      "「自分だけ」には、つながっているときならいつでも戻せます。書き換えたときも、送信が終わると「自分だけ」に戻ります。",
    ]) {
      expect(within(dialog).getByText(line)).toBeTruthy();
    }
    expect(dialog.textContent).toContain("見せると利用規約とプライバシーポリシーに同意したことになります。");
    expect(within(dialog).getByRole("link", { name: "利用規約" }).getAttribute("href")).toBe("/terms");

    fireEvent.click(within(dialog).getByRole("button", { name: "やめておく" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(theSwitch().checked).toBe(false);
    expect(api.calls.some((x) => x.url.endsWith("/visibility"))).toBe(false);
  });

  it("the label and the switch change only when the server confirms; turning it off asks nothing", async () => {
    const c = ch({ stamps: { "1": { at: 1, note: "朝の光" } } });
    const api = serve(c, { hold: true });
    renderNotes("/", [c], { online: true, token: true });
    await waitFor(() => expect(api.calls.some((x) => x.url === API.challenges)).toBe(true));
    fireEvent.click(theSwitch());
    fireEvent.click(within(screen.getByRole("dialog", { name: SHEET })).getByRole("button", { name: "見せる" }));
    await waitFor(() => expect(api.calls.some((x) => x.url.endsWith("/visibility"))).toBe(true));
    expect(api.calls.find((x) => x.url.endsWith("/visibility"))!.body).toEqual({ show: true, note: "朝の光" });
    // Sent, not confirmed yet: nothing on screen says it is shown.
    expect(screen.getByLabelText("きょうのひとこと（自分だけに見えます）")).toBeTruthy();
    expect(theSwitch().checked).toBe(false);

    act(() => api.release());
    expect(await screen.findByLabelText("きょうのひとこと（みんなに見せています）")).toBeTruthy();
    expect(theSwitch().checked).toBe(true);
    expect(described(theSwitch())).toBe("「みんな」で誰でも見られます。書き換えると「自分だけ」に戻ります。");
    expect(await screen.findByText("みんなに見せました")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(theSwitch());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByLabelText("きょうのひとこと（自分だけに見えます）")).toBeTruthy();
    expect(await screen.findByText("自分だけに戻しました")).toBeTruthy();
    expect(api.calls.filter((x) => x.url.endsWith("/visibility")).map((x) => x.body)).toEqual([{ show: true, note: "朝の光" }, { show: false }]);
  });

  it("saving another text offline: private here, and it says the old text is seen until it is sent; undoing the stamp warns first", async () => {
    const store = renderNotes("/", [ch({ stamps: { "1": { at: 1, note: "朝の光", shown: true } } })]);
    expect(theSwitch().checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "取り消す" }));
    const confirm = screen.getByRole("alertdialog");
    expect(confirm.textContent).toContain("この日のひとこと「朝の光」も消えます。");
    expect(confirm.textContent).toContain("みんなに見せているひとことも消えます。");
    fireEvent.click(within(confirm).getByRole("button", { name: "そのままにする" }));

    const field = screen.getByLabelText("きょうのひとこと（みんなに見せています）");
    fireEvent.change(field, { target: { value: "夕方の光" } });
    fireEvent.blur(field);
    // Only queued (offline): the server still shows 「朝の光」, so nothing claims it is private yet.
    expect(await screen.findByText("書き換えました。送信が終わると「自分だけ」に戻ります（それまでは前のひとことが見えています）。")).toBeTruthy();
    expect(screen.queryByText(/戻しました/)).toBeNull();
    expect(screen.getByLabelText("きょうのひとこと（自分だけに見えます）")).toBeTruthy();
    // The switch says what the server shows: on until the edit is sent (turning it off needs a connection).
    expect(theSwitch().checked).toBe(true);
    expect(described(theSwitch())).toBe("送信が終わるまで、前のひとことが「みんな」に見えています。");
    expect(store.getSnapshot().stillShown).toEqual(["abc123def4567890#1"]);
    fireEvent.click(theSwitch());
    expect(screen.queryByRole("dialog", { name: SHEET })).toBeNull();
    expect(await screen.findByText("つながっていないため変えられませんでした。つながってからもう一度お試しください。")).toBeTruthy();
    expect(theSwitch().checked).toBe(true);
  });

  it("saving another text online says it is private once the server has the edit", async () => {
    const c = ch({ stamps: { "1": { at: 1, note: "朝の光", shown: true } } });
    const api = serve(c);
    const store = renderNotes("/", [c], { online: true, token: true });
    await waitFor(() => expect(api.calls.some((x) => x.url === API.challenges)).toBe(true));
    const field = screen.getByLabelText("きょうのひとこと（みんなに見せています）");
    fireEvent.change(field, { target: { value: "夕方の光" } });
    fireEvent.blur(field);
    expect(await screen.findByText("書き換えたので「自分だけ」に戻しました。見せるときは、もう一度選んでください。")).toBeTruthy();
    expect(api.calls.filter((x) => x.method === "PUT").map((x) => [x.url, x.body])).toEqual([[API.stamp(c.id, 1), { note: "夕方の光" }]]);
    expect(store.getSnapshot().stillShown).toEqual([]);
    expect(described(theSwitch())).toBe("オンにすると、この日のひとことだけが「みんな」に表示されます。");
  });

  it.each([
    ["きょう", "/", "きょうのひとこと（みんなに見せています）"],
    ["the challenge page", "/c/abc123def4567890", "この日のひとこと（みんなに見せています）"],
  ])("on %s, editing a shown note and then pressing the switch to hide it never asks to show the new text", async (_, path, label) => {
    const c = ch({ stamps: { "1": { at: 1, note: "駅でAさんに会った", shown: true } } });
    const api = serve(c);
    renderNotes(path, [c], { online: true, token: true });
    await waitFor(() => expect(api.calls.some((x) => x.url === API.challenges)).toBe(true));
    const field = screen.getByLabelText(label);
    fireEvent.change(field, { target: { value: "駅で知り合いに会った" } });
    // A tap's real order: the press, then the field loses focus (and saves, making it private), then the click.
    fireEvent.pointerDown(theSwitch());
    fireEvent.blur(field);
    // The edit is on its way, and until it arrives the server still shows the old text: still on.
    expect(theSwitch().checked).toBe(true);
    fireEvent.click(theSwitch());
    expect(screen.queryByRole("dialog", { name: SHEET })).toBeNull();
    // The tap meant "hide": sent at once, beside the edit (both toasts say it is private).
    expect(await screen.findByText(/「?自分だけ」?に戻しました/)).toBeTruthy();
    await waitFor(() => expect(theSwitch().checked).toBe(false));
    expect(screen.queryByRole("dialog", { name: SHEET })).toBeNull();
    expect(api.calls.filter((x) => x.url.endsWith("/visibility")).map((x) => x.body)).toEqual([{ show: false }]);
    expect(api.calls.filter((x) => x.url === API.stamp(c.id, 1)).map((x) => x.body)).toEqual([{ note: "駅で知り合いに会った" }]);
  });

  it.each([
    ["きょう", "/", "きょうのひとこと（みんなに見せています）"],
    ["the challenge page", "/c/abc123def4567890", "この日のひとこと（みんなに見せています）"],
  ])("on %s, a click with no press seen (a screen reader's) right after saving made the note private never asks to show the new text", async (_, path, label) => {
    const c = ch({ stamps: { "1": { at: 1, note: "駅でAさんに会った", shown: true } } });
    const api = serve(c);
    renderNotes(path, [c], { online: true, token: true });
    await waitFor(() => expect(api.calls.some((x) => x.url === API.challenges)).toBe(true));
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const field = screen.getByLabelText(label);
      fireEvent.change(field, { target: { value: "駅で知り合いに会った" } });
      fireEvent.blur(field);
      // The server has the edit before the click arrives: the switch is already off.
      expect(await screen.findByText("書き換えたので「自分だけ」に戻しました。見せるときは、もう一度選んでください。")).toBeTruthy();
      expect(theSwitch().checked).toBe(false);
      fireEvent.click(theSwitch());
      expect(screen.queryByRole("dialog", { name: SHEET })).toBeNull();
      // A press that never became a click leaves nothing behind: a scroll that started on the
      // switch, or focus that moved away.
      fireEvent.pointerDown(theSwitch());
      fireEvent.pointerCancel(theSwitch());
      now += 400;
      fireEvent.click(theSwitch());
      expect(screen.queryByRole("dialog", { name: SHEET })).toBeNull();
      theSwitch().focus();
      fireEvent.pointerDown(theSwitch());
      fireEvent.blur(theSwitch());
      now += 500;
      fireEvent.click(theSwitch());
      expect(screen.queryByRole("dialog", { name: SHEET })).toBeNull();
      expect(theSwitch().checked).toBe(false);

      // Later, the same click is a choice to show the new text: it asks first.
      now += 200;
      fireEvent.click(theSwitch());
      expect(within(screen.getByRole("dialog", { name: SHEET })).getByText("駅で知り合いに会った")).toBeTruthy();
      expect(api.calls.filter((x) => x.url.endsWith("/visibility"))).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });

  it("while an edit of a shown note cannot be sent yet, the switch stays on and turning it off takes the old text back at once", async () => {
    const c = ch({ stamps: { "1": { at: 1, note: "駅でAさんに会った", shown: true } } });
    const api = serve(c, { stampDown: true });
    const store = renderNotes("/", [c], { online: true, token: true });
    await waitFor(() => expect(api.calls.some((x) => x.url === API.challenges)).toBe(true));
    const field = screen.getByLabelText("きょうのひとこと（みんなに見せています）");
    fireEvent.change(field, { target: { value: "駅で知り合いに会った" } });
    fireEvent.blur(field);
    expect(await screen.findByText("書き換えました。送信が終わると「自分だけ」に戻ります（それまでは前のひとことが見えています）。")).toBeTruthy();
    expect(theSwitch().checked).toBe(true);
    // Online, the status also says what a press does (offline it cannot: see "saving another text offline").
    expect(described(theSwitch())).toBe("送信が終わるまで、前のひとことが「みんな」に見えています。オフにすると、すぐ見えなくなります。");
    expect(store.getSnapshot().stillShown).toEqual(["abc123def4567890#1"]);

    fireEvent.pointerDown(theSwitch());
    fireEvent.click(theSwitch());
    expect(screen.queryByRole("dialog", { name: SHEET })).toBeNull();
    expect(await screen.findByText("自分だけに戻しました")).toBeTruthy();
    expect(api.calls.filter((x) => x.url.endsWith("/visibility")).map((x) => x.body)).toEqual([{ show: false }]);
    expect(store.getSnapshot().stillShown).toEqual([]);
    expect(theSwitch().checked).toBe(false);
    expect(described(theSwitch())).toBe("オンにすると、この日のひとことだけが「みんな」に表示されます。");
    // The edit still waits to be sent; the field keeps it.
    expect(store.getSnapshot().pending).toBe(1);
    expect((screen.getByLabelText("きょうのひとこと（自分だけに見えます）") as HTMLInputElement).value).toBe("駅で知り合いに会った");
  });

  it.each([
    ["きょう", "/", "きょうのひとこと"],
    ["the challenge page", "/c/abc123def4567890", "この日のひとこと"],
  ])("on %s, editing again while the first edit of a shown note waits counts as editing a shown note: a click with no press seen right after never asks", async (_, path, label) => {
    const c = ch({ stamps: { "1": { at: 1, note: "駅でAさんに会った", shown: true } } });
    const api = serve(c, { stampDown: true });
    renderNotes(path, [c], { online: true, token: true });
    await waitFor(() => expect(api.calls.some((x) => x.url === API.challenges)).toBe(true));
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const first = screen.getByLabelText(`${label}（みんなに見せています）`);
      fireEvent.change(first, { target: { value: "駅で知り合いに会った" } });
      fireEvent.blur(first);
      expect(await screen.findByText("書き換えました。送信が終わると「自分だけ」に戻ります（それまでは前のひとことが見えています）。")).toBeTruthy();
      expect(theSwitch().checked).toBe(true);

      // Later, another edit; the server is back and takes both before a screen reader's click arrives.
      now += 5000;
      const second = screen.getByLabelText(`${label}（自分だけに見えます）`);
      fireEvent.change(second, { target: { value: "駅で友だちに会った" } });
      api.up();
      fireEvent.blur(second);
      await waitFor(() => expect(theSwitch().checked).toBe(false));
      fireEvent.click(theSwitch());
      expect(screen.queryByRole("dialog", { name: SHEET })).toBeNull();
      expect(await screen.findByText("書き換えたので「自分だけ」に戻しました。見せるときは、もう一度選んでください。")).toBeTruthy();
      expect(api.calls.filter((x) => x.url.endsWith("/visibility"))).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    ["きょう", "/", "取り消す"],
    ["the challenge page", "/c/abc123def4567890", "この日の印を取り消す"],
  ])("on %s, undoing the stamp of a shown note offline says the note is seen until the undo is sent", async (_, path, undo) => {
    renderNotes(path, [ch({ stamps: { "1": { at: 1, note: "朝の光", shown: true } } })]);
    fireEvent.click(screen.getByRole("button", { name: undo }));
    const confirm = screen.getByRole("alertdialog");
    expect(confirm.textContent).toContain("みんなに見せているひとことも消えます。");
    fireEvent.click(within(confirm).getByRole("button", { name: "取り消す" }));
    expect(await screen.findByText("印を取り消しました。見せていたひとことは、送信が終わるまで「みんな」に見えています。")).toBeTruthy();
  });

  it.each([
    ["きょう", "/", "取り消す"],
    ["the challenge page", "/c/abc123def4567890", "この日の印を取り消す"],
  ])("on %s, undoing the stamp of a shown note online takes the note back at once, even while the undo cannot be sent yet", async (_, path, undo) => {
    const c = ch({ stamps: { "1": { at: 1, note: "朝の光", shown: true } } });
    const api = serve(c, { stampDown: true });
    const store = renderNotes(path, [c], { online: true, token: true });
    await waitFor(() => expect(api.calls.some((x) => x.url === API.challenges)).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: undo }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "取り消す" }));
    await waitFor(() => expect(api.calls.some((x) => x.method === "DELETE")).toBe(true));
    await waitFor(() => expect(store.getSnapshot().stillShown).toEqual([]));
    // The switch went with the stamp: the note was taken back beside the queue, without waiting for the undo.
    expect(api.calls.filter((x) => x.url.endsWith("/visibility")).map((x) => x.body)).toEqual([{ show: false }]);
    await act(() => store.actions.flush());
    expect(store.getSnapshot().pending).toBe(1);
    expect(screen.queryByText(/見せていたひとこと/)).toBeNull();
  });

  it("undoing the stamp of a shown note online says nothing more once the server has it", async () => {
    const c = ch({ stamps: { "1": { at: 1, note: "朝の光", shown: true } } });
    const api = serve(c);
    const store = renderNotes("/c/abc123def4567890", [c], { online: true, token: true });
    await waitFor(() => expect(api.calls.some((x) => x.url === API.challenges)).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "この日の印を取り消す" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "取り消す" }));
    await waitFor(() => expect(api.calls.some((x) => x.method === "DELETE")).toBe(true));
    await waitFor(() => expect(store.getSnapshot().pending).toBe(0));
    expect(store.getSnapshot().stillShown).toEqual([]);
    expect(screen.queryByText(/見せていたひとこと/)).toBeNull();
  });

  it("turning it off keeps the switch enabled and focused while the server answers (aria-disabled), and ignores a second press", async () => {
    const c = ch({ stamps: { "1": { at: 1, note: "朝の光", shown: true } } });
    const api = serve(c, { hold: true });
    renderNotes("/", [c], { online: true, token: true });
    await waitFor(() => expect(api.calls.some((x) => x.url === API.challenges)).toBe(true));
    const visibilityCalls = () => api.calls.filter((x) => x.url.endsWith("/visibility"));
    theSwitch().focus();
    fireEvent.keyDown(theSwitch(), { key: " " });
    fireEvent.click(theSwitch());
    await waitFor(() => expect(visibilityCalls()).toHaveLength(1));
    expect(theSwitch().disabled).toBe(false);
    expect(theSwitch().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(theSwitch());
    expect(theSwitch().checked).toBe(true);
    expect(visibilityCalls()).toHaveLength(1);

    act(() => api.release());
    expect(await screen.findByText("自分だけに戻しました")).toBeTruthy();
    expect(theSwitch().checked).toBe(false);
    expect(theSwitch().getAttribute("aria-disabled")).toBeNull();
    expect(document.activeElement).toBe(theSwitch());
    expect(visibilityCalls().map((x) => x.body)).toEqual([{ show: false }]);
  });

  it("a reflected challenge keeps its notes as they are, tags the shown one, and the switch still works both ways", () => {
    const done = ch({
      status: "done",
      verdict: "continue",
      startDate: addDays(today, -40),
      finishedDay: 30,
      finishedAt: 5,
      stamps: { "1": { at: 1, note: "初日", shown: true }, "2": { at: 2, note: "二日目" } },
    });
    renderNotes("/c/abc123def4567890", [done]);
    const first = screen.getByRole("button", { name: /1日目\s*初日/ });
    expect(within(first).getByText("みんな")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /2日目\s*二日目/ })).queryByText("みんな")).toBeNull();

    fireEvent.click(first);
    expect(screen.getByText("初日", { selector: ".cp-quote-sm" })).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(theSwitch().checked).toBe(true);
    expect(theSwitch().disabled).toBe(false);
    // The note cannot be rewritten any more: the status says what turning it off does instead.
    expect(described(theSwitch())).toBe("「みんな」で誰でも見られます。オフにすると「自分だけ」に戻ります。");
    fireEvent.click(screen.getByRole("button", { name: /2日目\s*二日目/ }));
    expect(theSwitch().checked).toBe(false);
    expect(theSwitch().disabled).toBe(false);
  });

  it("the log tags the shown note only", () => {
    renderNotes("/log", [ch({ startDate: addDays(today, -1), stamps: { "1": { at: 1, note: "見せた日", shown: true }, "2": { at: 2, note: "自分だけの日" } } })]);
    const notes = screen.getAllByRole("listitem").filter((li) => li.className === "lp-note");
    expect(notes.map((n) => [n.textContent?.includes("見せた日"), within(n).queryByText("みんな") !== null])).toEqual([
      [false, false],
      [true, true],
    ]);
  });
});
