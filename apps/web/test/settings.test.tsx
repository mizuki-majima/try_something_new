import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { API, type BackupFile, type Challenge, type User } from "@thirty/shared";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ToastHost, ToastProvider } from "../src/components/Toast";
import { ApiClientError, THROTTLED_MESSAGE } from "../src/lib/api";
import { PROFILE_LIMIT_MESSAGE, type AppActions, type AppSnapshot, type AppStore } from "../src/lib/appStore";
import { KEYS, writeString } from "../src/lib/storage";
import { AppProvider } from "../src/lib/store";
import SettingsPage, { REMINDER_TIMES, importErrorMessage, importResultMessage, readBackupFile } from "../src/pages/SettingsPage";

const photos = vi.hoisted(() => ({ clearAllPhotos: vi.fn(async () => {}) }));
vi.mock("../src/lib/photos", () => photos);

const USER: User = {
  id: "u0000000000001",
  nickname: "たろう",
  tz: "Asia/Tokyo",
  shareProgress: true,
  reminder: { enabled: false, time: "21:00" },
  createdAt: 1,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const CHALLENGE: Challenge = {
  id: "ch00000000000001",
  recipeId: null,
  title: "毎日1枚、写真を撮る",
  seal: "写",
  startDate: "2026-10-01",
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
};

const BACKUP: BackupFile = {
  format: "thirty-days-backup",
  version: 1,
  exportedAt: 1,
  user: { nickname: "たろう", shareProgress: true, reminder: { enabled: false, time: "21:00" } },
  challenges: [],
};

function fakeStore(over: Partial<AppSnapshot> = {}) {
  const snap: AppSnapshot = {
    user: USER,
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
    throttle: null,
    profileLimitedUntil: null,
    ...over,
  };
  const actions = {
    startChallenge: vi.fn(),
    stamp: vi.fn(),
    unstamp: vi.fn(),
    setNote: vi.fn(),
    reflect: vi.fn(),
    updateChallenge: vi.fn(),
    deleteChallenge: vi.fn(),
    updateMe: vi.fn(() => ({ ok: true, value: undefined })),
    refresh: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    restoreWithCode: vi.fn(async () => ({ ok: true, value: USER })),
    resetLocal: vi.fn(),
    localBackup: vi.fn(() => BACKUP),
  };
  const store: AppStore = {
    getSnapshot: () => snap,
    subscribe: () => () => {},
    onNotice: () => () => {},
    actions: actions as unknown as AppActions,
    start: () => () => {},
  };
  return { store, actions };
}

function renderSettings(store: AppStore) {
  return render(
    <MemoryRouter initialEntries={["/settings"]}>
      <ToastProvider>
        <AppProvider store={store}>
          <Routes>
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/" element={<p>HOME</p>} />
          </Routes>
          <ToastHost />
        </AppProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

let fetchMock: Mock<typeof fetch>;

beforeEach(() => {
  writeString(KEYS.token, "tok");
  fetchMock = vi.fn<typeof fetch>(async () => json(404, { error: { code: "not_found", message: "no route" } }));
  vi.stubGlobal("fetch", fetchMock);
  photos.clearAllPhotos.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettingsPage — profile and reminder", () => {
  it("saves the nickname through updateMe", () => {
    const { store, actions } = fakeStore();
    renderSettings(store);
    const input = screen.getByLabelText("ニックネーム") as HTMLInputElement;
    expect(input.value).toBe("たろう");
    fireEvent.change(input, { target: { value: "みずき" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(actions.updateMe).toHaveBeenCalledWith({ nickname: "みずき" });
  });

  it("shows the field error when updateMe rejects the nickname", () => {
    const { store, actions } = fakeStore();
    actions.updateMe.mockReturnValueOnce({ ok: false, message: "ニックネームにURLは入れられません", fields: { nickname: "ニックネームにURLは入れられません" } } as never);
    renderSettings(store);
    fireEvent.change(screen.getByLabelText("ニックネーム"), { target: { value: "example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByText("ニックネームにURLは入れられません")).toBeTruthy();
  });

  it("toggles shareProgress and explains what is shown", () => {
    const { store, actions } = fakeStore();
    renderSettings(store);
    const toggle = screen.getByRole("checkbox", { name: "みんなに進捗を表示する" });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/ひとことメモ、写真、振り返りのひとこと/)).toBeTruthy();
    fireEvent.click(toggle);
    expect(actions.updateMe).toHaveBeenCalledWith({ shareProgress: false });
  });

  it("R1/R13: while the profile quota refuses changes, says why, locks the nickname and turning 「みんなに表示」 on, but not off", () => {
    const { store, actions } = fakeStore({ profileLimitedUntil: Date.now() + 3_600_000 });
    renderSettings(store);
    expect(screen.getByTestId("profile-limit").textContent).toBe(PROFILE_LIMIT_MESSAGE);
    expect(PROFILE_LIMIT_MESSAGE).toMatch(
      /^ニックネームの変更と「みんなに表示」をオンにするのは1日\d+回までです。あすの0時（日本時間）を過ぎると、また変えられます。オフにするのはいつでもできます。$/,
    );
    // Sharing is on: turning it off is a privacy action the quota never blocks (R13; before: disabled).
    const toggle = screen.getByRole("checkbox", { name: "みんなに進捗を表示する" }) as HTMLInputElement;
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);
    expect(actions.updateMe).toHaveBeenCalledWith({ shareProgress: false });
    actions.updateMe.mockClear();
    fireEvent.change(screen.getByLabelText("ニックネーム"), { target: { value: "みずき" } });
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
    expect(actions.updateMe).not.toHaveBeenCalled();
    // The reminder is not part of the quota.
    expect((screen.getByRole("checkbox", { name: "毎日リマインドする" }) as HTMLInputElement).disabled).toBe(false);
  });

  it("R13: while the profile quota refuses changes and sharing is off, turning it on is locked", () => {
    const { store } = fakeStore({ profileLimitedUntil: Date.now() + 3_600_000, user: { ...USER, shareProgress: false } });
    renderSettings(store);
    expect((screen.getByRole("checkbox", { name: "みんなに進捗を表示する" }) as HTMLInputElement).disabled).toBe(true);
  });

  it("R1: no limit note while profile changes are allowed", () => {
    const { store } = fakeStore();
    renderSettings(store);
    expect(screen.queryByTestId("profile-limit")).toBeNull();
    expect((screen.getByRole("checkbox", { name: "みんなに進捗を表示する" }) as HTMLInputElement).disabled).toBe(false);
  });

  it("turns the reminder on and changes its time (15-minute steps, 05:00–23:45)", () => {
    const { store, actions } = fakeStore();
    renderSettings(store);
    fireEvent.click(screen.getByRole("checkbox", { name: "毎日リマインドする" }));
    expect(actions.updateMe).toHaveBeenCalledWith({ reminder: { enabled: true, time: "21:00" } });

    const select = screen.getByLabelText("時刻") as HTMLSelectElement;
    expect(select.options).toHaveLength(76);
    expect(select.options[0]!.value).toBe("05:00");
    expect(select.options[select.options.length - 1]!.value).toBe("23:45");
    fireEvent.change(select, { target: { value: "07:15" } });
    expect(actions.updateMe).toHaveBeenLastCalledWith({ reminder: { enabled: false, time: "07:15" } });
    expect(REMINDER_TIMES).toContain("12:30");
  });

  it("points to calendars when this browser has no push", () => {
    const { store } = fakeStore({
      challenges: [
        {
          id: "c0000000000001",
          recipeId: "photo",
          title: "毎日1枚、写真を撮る",
          seal: "写",
          startDate: "2026-10-01",
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
        },
      ],
    });
    renderSettings(store);
    expect(screen.getByText(/このブラウザでは通知を使えません/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /毎日1枚、写真を撮る/ }).getAttribute("href")).toBe("/c/c0000000000001");
    // No push API here, so the public key is never fetched.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("SettingsPage — transfer", () => {
  it("issues a code and shows it big with the time left", async () => {
    const { store } = fakeStore();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === API.meTransferCode && init?.method === "POST") return json(201, { code: "AB12CD34", expiresAt: Date.now() + 15 * 60_000 });
      return json(404, { error: { code: "not_found", message: "no route" } });
    });
    renderSettings(store);
    fireEvent.click(screen.getByRole("button", { name: "引き継ぎコードを発行" }));
    const code = await screen.findByLabelText("引き継ぎコード A B 1 2 C D 3 4");
    expect(code.textContent).toBe("AB12CD34");
    expect(code.parentElement?.textContent).toMatch(/あと 1[45]:\d\d 有効/);
    const [, init] = fetchMock.mock.calls.find(([u]) => String(u) === API.meTransferCode)!;
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("warns, confirms and restores with a code", async () => {
    const { store, actions } = fakeStore();
    renderSettings(store);
    expect(screen.getByText(/この端末にいまある記録は、コードを発行したアカウントの記録に置き換わります/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("引き継ぎコード（8文字）"), { target: { value: "ab12-cd34" } });
    fireEvent.click(screen.getByRole("button", { name: "引き継ぐ" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "置き換えて引き継ぐ" }));
    await waitFor(() => expect(actions.restoreWithCode).toHaveBeenCalledWith("ab12-cd34"));
    await screen.findByText("HOME");
  });

  it("rejects a malformed code before calling the store", () => {
    const { store, actions } = fakeStore();
    renderSettings(store);
    fireEvent.change(screen.getByLabelText("引き継ぎコード（8文字）"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "引き継ぐ" }));
    expect(screen.getByText("引き継ぎコードは8文字です")).toBeTruthy();
    expect(actions.restoreWithCode).not.toHaveBeenCalled();
  });
});

describe("SettingsPage — backup import", () => {
  const file = (text: string, name = "backup.json") => new File([text], name, { type: "application/json" });

  it("rejects files that are not a valid backup", async () => {
    await expect(readBackupFile(file("not json"))).resolves.toMatchObject({ ok: false });
    await expect(readBackupFile(file(JSON.stringify({ foo: 1 })))).resolves.toEqual({
      ok: false,
      message: "「30日だけ」のバックアップファイルではないようです。",
    });
    await expect(readBackupFile(file(JSON.stringify({ ...BACKUP, challenges: [{ id: "x" }] })))).resolves.toMatchObject({ ok: false });
    await expect(readBackupFile(file(JSON.stringify(BACKUP)))).resolves.toMatchObject({ ok: true });
  });

  it("R5: a concurrent import (409) says it is still importing", async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input) === API.meImport ? json(409, { error: { code: "conflict", message: "読み込み中です。少し待ってからもう一度" } }) : json(404, {}),
    );
    const { store, actions } = fakeStore();
    renderSettings(store);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("バックアップファイル"), { target: { files: [file(JSON.stringify({ ...BACKUP, challenges: [CHALLENGE] }))] } });
    });
    fireEvent.click(await screen.findByRole("button", { name: "読み込む" }));
    expect((await screen.findByRole("alert")).textContent).toBe("読み込み中です。少し待ってから、もう一度お試しください。");
    expect(fetchMock.mock.calls.filter(([u]) => String(u) === API.meImport)).toHaveLength(1);
    expect(actions.refresh).not.toHaveBeenCalled();
  });

  it("import errors: 409 → still importing, the daily quota → its limit, anything else → the API's words", () => {
    expect(importErrorMessage(new ApiClientError(409, "conflict"))).toBe("読み込み中です。少し待ってから、もう一度お試しください。");
    expect(importErrorMessage(new ApiClientError(429, "rate_limited", "今日はここまでです", undefined, 40_000, { fromApi: true }))).toBe(
      "バックアップの読み込みは1日3回までです。あすの0時（日本時間）を過ぎると、また読み込めます。",
    );
    // The edge throttle is not the daily quota.
    expect(importErrorMessage(new ApiClientError(429, "rate_limited", THROTTLED_MESSAGE))).toBe(`読み込めませんでした。${THROTTLED_MESSAGE}`);
    expect(importErrorMessage(new ApiClientError(413, "payload_too_large"))).toBe("読み込めませんでした。データが大きすぎます。");
  });

  it("R14: says when notes that were too long were left out (their stamps and the challenge were kept)", async () => {
    expect(importResultMessage({ imported: 3, skipped: 0 })).toBe("3件を読み込みました");
    expect(importResultMessage({ imported: 3, skipped: 1 })).toBe("3件を読み込みました（1件はそのままにしました）");
    expect(importResultMessage({ imported: 1, skipped: 0, notesDropped: 2 })).toBe("1件を読み込みました（長すぎるひとこと2件は読み込みませんでした）");
    expect(importResultMessage({ imported: 1, skipped: 1, notesDropped: 1 })).toBe(
      "1件を読み込みました（1件はそのままにしました。長すぎるひとこと1件は読み込みませんでした）",
    );
    fetchMock.mockImplementation(async (input) => (String(input) === API.meImport ? json(200, { imported: 1, skipped: 0, notesDropped: 1 }) : json(404, {})));
    const { store, actions } = fakeStore();
    renderSettings(store);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("バックアップファイル"), { target: { files: [file(JSON.stringify({ ...BACKUP, challenges: [CHALLENGE] }))] } });
    });
    fireEvent.click(await screen.findByRole("button", { name: "読み込む" }));
    expect(await screen.findByText("1件を読み込みました（長すぎるひとこと1件は読み込みませんでした）")).toBeTruthy();
    await waitFor(() => expect(actions.refresh).toHaveBeenCalled());
  });

  it("shows the error and does not upload a bad file", async () => {
    const { store } = fakeStore();
    renderSettings(store);
    const input = screen.getByLabelText("バックアップファイル") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [file(JSON.stringify({ hello: "world" }))] } });
    });
    expect(await screen.findByText("「30日だけ」のバックアップファイルではないようです。")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([u]) => String(u) === API.meImport)).toBe(false);
  });
});

describe("SettingsPage — delete everything", () => {
  it("requires typing 削除, then deletes on the server, clears photos and resets the device", async () => {
    const { store, actions } = fakeStore();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === API.me && init?.method === "DELETE") return new Response(null, { status: 204 });
      return json(404, { error: { code: "not_found", message: "no route" } });
    });
    renderSettings(store);

    fireEvent.click(screen.getByRole("button", { name: "すべてのデータを削除" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "削除する" }));
    expect(await within(dialog).findByText("「削除」と入力すると削除できます")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(actions.resetLocal).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText(/確認のため/), { target: { value: "削除" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "削除する" }));

    await screen.findByText("HOME");
    const del = fetchMock.mock.calls.find(([u, i]) => String(u) === API.me && i?.method === "DELETE");
    expect(del).toBeTruthy();
    expect((del![1]!.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(photos.clearAllPhotos).toHaveBeenCalledTimes(1);
    expect(actions.resetLocal).toHaveBeenCalledTimes(1);
  });

  it("keeps everything when the server cannot be reached", async () => {
    const { store, actions } = fakeStore();
    fetchMock.mockRejectedValue(new TypeError("offline"));
    renderSettings(store);
    fireEvent.click(screen.getByRole("button", { name: "すべてのデータを削除" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText(/確認のため/), { target: { value: "削除" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "削除する" }));
    expect(await within(dialog).findByText(/削除できませんでした/)).toBeTruthy();
    expect(actions.resetLocal).not.toHaveBeenCalled();
    expect(photos.clearAllPhotos).not.toHaveBeenCalled();
  });
});

describe("SettingsPage — without an account", () => {
  it("shows only what makes sense and says when the account is created", () => {
    localStorage.removeItem(KEYS.token);
    const { store } = fakeStore({ user: null, hasSession: false });
    renderSettings(store);
    expect(screen.getByText("まだアカウントはありません")).toBeTruthy();
    expect(screen.getByText(/最初のチャレンジを始めると、匿名のアカウントが自動でできます/)).toBeTruthy();
    expect(screen.queryByLabelText("ニックネーム")).toBeNull();
    expect(screen.queryByRole("button", { name: "すべてのデータを削除" })).toBeNull();
    expect(screen.getByLabelText("引き継ぎコード（8文字）")).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "テーマ" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "プライバシーポリシー" }).getAttribute("href")).toBe("/privacy");
  });
});
