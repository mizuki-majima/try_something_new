import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { API, type AdminReportItem, type AdminStats } from "@thirty/shared";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ToastHost, ToastProvider } from "../src/components/Toast";
import { adminRequest, getAdminToken, setAdminToken } from "../src/lib/admin";
import { KEYS, writeString } from "../src/lib/storage";
import AdminPage, { pilotRows } from "../src/pages/AdminPage";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const STATS: AdminStats = {
  users: 9,
  challengesStarted: 10,
  challengesDone: 5,
  verdicts: { continue: 3, stop: 1, modify: 1 },
  communityRecipes: 2,
  stories: 4,
  shares: 2,
  shareActions: { link: 2, image: 1, webshare: 0, x: 1, line: 0, copy: 0 },
  suggestionsToday: 6,
  pushSubscriptions: 3,
};

const REPORT: AdminReportItem = {
  targetType: "recipe",
  targetId: "r0000000000001",
  count: 3,
  reasons: ["宣伝です"],
  lastAt: Date.UTC(2026, 9, 6, 12, 0),
  status: "hidden",
  preview: "毎日バナナを食べる",
};

let fetchMock: Mock<typeof fetch>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.head.querySelectorAll('meta[name="robots"]').forEach((m) => m.remove());
});

function renderAdmin() {
  return render(
    <MemoryRouter initialEntries={["/admin"]}>
      <ToastProvider>
        <AdminPage />
        <ToastHost />
      </ToastProvider>
    </MemoryRouter>,
  );
}

function headersOf(call: Parameters<typeof fetch>): Record<string, string> {
  return (call[1]?.headers ?? {}) as Record<string, string>;
}

describe("adminRequest", () => {
  it("sends X-Admin-Token and never the user's bearer token", async () => {
    writeString(KEYS.token, "user-token");
    fetchMock.mockResolvedValue(json(200, STATS));
    await adminRequest("GET", API.adminStats, { token: "secret" });
    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe(API.adminStats);
    expect(headersOf(call)["X-Admin-Token"]).toBe("secret");
    expect(headersOf(call).Authorization).toBeUndefined();
  });

  it("sends JSON bodies for moderation", async () => {
    setAdminToken("secret");
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await adminRequest("POST", API.adminModerate, { body: { targetType: "recipe", targetId: "r1", action: "hide" } });
    const call = fetchMock.mock.calls[0]!;
    expect(headersOf(call)["Content-Type"]).toBe("application/json");
    expect(headersOf(call)["X-Admin-Token"]).toBe("secret");
  });
});

describe("AdminPage", () => {
  it("is noindex", () => {
    renderAdmin();
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute("content")).toContain("noindex");
  });

  it("shows 「トークンが違います」 on 403 and forgets the token", async () => {
    fetchMock.mockResolvedValue(json(403, { error: { code: "forbidden", message: "管理トークンが正しくありません" } }));
    renderAdmin();
    fireEvent.change(screen.getByLabelText("管理トークン"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "開く" }));
    expect(await screen.findByText("トークンが違います")).toBeTruthy();
    expect(headersOf(fetchMock.mock.calls[0]!)["X-Admin-Token"]).toBe("wrong");
    expect(getAdminToken()).toBeNull();
    expect(sessionStorage.getItem("thirty-days.admin-token")).toBeNull();
  });

  it("keeps the token in sessionStorage only and shows the stats with pilot targets", async () => {
    fetchMock.mockResolvedValue(json(200, STATS));
    renderAdmin();
    fireEvent.change(screen.getByLabelText("管理トークン"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "開く" }));
    expect(await screen.findByText("PILOT の合格ライン")).toBeTruthy();
    expect(sessionStorage.getItem("thirty-days.admin-token")).toBe("secret");
    expect(localStorage.getItem("thirty-days.admin-token")).toBeNull();
    expect(screen.getAllByText("50%").length).toBeGreaterThan(0); // 完走率 5/10
    expect(screen.getByText("40%以上")).toBeTruthy();
  });

  it("lists reports and restores one after confirming", async () => {
    setAdminToken("secret");
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === API.adminStats) return json(200, STATS);
      if (url === API.adminReports) return json(200, { items: [REPORT] });
      if (url === API.adminModerate && init?.method === "POST") return new Response(null, { status: 204 });
      return json(404, { error: { code: "not_found", message: "no route" } });
    });
    renderAdmin();
    fireEvent.click(screen.getByRole("tab", { name: "通報" }));
    expect(await screen.findByText("毎日バナナを食べる")).toBeTruthy();
    expect(screen.getByText("宣伝です")).toBeTruthy();
    expect(screen.getByText("通報 3件")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "復元" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "復元する" }));
    await waitFor(() => expect(screen.getByText("公開中")).toBeTruthy());
    const post = fetchMock.mock.calls.find(([u]) => String(u) === API.adminModerate)!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({ targetType: "recipe", targetId: "r0000000000001", action: "restore" });
    expect(headersOf(post)["X-Admin-Token"]).toBe("secret");
  });

  it("shows an empty state for contacts", async () => {
    setAdminToken("secret");
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === API.adminStats) return json(200, STATS);
      if (url === API.adminContacts) return json(200, { items: [] });
      return json(404, { error: { code: "not_found", message: "no route" } });
    });
    renderAdmin();
    fireEvent.click(screen.getByRole("tab", { name: "お問い合わせ" }));
    expect(await screen.findByText("お問い合わせはまだありません")).toBeTruthy();
  });
});

describe("pilotRows", () => {
  it("judges against the fixed pilot targets", () => {
    const rows = pilotRows(STATS);
    expect(rows.find((r) => r.label === "開始数")?.judge).toBe("pass");
    expect(rows.find((r) => r.label === "完走")).toMatchObject({ value: "50%", judge: "pass" });
    expect(rows.find((r) => r.label === "共有")).toMatchObject({ value: "40%", judge: "pass" });
    expect(rows.find((r) => r.label === "7日継続")?.judge).toBe("na");
    const empty = pilotRows({ ...STATS, users: 0, challengesStarted: 0, challengesDone: 0, shares: 0 });
    expect(empty.find((r) => r.label === "完走")).toMatchObject({ value: "—", judge: "na" });
  });
});
