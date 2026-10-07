import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextFirst, type Challenge, type User } from "@thirty/shared";
import { ToastProvider } from "../src/components/Toast";
import { StartChallengeSheet, type StartChallengeSheetProps } from "../src/features/start/StartChallengeSheet";
import { createAppStore } from "../src/lib/appStore";
import { AppProvider } from "../src/lib/store";

// Offline: the store queues writes and never calls the network in these tests.
beforeEach(() => {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
});
afterEach(() => {
  delete (navigator as { onLine?: boolean }).onLine;
});

const RECIPE = { id: "photo", title: "毎日1枚、写真を撮る", seal: "写" };

function openChallenge(i: number): Challenge {
  return {
    id: `open${String(i).padStart(12, "0")}`,
    recipeId: null,
    title: `チャレンジ${i}`,
    seal: "試",
    startDate: "2026-10-01",
    status: "active",
    stamps: {},
    verdict: null,
    reflection: null,
    finishedAt: null,
    finishedDay: null,
    cheers: 0,
    shareId: null,
    createdAt: i,
    updatedAt: i,
  };
}

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function setup(props: Partial<StartChallengeSheetProps> = {}, seed?: { challenges?: Challenge[]; user?: User; token?: boolean }) {
  if (seed) {
    localStorage.setItem("thirty-days.state.v1", JSON.stringify({ v: 1, base: { user: seed.user ?? null, challenges: seed.challenges ?? [] }, pendingNickname: null }));
    if (seed.token) localStorage.setItem("thirty-days.token", "tok");
  }
  const store = createAppStore();
  const spy = vi.spyOn(store.actions, "startChallenge");
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={["/recipes/photo"]}>
      <ToastProvider>
        <AppProvider store={store}>
          <Where />
          <StartChallengeSheet open onClose={onClose} recipe={RECIPE} {...props} />
        </AppProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
  return { store, spy, onClose, today: store.getSnapshot().today };
}

const submit = () => fireEvent.click(screen.getByRole("button", { name: "30日、始める" }));

describe("StartChallengeSheet", () => {
  it("starts today from a recipe, with the nickname (CUF-1 step 3)", () => {
    const { store, spy, onClose, today } = setup();
    expect(screen.getByRole("dialog", { name: "新しい30日" })).toBeTruthy();
    expect((screen.getByLabelText("チャレンジ名") as HTMLInputElement).value).toBe("毎日1枚、写真を撮る");
    expect((screen.getByLabelText("印（1文字）") as HTMLInputElement).value).toBe("写");
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios[0]!.checked).toBe(true);
    expect(screen.getByText(/^今日から/)).toBeTruthy();
    // The Terms bind on starting (TermsPage), so the sheet says so, with the links.
    const consent = document.querySelector<HTMLElement>(".consent-note")!;
    expect(consent.textContent).toBe("始めると利用規約とプライバシーポリシーに同意したことになります。");
    expect(within(consent).getByRole("link", { name: "利用規約" }).getAttribute("href")).toBe("/terms");
    expect(within(consent).getByRole("link", { name: "プライバシーポリシー" }).getAttribute("href")).toBe("/privacy");

    fireEvent.change(screen.getByLabelText("ニックネーム（任意）"), { target: { value: "ミズキ" } });
    submit();

    expect(spy).toHaveBeenCalledWith({ title: "毎日1枚、写真を撮る", seal: "写", startDate: today, recipeId: "photo", nickname: "ミズキ" });
    expect(spy.mock.results[0]?.value).toMatchObject({ ok: true });
    const snap = store.getSnapshot();
    expect(snap.challenges).toHaveLength(1);
    expect(snap.challenges[0]).toMatchObject({ title: "毎日1枚、写真を撮る", seal: "写", startDate: today, recipeId: "photo" });
    expect(snap.pending).toBe(1); // queued offline
    expect(snap.pendingNickname).toBe("ミズキ");
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByTestId("where").textContent).toBe("/");
  });

  it("reserves the next 1st (1日組)", () => {
    const { spy, today } = setup();
    const nf = nextFirst(today);
    const first = screen.getAllByRole("radio")[1] as HTMLInputElement;
    expect(first.closest("label")?.textContent).toContain("（1日組）");
    expect(first.closest("label")?.textContent).toContain("同じ日に始める仲間と並びます");
    fireEvent.click(first);
    submit();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ startDate: nf }));
    expect(spy.mock.results[0]?.value).toMatchObject({ ok: true, value: { startDate: nf } });
  });

  it("preselects the 1日組 option from a preset and calls onStarted instead of navigating", () => {
    const onStarted = vi.fn();
    setup({ recipe: null, preset: { title: "朝に白湯を飲む", firstOfMonth: true }, onStarted });
    expect((screen.getAllByRole("radio")[1] as HTMLInputElement).checked).toBe(true);
    // Empty seal → the title's first character, shown in the live preview.
    expect((screen.getByLabelText("印（1文字）") as HTMLInputElement).placeholder).toBe("朝");
    submit();
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(onStarted.mock.calls[0]![0]).toMatch(/^[0-9a-z]{16}$/);
    expect(screen.getByTestId("where").textContent).toBe("/recipes/photo");
  });

  it("shows field errors from the shared schema and starts nothing", () => {
    const { store, spy } = setup({ recipe: null });
    submit();
    expect(screen.getByText("チャレンジ名を入力してください")).toBeTruthy();
    expect(spy.mock.results[0]?.value).toMatchObject({ ok: false });
    expect(store.getSnapshot().challenges).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByLabelText("チャレンジ名"));

    fireEvent.change(screen.getByLabelText("チャレンジ名"), { target: { value: "毎日歩く" } });
    fireEvent.change(screen.getByLabelText("印（1文字）"), { target: { value: "歩く" } });
    submit();
    expect(screen.getByText("印は1文字で入力してください")).toBeTruthy();
    expect(store.getSnapshot().challenges).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("印（1文字）"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("チャレンジ名"), { target: { value: "example.com を毎日見る" } });
    submit();
    expect(screen.getByText("チャレンジ名にURLは入れられません")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("チャレンジ名"), { target: { value: "毎日歩く" } });
    fireEvent.change(screen.getByLabelText("ニックネーム（任意）"), { target: { value: "あ".repeat(17) } });
    submit();
    expect(screen.getByText("ニックネームは16文字以内で入力してください")).toBeTruthy();
    expect(store.getSnapshot().challenges).toHaveLength(0);
  });

  it("explains the limit when 5 challenges are open", () => {
    setup({}, { challenges: [1, 2, 3, 4, 5].map(openChallenge) });
    expect(screen.getByText(/いま進めている30日が5件あります/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "30日、始める" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not ask for a nickname the account already has", () => {
    const user: User = { id: "u0000000000001", nickname: "ミズキ", tz: "Asia/Tokyo", shareProgress: false, reminder: { enabled: false, time: "21:00" }, createdAt: 1 };
    setup({}, { user, token: true });
    expect(screen.queryByLabelText("ニックネーム（任意）")).toBeNull();
    expect(screen.getByText(/進捗の公開はオフになっています/)).toBeTruthy();
  });

  it("asks again while the nickname is still the default 「名無し」", () => {
    const user: User = { id: "u0000000000001", nickname: "名無し", tz: "Asia/Tokyo", shareProgress: true, reminder: { enabled: false, time: "21:00" }, createdAt: 1 };
    setup({}, { user, token: true });
    expect((screen.getByLabelText("ニックネーム（任意）") as HTMLInputElement).value).toBe("");
    expect(screen.getByText(/「みんな」に表示されます/)).toBeTruthy();
  });
});
