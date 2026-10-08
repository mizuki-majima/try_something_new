// lib/fonts.ts: the handwriting font (Klee One 600) is the only web font. Save-Data and
// prefers-reduced-data skip it; the share card forces it (it draws Klee One on a canvas).
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loaded = { count: 0 };

function setSaveData(saveData: boolean | undefined): void {
  Object.defineProperty(navigator, "connection", { value: saveData === undefined ? undefined : { saveData }, configurable: true });
}

/** A fresh lib/fonts (its "already loading" promise is module state) whose stylesheet import is counted. */
async function freshFonts() {
  vi.resetModules();
  vi.doMock("../src/styles/fonts", () => {
    loaded.count += 1;
    return {};
  });
  return import("../src/lib/fonts");
}

beforeEach(() => {
  loaded.count = 0;
});

afterEach(() => {
  setSaveData(undefined);
  vi.unstubAllGlobals();
  vi.doUnmock("../src/styles/fonts");
});

describe("loadFonts", () => {
  it("loads the handwriting stylesheet once", async () => {
    const { loadFonts } = await freshFonts();
    await loadFonts();
    await loadFonts();
    expect(loaded.count).toBe(1);
  });

  it("loads nothing when Save-Data is on", async () => {
    setSaveData(true);
    const { loadFonts, prefersReducedData } = await freshFonts();
    expect(prefersReducedData()).toBe(true);
    await loadFonts();
    expect(loaded.count).toBe(0);
  });

  it("loads nothing when the OS asks for reduced data", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(prefers-reduced-data: reduce)" }));
    const { loadFonts } = await freshFonts();
    await loadFonts();
    expect(loaded.count).toBe(0);
  });

  it("loads anyway when forced (the share card draws the handwriting on a canvas)", async () => {
    setSaveData(true);
    const { loadFonts } = await freshFonts();
    await loadFonts();
    expect(loaded.count).toBe(0);
    await loadFonts({ force: true });
    expect(loaded.count).toBe(1);
  });

  it("keeps the canvas stacks in step with tokens.css", async () => {
    const { FONT_STACKS } = await freshFonts();
    const tokens = readFileSync(path.resolve(__dirname, "../src/styles/tokens.css"), "utf8");
    expect(tokens).toContain(`--font-hand: ${FONT_STACKS.hand};`);
    expect(tokens).toContain(`--font-body: ${FONT_STACKS.body};`);
  });
});
