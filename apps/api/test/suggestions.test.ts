import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CATEGORY_KEYS,
  OFFICIAL_RECIPES,
  PLACE_KEYS,
  SuggestionSchema,
  graphemeLength,
  type ApiError,
  type Category,
  type Place,
  type SuggestResponse,
  type Suggestion,
} from "@thirty/shared";
import { statsKey } from "../src/db/keys";
import type { SuggestInput } from "../src/ports";
import { SUGGESTION_IDEAS, type SuggestionIdea } from "../src/providers/suggestion-ideas";
import {
  RuleBasedSuggestionProvider,
  UnavailableSuggestionProvider,
  createSuggestionProvider,
  hintBigrams,
  scoreIdea,
} from "../src/providers/suggestions";
import { json, setupApi } from "./helpers";

/** Deterministic RNG (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const byTitle = new Map(SUGGESTION_IDEAS.map((i) => [i.title, i]));
const ideaOf = (s: Suggestion): SuggestionIdea => {
  const idea = byTitle.get(s.title);
  if (!idea) throw new Error(`not a built-in idea: ${s.title}`);
  return idea;
};

const fitsCategory = (i: SuggestionIdea, q: SuggestInput) => !q.category || i.category === q.category;
const fitsPlace = (i: SuggestionIdea, q: SuggestInput) => !q.place || q.place === "any" || i.place === "any" || i.place === q.place;
const fitsMinutes = (i: SuggestionIdea, q: SuggestInput) => q.maxMinutes === undefined || i.minutes <= q.maxMinutes;
const fitsAll = (i: SuggestionIdea, q: SuggestInput) => fitsCategory(i, q) && fitsPlace(i, q) && fitsMinutes(i, q);

function idea(overrides: Partial<SuggestionIdea>): SuggestionIdea {
  return {
    seal: "試",
    title: "テスト",
    category: "body",
    minutes: 10,
    place: "home",
    difficulty: 1,
    summary: "テスト用の案。",
    how: ["ひとつめ", "ふたつめ"],
    after: "何かが見えてくるかもしれません。",
    tags: [],
    ...overrides,
  };
}

describe("built-in ideas (suggestion-ideas.ts)", () => {
  it("has about 60 ideas, each valid against SuggestionSchema without normalisation", () => {
    expect(SUGGESTION_IDEAS.length).toBeGreaterThanOrEqual(55);
    expect(SUGGESTION_IDEAS.length).toBeLessThanOrEqual(70);
    for (const i of SUGGESTION_IDEAS) {
      const { tags: _tags, ...rest } = i;
      const parsed = SuggestionSchema.safeParse({ ...rest, how: [...i.how] });
      expect(parsed.success, `${i.title}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      // Already clean: the schema's normalisation changes nothing.
      expect(parsed.data).toEqual({ ...rest, how: [...i.how] });
    }
  });

  it("spreads over every category and place, 0–60 minutes and difficulty 1–3", () => {
    for (const c of CATEGORY_KEYS) expect(SUGGESTION_IDEAS.filter((i) => i.category === c).length, c).toBeGreaterThanOrEqual(10);
    for (const p of PLACE_KEYS) expect(SUGGESTION_IDEAS.filter((i) => i.place === p).length, p).toBeGreaterThanOrEqual(5);
    for (const i of SUGGESTION_IDEAS) {
      expect(i.minutes).toBeGreaterThanOrEqual(0);
      expect(i.minutes).toBeLessThanOrEqual(60);
    }
    expect(new Set(SUGGESTION_IDEAS.map((i) => i.difficulty))).toEqual(new Set([1, 2, 3]));
    expect(SUGGESTION_IDEAS.some((i) => i.minutes === 0)).toBe(true);
    expect(SUGGESTION_IDEAS.some((i) => i.minutes >= 45)).toBe(true);
  });

  it("is different from the official recipes, with unique titles and one-kanji seals", () => {
    const officialTitles = new Set(OFFICIAL_RECIPES.map((r) => r.title));
    const officialSeals = new Set(OFFICIAL_RECIPES.map((r) => r.seal));
    expect(new Set(SUGGESTION_IDEAS.map((i) => i.title)).size).toBe(SUGGESTION_IDEAS.length);
    expect(new Set(SUGGESTION_IDEAS.map((i) => i.seal)).size).toBe(SUGGESTION_IDEAS.length);
    for (const i of SUGGESTION_IDEAS) {
      expect(officialTitles.has(i.title), i.title).toBe(false);
      expect(officialSeals.has(i.seal), i.seal).toBe(false);
      expect(i.seal).toMatch(/^\p{Script=Han}$/u);
    }
  });

  it("has 2–3 tips, Japanese tags, and phrases the 30-day outcome as a possibility", () => {
    for (const i of SUGGESTION_IDEAS) {
      expect(i.how.length, i.title).toBeGreaterThanOrEqual(2);
      expect(i.how.length, i.title).toBeLessThanOrEqual(3);
      for (const h of i.how) expect(graphemeLength(h)).toBeLessThanOrEqual(60);
      expect(i.tags.length, i.title).toBeGreaterThanOrEqual(2);
      for (const t of i.tags) expect(t).toMatch(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|^[A-Z]+$/u);
      expect(i.after, i.title).toMatch(/かもしれません|見えてき/);
    }
  });
});

describe("hint scoring", () => {
  it("builds 2-character pieces from kanji, katakana and latin only", () => {
    expect([...hintBigrams("ひらがなだけです")]).toEqual([]);
    const bg = hintBigrams("毎日カメラで空を撮る、30分");
    expect(bg.has("カメ")).toBe(true);
    expect(bg.has("メラ")).toBe(true);
    expect(bg.has("毎日")).toBe(false); // stop word
    expect(bg.has("30")).toBe(false); // digits say nothing
    expect([...hintBigrams("ＳＮＳ")]).toEqual(["sn", "ns"]); // NFKC + lower case
  });

  it("gives +3 per tag contained in the hint and a small, capped bonus for shared pieces", () => {
    const knit = byTitle.get("毎日10段、編み物をする")!;
    expect(scoreIdea(knit, undefined)).toBe(0);
    expect(scoreIdea(knit, "")).toBe(0);
    expect(scoreIdea(knit, "編み物と手芸")).toBeGreaterThanOrEqual(6);
    const noTags = idea({ title: "カメラで空を撮る", summary: "空の写真。", tags: [] });
    expect(scoreIdea(noTags, "カメラ")).toBe(1); // "カメ" + "メラ"
    expect(scoreIdea(noTags, "カメラでもっと空の写真を撮影したい")).toBeLessThanOrEqual(2);
    expect(scoreIdea(idea({ tags: ["SNS"] }), "ＳＮＳを減らしたい")).toBe(3);
  });
});

describe("RuleBasedSuggestionProvider", () => {
  const minutesOptions = [0, 5, 15, 30, 60, undefined];
  const placeOptions: (Place | undefined)[] = [undefined, ...PLACE_KEYS];
  const categoryOptions: (Category | undefined)[] = [undefined, ...CATEGORY_KEYS];

  it("returns 3 distinct, schema-valid suggestions for every filter combination, strict matches first", async () => {
    const provider = createSuggestionProvider({ random: seeded(7) });
    for (const category of categoryOptions) {
      for (const place of placeOptions) {
        for (const maxMinutes of minutesOptions) {
          const q: SuggestInput = { category, place, maxMinutes };
          const out = await provider.suggest(q);
          const label = JSON.stringify(q);
          expect(out, label).toHaveLength(3);
          expect(new Set(out.map((s) => s.title)).size, label).toBe(3);
          for (const s of out) expect(SuggestionSchema.safeParse(s).success, label).toBe(true);
          const strict = SUGGESTION_IDEAS.filter((i) => fitsAll(i, q)).length;
          const fits = out.map((s) => fitsAll(ideaOf(s), q));
          // The strictly matching ideas come first; relaxed ones only fill the rest.
          expect(fits, label).toEqual([0, 1, 2].map((n) => n < strict));
          // 12 ideas per category: the category filter is never relaxed with the built-in data.
          if (category) for (const s of out) expect(s.category, label).toBe(category);
        }
      }
    }
  });

  it("treats place 'any' on an idea as matching every place, and the 'any' filter as no filter", async () => {
    const seen = { home: new Set<Place>(), out: new Set<Place>(), any: new Set<Place>() };
    for (let seed = 1; seed <= 40; seed++) {
      const provider = createSuggestionProvider({ random: seeded(seed) });
      for (const place of ["home", "out", "any"] as const) {
        for (const s of await provider.suggest({ place, category: "body" })) seen[place].add(s.place);
      }
    }
    expect(seen.home).toEqual(new Set(["home", "any"]));
    expect(seen.out).toEqual(new Set(["out", "any"]));
    expect(seen.any).toEqual(new Set(["home", "out", "any"]));
  });

  it("honours maxMinutes (undefined = no limit)", async () => {
    const provider = createSuggestionProvider({ random: seeded(3) });
    for (let n = 0; n < 20; n++) {
      for (const s of await provider.suggest({ maxMinutes: 5 })) expect(s.minutes).toBeLessThanOrEqual(5);
      for (const s of await provider.suggest({ maxMinutes: 0, category: "quit" })) expect(s.minutes).toBe(0);
    }
    const long = new Set<number>();
    for (let seed = 0; seed < 200; seed++) {
      for (const s of await createSuggestionProvider({ random: seeded(seed) }).suggest({ category: "body", place: "out" })) long.add(s.minutes);
    }
    expect(Math.max(...long)).toBe(45);
  });

  it("relaxes minutes, then place, then category — strict matches first, silently", async () => {
    const ideas = [
      idea({ title: "からだ・家・10分", category: "body", place: "home", minutes: 10 }),
      idea({ title: "からだ・外・30分", category: "body", place: "out", minutes: 30 }),
      idea({ title: "あたま・家・5分", category: "mind", place: "home", minutes: 5 }),
      idea({ title: "手しごと・外・5分", category: "hands", place: "out", minutes: 5 }),
    ];
    const provider = new RuleBasedSuggestionProvider({ ideas, random: seeded(1) });
    const out = await provider.suggest({ category: "body", place: "home", maxMinutes: 5 });
    expect(out.map((s) => s.title).slice(0, 2)).toEqual(["からだ・家・10分", "からだ・外・30分"]);
    expect(["あたま・家・5分", "手しごと・外・5分"]).toContain(out[2]!.title);
    // Nothing in the result says the filters were relaxed: just 3 plain suggestions.
    expect(Object.keys(out[0]!).sort()).toEqual(["after", "category", "difficulty", "how", "minutes", "place", "seal", "summary", "title"]);
  });

  it("ranks by the hint: tags first, then shared pieces of the title or summary", async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const provider = createSuggestionProvider({ random: seeded(seed) });
      expect((await provider.suggest({ hint: "編み物をはじめてみたい" }))[0]!.title).toBe("毎日10段、編み物をする");
      const cooking = (await provider.suggest({ hint: "料理をしたい" })).map((s) => s.title);
      expect(new Set(cooking.slice(0, 2))).toEqual(new Set(["毎食、野菜をひと皿", "お弁当を詰める"]));
      // The hint ranks inside the filters, it does not override them.
      for (const s of await provider.suggest({ hint: "編み物", category: "quit" })) expect(s.category).toBe("quit");
    }
    const ideas = [
      idea({ title: "空を眺める", summary: "空を見る。", category: "mind" }),
      idea({ title: "カメラで景色を撮る", summary: "景色の写真。", category: "hands" }),
      idea({ title: "本を読む", summary: "本を読む。", category: "people" }),
      idea({ title: "歩く", summary: "歩く。", category: "quit" }),
    ];
    for (let seed = 1; seed <= 10; seed++) {
      const out = await new RuleBasedSuggestionProvider({ ideas, random: seeded(seed) }).suggest({ hint: "カメラが好き" });
      expect(out[0]!.title).toBe("カメラで景色を撮る");
    }
  });

  it("never returns duplicates, even when the pool is smaller than 3", async () => {
    const ideas = [idea({ title: "ひとつめ" }), idea({ title: "ふたつめ", category: "mind" })];
    const out = await new RuleBasedSuggestionProvider({ ideas, random: seeded(1) }).suggest({ category: "quit" });
    expect(out.map((s) => s.title).sort()).toEqual(["ひとつめ", "ふたつめ"]);
    for (let seed = 0; seed < 50; seed++) {
      const titles = (await createSuggestionProvider({ random: seeded(seed) }).suggest({ hint: "スマホ" })).map((s) => s.title);
      expect(new Set(titles).size).toBe(titles.length);
    }
  });

  it("varies the categories when no category is chosen, and breaks ties with the injected RNG", async () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 30; seed++) {
      const out = await createSuggestionProvider({ random: seeded(seed) }).suggest({});
      expect(new Set(out.map((s) => s.category)).size).toBe(3);
      for (const s of out) seen.add(s.title);
    }
    expect(seen.size).toBeGreaterThan(20);
    const a = await createSuggestionProvider({ random: seeded(99) }).suggest({ place: "home" });
    const b = await createSuggestionProvider({ random: seeded(99) }).suggest({ place: "home" });
    expect(a).toEqual(b);
  });

  it("skips a built-in idea that fails SuggestionSchema and fills the gap", async () => {
    const ideas = [
      idea({ title: "あ".repeat(31) }), // too long
      idea({ title: "URLあり", summary: "example.com を見る" }), // URL in public text
      idea({ title: "ひとつめ" }),
      idea({ title: "ふたつめ" }),
      idea({ title: "みっつめ" }),
    ];
    const out = await new RuleBasedSuggestionProvider({ ideas, random: seeded(1) }).suggest({});
    expect(out.map((s) => s.title).sort()).toEqual(["ひとつめ", "ふたつめ", "みっつめ"]);
  });
});

// ---------- POST /api/suggestions ----------

const api = setupApi();

beforeAll(() => {
  // The shared harness uses the unavailable provider; this file tests the real one.
  api.deps.suggestions = createSuggestionProvider({ random: seeded(42) });
});

const suggest = (token: string | undefined, body: unknown) => api.request("/api/suggestions", { token, body });

async function statsItem(): Promise<Record<string, unknown>> {
  const res = await api.deps.db.send(new GetCommand({ TableName: api.deps.tableName, Key: statsKey() }));
  return res.Item ?? {};
}

describe("POST /api/suggestions", () => {
  it("needs a session", async () => {
    const res = await suggest(undefined, {});
    expect(res.status).toBe(401);
  });

  it("returns 3 schema-valid suggestions and today's remaining count", async () => {
    api.clock.set("2026-10-06T03:00:00.000Z");
    const s = await api.createSession();
    const res = await suggest(s.token, { maxMinutes: 15, category: "mind", place: "home", hint: "地図を眺めるのが好き" });
    expect(res.status).toBe(200);
    const body = await json<SuggestResponse>(res);
    expect(body.remainingToday).toBe(9);
    expect(body.suggestions).toHaveLength(3);
    expect(body.suggestions[0]!.title).toBe("地図で知らない町を歩く");
    for (const sg of body.suggestions) {
      expect(SuggestionSchema.safeParse(sg).success).toBe(true);
      expect(sg.category).toBe("mind");
      expect(sg.minutes).toBeLessThanOrEqual(15);
      expect(["home", "any"]).toContain(sg.place);
    }
  });

  it("validates the request with the shared schema (invalid requests are not counted)", async () => {
    const s = await api.createSession();
    const bad = [
      { category: "sleep" },
      { place: "moon" },
      { maxMinutes: 181 },
      { maxMinutes: -1 },
      { hint: "あ".repeat(101) },
      { hint: "example.com を見て" },
    ];
    for (const body of bad) {
      const res = await suggest(s.token, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await json<ApiError>(res)).error.code).toBe("bad_request");
    }
    expect((await api.request("/api/suggestions", { token: s.token, raw: "{", contentType: "application/json" })).status).toBe(400);
    expect((await api.request("/api/suggestions", { token: s.token, raw: "{}", contentType: "text/plain" })).status).toBe(415);
    const ok = await json<SuggestResponse>(await suggest(s.token, {}));
    expect(ok.remainingToday).toBe(9);
  });

  it("allows 10 per user per JST day, then 429 until the next JST day", async () => {
    api.clock.set("2026-10-07T03:00:00.000Z");
    const s = await api.createSession();
    const other = await api.createSession();
    const remaining: number[] = [];
    for (let i = 0; i < 10; i++) remaining.push((await json<SuggestResponse>(await suggest(s.token, {}))).remainingToday);
    expect(remaining).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    const limited = await suggest(s.token, {});
    expect(limited.status).toBe(429);
    expect((await json<ApiError>(limited)).error.code).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Per user.
    expect((await suggest(other.token, {})).status).toBe(200);
    // 2026-10-07T15:00Z is midnight JST: a new day.
    api.clock.set("2026-10-07T15:00:00.000Z");
    expect((await json<SuggestResponse>(await suggest(s.token, {}))).remainingToday).toBe(9);
  });

  it("counts uses per JST day in STATS for the admin page", async () => {
    api.clock.set("2026-10-09T14:59:00.000Z"); // 23:59 JST on 10/9
    const s = await api.createSession();
    const before = Number((await statsItem()).suggestions_20261009 ?? 0);
    await suggest(s.token, {});
    await suggest(s.token, { category: "hands" });
    api.clock.set("2026-10-09T15:00:00.000Z"); // 00:00 JST on 10/10
    await suggest(s.token, {});
    const item = await statsItem();
    expect(Number(item.suggestions_20261009)).toBe(before + 2);
    expect(Number(item.suggestions_20261010)).toBe(1);
  });

  it("never stores the hint", async () => {
    const s = await api.createSession();
    const hint = "ぽんぽこ合言葉ズィルバー編み物";
    const res = await suggest(s.token, { hint });
    expect(res.status).toBe(200);
    const dump = JSON.stringify(await api.scanAll());
    expect(dump).not.toContain("ぽんぽこ");
    expect(dump).not.toContain("ズィルバー");
  });

  it("answers 503 ai_unavailable when the provider fails", async () => {
    const s = await api.createSession();
    const real = api.deps.suggestions;
    api.deps.suggestions = new UnavailableSuggestionProvider();
    try {
      const res = await suggest(s.token, {});
      expect(res.status).toBe(503);
      expect((await json<ApiError>(res)).error.code).toBe("ai_unavailable");
    } finally {
      api.deps.suggestions = real;
    }
  });
});
