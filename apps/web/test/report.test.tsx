import { fireEvent, render, screen, within } from "@testing-library/react";
import { AUTO_HIDE_REPORTS, REPORTER_MIN_ACCOUNT_AGE_HOURS } from "@thirty/shared";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ReportButton } from "../src/components/ReportButton";
import { ToastHost, ToastProvider } from "../src/components/Toast";
import { THROTTLED_MESSAGE } from "../src/lib/api";
import { clearSession } from "../src/lib/session";
import { KEYS, writeString } from "../src/lib/storage";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

let fetchMock: Mock<typeof fetch>;

beforeEach(() => {
  writeString(KEYS.token, "tok");
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderButton() {
  return render(
    <ToastProvider>
      <ReportButton targetType="story" targetId="photo:s0000000000001" subject="みずさんの体験談" />
      <ToastHost />
    </ToastProvider>,
  );
}

function openSheet() {
  fireEvent.click(screen.getByRole("button", { name: "通報（みずさんの体験談）" }));
  return screen.getByRole("dialog", { name: "通報する" });
}

describe("ReportButton", () => {
  it("posts targetType / targetId / reason and thanks the reporter", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    renderButton();
    const dialog = openSheet();
    fireEvent.change(within(dialog).getByLabelText("理由（任意）"), { target: { value: "  人を傷つける内容です  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "送信" }));

    expect(await screen.findByText("通報しました。ありがとうございます")).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/reports");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ targetType: "story", targetId: "photo:s0000000000001", reason: "人を傷つける内容です" });
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("通報済み")).toBeTruthy();
  });

  it("leaves the reason out when it is empty", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    renderButton();
    fireEvent.click(within(openSheet()).getByRole("button", { name: "送信" }));
    await screen.findByText("通報しました。ありがとうございます");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ targetType: "story", targetId: "photo:s0000000000001" });
  });

  it("checks the reason length before sending", async () => {
    renderButton();
    const dialog = openSheet();
    fireEvent.change(within(dialog).getByLabelText("理由（任意）"), { target: { value: "あ".repeat(201) } });
    fireEvent.click(within(dialog).getByRole("button", { name: "送信" }));
    expect(await within(dialog).findByText("理由は200文字以内で入力してください")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the API's message for your own content (400) and the daily limit (429) in the sheet", async () => {
    fetchMock
      .mockResolvedValueOnce(json(400, { error: { code: "bad_request", message: "自分の投稿や記録は通報できません" } }))
      .mockResolvedValueOnce(json(429, { error: { code: "rate_limited", message: "今日はここまで" } }));
    renderButton();
    const dialog = openSheet();
    fireEvent.click(within(dialog).getByRole("button", { name: "送信" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("自分の投稿や記録は通報できません");

    fireEvent.click(within(dialog).getByRole("button", { name: "送信" }));
    expect(await within(dialog).findByText("今日の通報はここまでです。明日また送れます。")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "通報する" })).toBeTruthy();
  });

  it("R7: a refused account creation (new accounts are limited) is not shown as the daily report limit", async () => {
    clearSession();
    fetchMock.mockResolvedValue(
      json(429, { error: { code: "rate_limited", message: "新しく始める人が集中しています。しばらくしてからもう一度お試しください" } }, { "Retry-After": "900" }),
    );
    renderButton();
    const dialog = openSheet();
    fireEvent.click(within(dialog).getByRole("button", { name: "送信" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("新しく始める人が集中しています。しばらくしてからもう一度お試しください");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(["/api/session"]);
  });

  it("the edge throttle (429 without the API's body) says it is busy, not 今日はここまで", async () => {
    fetchMock.mockResolvedValue(json(429, { message: "Too Many Requests" }));
    renderButton();
    const dialog = openSheet();
    fireEvent.click(within(dialog).getByRole("button", { name: "送信" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(THROTTLED_MESSAGE);
  });

  it("r2-web-2: says every report is checked and auto-hide only happens under conditions", () => {
    renderButton();
    const note = within(openSheet()).getByText(/みずさんの体験談を運営者に知らせます/).textContent ?? "";
    expect(note).toContain("通報はすべて運営者が確認し、必要なら非表示にします。");
    expect(note).toContain(`一定の条件（利用を始めて${REPORTER_MIN_ACCOUNT_AGE_HOURS}時間以上たっていることなど）を満たす${AUTO_HIDE_REPORTS}人から通報があると、確認の前に自動で非表示になることもあります。`);
    expect(note).not.toContain("人から通報があると、自動で非表示になります");
  });
});
