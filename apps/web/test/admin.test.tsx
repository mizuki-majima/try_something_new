import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { API, type AdminReportItem, type AdminStats } from "@thirty/shared";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ToastHost, ToastProvider } from "../src/components/Toast";
import { adminRequest, getAdminToken, setAdminToken } from "../src/lib/admin";
import { KEYS, writeString } from "../src/lib/storage";
import AdminPage, { actionMessage, pilotRows } from "../src/pages/AdminPage";

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
  pilot: { starters: 9, eligible7: 8, retained7: 5, started: 10, reflected: 5 },
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
    expect(screen.getAllByText("50%").length).toBeGreaterThan(0); // 完走 5/10
    expect(screen.getByText("40%以上")).toBeTruthy();
    // The three pilot rows from s.pilot, without "proxy" caveats.
    const table = screen.getByRole("table");
    expect(within(table).getByText("開始した人")).toBeTruthy();
    expect(within(table).getByText("9人")).toBeTruthy();
    expect(within(table).getByText("62.5%")).toBeTruthy(); // 7日継続 5/8
    expect(within(table).getByText("60%以上")).toBeTruthy();
    expect(table.textContent).not.toMatch(/代用|出せません|チャレンジ数）/);
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
  const row = (s: AdminStats, label: string) => pilotRows(s).find((r) => r.label === label);
  const withPilot = (pilot: Partial<AdminStats["pilot"]>): AdminStats => ({ ...STATS, pilot: { ...STATS.pilot, ...pilot } });

  it("shows 開始した人, 7日継続 and 完走 from the pilot metrics against the fixed targets", () => {
    expect(pilotRows(STATS).map((r) => r.label)).toEqual(["開始した人", "7日継続", "完走", "共有"]);
    expect(row(STATS, "開始した人")).toMatchObject({ value: "9人", target: "8人以上", judge: "pass" });
    expect(row(STATS, "7日継続")).toMatchObject({ value: "62.5%", target: "60%以上", judge: "pass", note: "1〜7日目に印5個以上 5 ÷ 7日目を過ぎた 8" });
    expect(row(STATS, "完走")).toMatchObject({ value: "50%", target: "40%以上", judge: "pass", note: "振り返り 5 ÷ 開始 10" });
    expect(row(STATS, "共有")).toMatchObject({ value: "40%", target: "30%以上", judge: "pass" });
    // users / challengesStarted (account and lifetime counters) no longer stand in for the pilot numbers.
    expect(row({ ...STATS, users: 100, challengesStarted: 100 }, "開始した人")?.value).toBe("9人");
    for (const r of pilotRows(STATS)) expect(r.note ?? "").not.toMatch(/代用|出せません|チャレンジ数）/);
  });

  it("judges exactly at the targets and below them", () => {
    expect(row(withPilot({ starters: 8 }), "開始した人")?.judge).toBe("pass");
    expect(row(withPilot({ starters: 7 }), "開始した人")?.judge).toBe("fail");
    expect(row(withPilot({ retained7: 3, eligible7: 5 }), "7日継続")).toMatchObject({ value: "60%", judge: "pass" });
    expect(row(withPilot({ retained7: 5, eligible7: 9 }), "7日継続")).toMatchObject({ value: "55.6%", judge: "fail" });
    expect(row(withPilot({ reflected: 2, started: 5 }), "完走")).toMatchObject({ value: "40%", judge: "pass" });
    expect(row(withPilot({ reflected: 3, started: 8 }), "完走")).toMatchObject({ value: "37.5%", judge: "fail" });
    expect(row({ ...STATS, shares: 3, challengesDone: 10 }, "共有")).toMatchObject({ value: "30%", judge: "pass" });
  });

  it("does not break when an older API answers without pilot metrics", () => {
    const { pilot: _pilot, ...old } = STATS;
    expect(row(old as AdminStats, "完走")).toMatchObject({ value: "—", judge: "na" });
  });

  it("has no judgement without a denominator", () => {
    const empty = withPilot({ starters: 0, eligible7: 0, retained7: 0, started: 0, reflected: 0 });
    expect(row(empty, "開始した人")).toMatchObject({ value: "0人", judge: "fail" });
    expect(row(empty, "7日継続")).toMatchObject({ value: "—", judge: "na" });
    expect(row(empty, "完走")).toMatchObject({ value: "—", judge: "na" });
    expect(row({ ...STATS, shares: 0, challengesDone: 0 }, "共有")).toMatchObject({ value: "—", judge: "na" });
  });
});

describe("member delete wording", () => {
  it("says the owner's record stays", () => {
    expect(actionMessage("member", "delete")).toContain("本人の記録（印・メモ）は消えません");
    expect(actionMessage("recipe", "delete")).toBe("完全に削除します。元に戻せません。");
    expect(actionMessage("member", "hide")).not.toContain("本人の記録");
  });
});
