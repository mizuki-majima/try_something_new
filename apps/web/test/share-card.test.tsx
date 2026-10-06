import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API, type Challenge } from "@thirty/shared";
import { ToastProvider } from "../src/components/Toast";
import { SharePanel } from "../src/features/share/SharePanel";
import type * as ShareCard from "../src/features/share/shareCard";
import {
  CARD,
  CARD_H,
  CARD_W,
  ELLIPSIS,
  computeCardLayout,
  fitTitle,
  graphemes,
  gridCells,
  shareCardAlt,
  shareCardData,
  wrapText,
  type Measure,
} from "../src/features/share/shareCard";
import { cardFileName, lineShareUrl, publicShareUrl, shareText, xIntentUrl } from "../src/features/share/shareActions";
import type { AppActions, AppSnapshot, AppStore } from "../src/lib/appStore";
import { AppProvider } from "../src/lib/store";

type ShareCardModule = typeof ShareCard;

vi.mock("../src/features/share/shareCard", async (importOriginal) => {
  const mod = await importOriginal<ShareCardModule>();
  // jsdom has no canvas: the drawing itself is replaced, the layout helpers stay real.
  return { ...mod, renderShareCard: vi.fn(async () => new Blob(["\x89PNG fake"], { type: "image/png" })) };
});

/** Every grapheme is 10px wide (font size ignored), ASCII 6px. */
const W = (s: string) => graphemes(s).reduce((n, g) => n + (/^[\x20-\x7e]$/.test(g) ? 6 : 10), 0);
/** Width proportional to the px size in the CSS font shorthand. */
const measure: Measure = (font, text) => {
  const size = Number(/(\d+)px/.exec(font)?.[1] ?? 16);
  return graphemes(text).reduce((n, g) => n + (/^[\x20-\x7e]$/.test(g) ? size * 0.6 : size), 0);
};

function challenge(over: Partial<Challenge> = {}): Challenge {
  return {
    id: "abc123def4567890",
    recipeId: "photo",
    title: "毎日1枚、写真を撮る",
    seal: "写",
    startDate: "2026-09-01",
    status: "done",
    stamps: { "1": { at: 1 }, "2": { at: 2, note: "朝" }, "5": { at: 5 } },
    verdict: "continue",
    reflection: "通勤路の見え方が変わった",
    finishedAt: 10,
    finishedDay: 30,
    cheers: 0,
    shareId: null,
    createdAt: 1,
    updatedAt: 10,
    ...over,
  };
}

describe("wrapText", () => {
  it("breaks Japanese text by graphemes", () => {
    expect(wrapText("あいうえおかきくけこ", 50, W).lines).toEqual(["あいうえお", "かきくけこ"]);
  });

  it("never starts a line with closing punctuation (kinsoku)", () => {
    const { lines } = wrapText("あいうえ、おかき。", 40, W);
    expect(lines).toEqual(["あいうえ、", "おかき。"]);
    for (const l of lines.slice(1)) expect("、。」）".includes(l[0]!)).toBe(false);
  });

  it("does not end a line with an opening bracket", () => {
    const { lines } = wrapText("あいう「えお」", 40, W);
    expect(lines[0]).toBe("あいう");
    expect(lines[1]!.startsWith("「")).toBe(true);
  });

  it("keeps emoji sequences whole", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const { lines } = wrapText(`あいう${family}えお`, 30, W);
    expect(lines.join("")).toBe(`あいう${family}えお`);
    expect(lines.some((l) => l === family || l.startsWith(family))).toBe(true);
  });

  it("moves a whole Latin word to the next line when there is a space before it", () => {
    const { lines } = wrapText("毎日 Duolingo", 60, W);
    expect(lines).toEqual(["毎日", "Duolingo"]);
  });

  it("keeps explicit newlines", () => {
    expect(wrapText("一行目\n二行目", 200, W).lines).toEqual(["一行目", "二行目"]);
  });

  it("cuts to maxLines with an ellipsis that fits", () => {
    const r = wrapText("あ".repeat(30), 50, W, 2);
    expect(r.truncated).toBe(true);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[1]!.endsWith(ELLIPSIS)).toBe(true);
    expect(W(r.lines[1]!)).toBeLessThanOrEqual(50);
  });
});

describe("fitTitle", () => {
  it("keeps a short title on one line at the biggest size", () => {
    const t = fitTitle("毎日20分歩く", 672, measure);
    expect(t.size).toBe(56);
    expect(t.lines).toEqual(["毎日20分歩く"]);
  });

  it("uses a smaller size and two lines for a long title", () => {
    const t = fitTitle("あ".repeat(30), 672, measure);
    expect(t.size).toBeLessThan(56);
    expect(t.lines.length).toBeLessThanOrEqual(2);
    expect(t.lines.join("").replace(ELLIPSIS, "").length).toBeGreaterThan(20);
  });
});

describe("computeCardLayout", () => {
  const inside = (x: number, y: number, w = 0, h = 0) =>
    x >= CARD.x && y >= CARD.y && x + w <= CARD.x + CARD.w && y + h <= CARD.y + CARD.h;

  it("places every part inside the 1200×630 card", () => {
    const d = shareCardData(challenge({ reflection: "あ".repeat(140), title: "あ".repeat(30) }));
    const l = computeCardLayout(d, measure);
    expect(CARD_W).toBe(1200);
    expect(CARD_H).toBe(630);
    expect(CARD.x + CARD.w + CARD.shadow).toBeLessThanOrEqual(CARD_W);
    expect(CARD.y + CARD.h + CARD.shadow).toBeLessThan(CARD_H);
    expect(l.grid).toHaveLength(30);
    for (const c of l.grid) expect(inside(c.x, c.y, c.w, c.h)).toBe(true);
    expect(inside(l.seal.cx - l.seal.r, l.seal.cy - l.seal.r, l.seal.r * 2, l.seal.r * 2)).toBe(true);
    expect(l.reflection).not.toBeNull();
    const r = l.reflection!;
    expect(r.y + r.lines.length * r.lineHeight).toBeLessThanOrEqual(CARD.y + CARD.h - CARD.pad + 1);
    // Title, grid and ひとこと do not overlap.
    expect(l.title.y + l.title.lines.length * l.title.lineHeight).toBeLessThanOrEqual(l.grid[0]!.y);
    expect(l.grid[29]!.y + l.grid[29]!.h).toBeLessThanOrEqual(r.y);
    // Logo and period sit on the strip under the card.
    expect(l.logo.y).toBeGreaterThan(CARD.y + CARD.h + CARD.shadow);
    expect(l.logo.y).toBeLessThan(CARD_H);
  });

  it("marks stamped cells and hatches days after an early finish", () => {
    const d = shareCardData(challenge({ finishedDay: 12, stamps: { "1": { at: 1 }, "12": { at: 2 } } }));
    const l = computeCardLayout(d, measure);
    expect(l.grid.filter((c) => c.stamped).map((c) => c.day)).toEqual([1, 12]);
    expect(l.grid.filter((c) => c.after).map((c) => c.day)).toEqual(Array.from({ length: 18 }, (_, i) => i + 13));
    expect(l.count.value).toBe("2");
    expect(l.count.denom).toContain("30");
  });

  it("puts the verdict sticker on the seal and the label in its colour", () => {
    const l = computeCardLayout(shareCardData(challenge({ verdict: "modify" })), measure);
    expect(l.sticker?.label).toBe("形を変える");
    expect(l.sticker?.color.toLowerCase()).toBe("#6c8cff");
  });

  it("falls back to the verdict description without a ひとこと", () => {
    const l = computeCardLayout(shareCardData(challenge({ reflection: null })), measure);
    expect(l.reflection?.lines.join("")).toContain("生活に残す");
  });

  it("lays out 15 cells per row", () => {
    const cells = gridCells(0, 0, 10, 2, 15, new Set([16]));
    expect(cells[15]).toMatchObject({ day: 16, x: 0, y: 12, stamped: true });
    expect(cells[14]).toMatchObject({ day: 15, x: 14 * 12, y: 0 });
  });

  it("describes the image for screen readers", () => {
    const alt = shareCardAlt(shareCardData(challenge()));
    expect(alt).toContain("毎日1枚、写真を撮る");
    expect(alt).toContain("3/30日");
    expect(alt).toContain("続ける");
  });
});

describe("share texts and links", () => {
  it("builds the post text and intent URLs", () => {
    const text = shareText({ title: "毎日20分歩く", count: 23, verdict: "continue", reflection: "楽しかった" });
    expect(text).toBe("30日だけ「毎日20分歩く」をやってみた。23/30日、結果は「続ける」。「楽しかった」 #30日だけ");
    expect(xIntentUrl(text)).toBe(`https://x.com/intent/post?text=${encodeURIComponent(text)}`);
    expect(xIntentUrl(text, "https://a.test/s/x")).toContain("&url=https%3A%2F%2Fa.test%2Fs%2Fx");
    expect(lineShareUrl("https://a.test/s/x")).toBe("https://social-plugins.line.me/lineit/share?url=https%3A%2F%2Fa.test%2Fs%2Fx");
    expect(publicShareUrl("abc", "https://a.test")).toBe("https://a.test/s/abc");
  });

  it("shortens a long ひとこと in the post text", () => {
    const text = shareText({ title: "t", count: 1, verdict: "stop", reflection: "あ".repeat(100) });
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(100);
  });

  it("names the image after the seal", () => {
    expect(cardFileName("写")).toBe("30days-写.png");
    expect(cardFileName("")).toBe("30days-card.png");
  });
});

// ---------- SharePanel: upload failure (CUF-2 E) ----------

function fakeStore(snap: Partial<AppSnapshot> = {}) {
  const snapshot: AppSnapshot = {
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
    lastSyncedAt: 1,
    lastStamped: null,
    ...snap,
  };
  const actions = {
    flush: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
  } as unknown as AppActions;
  const store: AppStore = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    onNotice: () => () => {},
    actions,
    start: () => () => {},
  };
  return store;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("SharePanel", () => {
  let calls: { method: string; url: string; body: unknown }[];
  const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };

  beforeEach(() => {
    calls = [];
    localStorage.setItem("thirty-days.token", "tok");
    // jsdom has no object URLs.
    URL.createObjectURL = vi.fn(() => "blob:card-1");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    URL.createObjectURL = original.create;
    URL.revokeObjectURL = original.revoke;
  });

  function stubFetch(sharesResponse: () => Response) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url === API.shares && method === "POST") return sharesResponse();
        if (url === API.shareMetric) return new Response(null, { status: 204 });
        return json(404, { error: { code: "not_found", message: "no" } });
      }),
    );
  }

  function renderPanel(c: Challenge, store = fakeStore()) {
    return render(
      <MemoryRouter>
        <ToastProvider>
          <AppProvider store={store}>
            <SharePanel challenge={c} />
          </AppProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  it("keeps saving and X sharing usable when the upload fails", async () => {
    stubFetch(() => json(500, { error: { code: "internal", message: "サーバーで問題が起きました。" } }));
    const store = fakeStore();
    renderPanel(challenge(), store);

    const img = await screen.findByRole("img", { name: /毎日1枚、写真を撮る/ });
    expect(img.getAttribute("src")).toBe("blob:card-1");

    fireEvent.click(screen.getByRole("button", { name: "リンクを作って共有" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("サーバーで問題が起きました。");
    expect(alert.textContent).toContain("画像の保存やXでの共有は、このまま使えます。");
    expect(store.actions.flush).toHaveBeenCalled();

    const post = calls.find((c) => c.url === API.shares);
    expect(post?.method).toBe("POST");
    expect(post?.body).toMatchObject({ challengeId: "abc123def4567890" });
    expect(typeof (post?.body as { imageBase64: string }).imageBase64).toBe("string");

    const save = screen.getByRole("link", { name: /画像を保存/ });
    expect(save.getAttribute("href")).toBe("blob:card-1");
    expect(save.getAttribute("download")).toBe("30days-写.png");
    const x = screen.getByRole("link", { name: /Xで共有/ });
    expect(x.getAttribute("href")).toMatch(/^https:\/\/x\.com\/intent\/post\?text=/);
    expect(x.getAttribute("href")).not.toContain("&url=");
    // LINE needs the public link, which does not exist.
    expect((screen.getByRole("button", { name: "LINEで送る" }) as HTMLButtonElement).disabled).toBe(true);
    // The link button is usable again for a retry.
    expect((screen.getByRole("button", { name: "リンクを作って共有" }) as HTMLButtonElement).disabled).toBe(false);

    // Local actions still count (fire-and-forget metric). jsdom cannot follow the download link.
    save.addEventListener("click", (e) => e.preventDefault());
    await act(async () => {
      fireEvent.click(save);
    });
    await waitFor(() => expect(calls.some((c) => c.url === API.shareMetric && (c.body as { channel: string }).channel === "image")).toBe(true));
    expect(calls.some((c) => c.url === API.shareMetric && (c.body as { channel: string }).channel === "link")).toBe(false);
  });

  it("shows the public URL with copy and LINE once the link exists", async () => {
    stubFetch(() => json(201, { id: "s1234567890abcd", url: "https://a.test/s/s1234567890abcd", imageUrl: "https://a.test/media/share/s1234567890abcd.png" }));
    const store = fakeStore();
    renderPanel(challenge(), store);
    await screen.findByRole("img", { name: /毎日1枚/ });

    fireEvent.click(screen.getByRole("button", { name: "リンクを作って共有" }));
    const input = (await screen.findByDisplayValue("https://a.test/s/s1234567890abcd")) as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect(screen.getByRole("button", { name: /コピー/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "リンクを削除" })).toBeTruthy();
    const line = screen.getByRole("link", { name: /LINEで送る/ });
    expect(line.getAttribute("href")).toBe(lineShareUrl("https://a.test/s/s1234567890abcd"));
    expect(screen.getByRole("link", { name: /Xで共有/ }).getAttribute("href")).toContain("&url=");
    expect(store.actions.refresh).toHaveBeenCalled();
    await waitFor(() => expect(calls.some((c) => c.url === API.shareMetric && (c.body as { channel: string }).channel === "link")).toBe(true));
  });

  it("uses an existing share id for the public URL", async () => {
    stubFetch(() => json(500, {}));
    renderPanel(challenge({ shareId: "exist1234567890a" }));
    expect(await screen.findByDisplayValue(`${location.origin}/s/exist1234567890a`)).toBeTruthy();
  });
});
