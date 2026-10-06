import { crc32, deflateSync } from "node:zlib";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { LIMITS, QUOTAS, newId, type ApiError, type Challenge, type SessionResponse, type ShareResponse } from "@thirty/shared";
import { getChallengeItem, toChallengeItem } from "../src/db/challenges";
import { shareKey, statsKey } from "../src/db/keys";
import { getStats } from "../src/db/stats";
import { checkPng, decodeBase64Strict, isShareCardPng } from "../src/png";
import { escapeHtml, excerpt, TED_TALK_URL } from "../src/share-page";
import { json, setupApi } from "./helpers";

const api = setupApi();

// ---------- fixtures ----------

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** A real (all-black, 8-bit grayscale) PNG of the given size. */
function makePng(width = 1200, height = 630): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const raw = Buffer.alloc(height * (width + 1)); // filter byte 0 + zero pixels per row
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

const PNG_B64 = makePng().toString("base64");

function challenge(overrides: Partial<Challenge> = {}): Challenge {
  const now = api.clock.now().getTime();
  return {
    id: newId(16),
    recipeId: "photo",
    title: "毎日1枚、写真を撮る",
    seal: "写",
    startDate: "2026-09-01",
    status: "done",
    stamps: { "1": { at: now, note: "ひみつのメモ" }, "2": { at: now }, "5": { at: now } },
    verdict: "continue",
    reflection: "続けてよかった。\n来月も撮る。",
    finishedAt: now,
    finishedDay: 30,
    cheers: 2,
    shareId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function seedChallenge(s: SessionResponse, c: Challenge): Promise<Challenge> {
  await api.deps.db.send(new PutCommand({ TableName: api.deps.tableName, Item: toChallengeItem(s.user.id, s.user, c) }));
  await api.deps.db.send(new PutCommand({ TableName: api.deps.tableName, Item: { pk: `CHREF#${c.id}`, sk: "REF", userId: s.user.id } }));
  return c;
}

async function share(s: SessionResponse, challengeId: string, headers: Record<string, string> = {}): Promise<ShareResponse> {
  const res = await api.request("/api/shares", { token: s.token, body: { challengeId, imageBase64: PNG_B64 }, headers });
  if (res.status !== 201) throw new Error(`share: ${res.status} ${await res.text()}`);
  return json<ShareResponse>(res);
}

const getItem = async (pk: string, sk: string) =>
  (await api.deps.db.send(new GetCommand({ TableName: api.deps.tableName, Key: { pk, sk } }))).Item;

const errorOf = async (res: Response) => (await json<ApiError>(res)).error;

// ---------- png.ts ----------

describe("png checks", () => {
  it("accepts a 1200x630 PNG and reads its size", () => {
    const png = makePng();
    expect(checkPng(png)).toMatchObject({ ok: true, info: { width: 1200, height: 630 } });
    expect(isShareCardPng(png)).toBe(true);
  });

  it("rejects other sizes, bad signatures, truncated files and trailing data", () => {
    expect(isShareCardPng(makePng(1199, 630))).toBe(false);
    expect(isShareCardPng(makePng(1200, 631))).toBe(false);
    const png = makePng();
    const badSig = Buffer.from(png);
    badSig[1] = 0;
    expect(checkPng(badSig)).toMatchObject({ ok: false, reason: "signature" });
    expect(checkPng(png.subarray(0, png.length - 4)).ok).toBe(false);
    expect(checkPng(Buffer.concat([png, Buffer.from("<script>")]))).toMatchObject({ ok: false, reason: "trailing_data" });
    const badCrc = Buffer.from(png);
    badCrc[29] = badCrc[29]! ^ 0xff;
    expect(checkPng(badCrc)).toMatchObject({ ok: false, reason: "ihdr_crc" });
    // IHDR must come first
    const noIhdr = Buffer.concat([png.subarray(0, 8), chunk("IDAT", deflateSync(Buffer.alloc(10))), chunk("IEND", new Uint8Array(0))]);
    expect(checkPng(noIhdr).ok).toBe(false);
  });

  it("decodes strict base64 only", () => {
    expect(decodeBase64Strict("aGVsbG8=")).toEqual(new Uint8Array(Buffer.from("hello")));
    expect(decodeBase64Strict("data:image/png;base64,aGVsbG8=")).toBeNull();
    expect(decodeBase64Strict("aGVs bG8=")).toBeNull();
    expect(decodeBase64Strict("aGVsbG8")).toBeNull();
    expect(decodeBase64Strict("aGVsbG9=")).toBeNull(); // non-canonical padding bits
    expect(decodeBase64Strict("a-_b")).toBeNull(); // base64url
  });
});

// ---------- share-page helpers ----------

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
    expect(escapeHtml("ふつうの文字")).toBe("ふつうの文字");
    expect(escapeHtml(23)).toBe("23");
    expect(escapeHtml(null)).toBe("");
  });

  it("excerpt cuts on graphemes and flattens newlines", () => {
    expect(excerpt("あいう\nえお", 10)).toBe("あいう えお");
    expect(excerpt("👨‍👩‍👧‍👦".repeat(5), 2)).toBe("👨‍👩‍👧‍👦👨‍👩‍👧‍👦…");
  });
});

// ---------- POST /api/shares ----------

describe("POST /api/shares", () => {
  it("stores the image and the public fields, and links the challenge", async () => {
    const s = await api.createSession("みずき");
    const c = await seedChallenge(s, challenge());
    const sharesBefore = (await getStats(api.deps)).shares;
    const res = await api.request("/api/shares", { token: s.token, body: { challengeId: c.id, imageBase64: PNG_B64 } });
    expect(res.status).toBe(201);
    const body = await json<ShareResponse>(res);
    expect(body.url).toBe(`http://localhost/s/${body.id}`);
    expect(body.imageUrl).toBe(`http://localhost/media/share/${body.id}.png`);

    const media = api.media.objects.get(`share/${body.id}.png`);
    expect(media?.contentType).toBe("image/png");
    expect(Buffer.from(media!.bytes).toString("base64")).toBe(PNG_B64);

    const item = await getItem(`SHARE#${body.id}`, "META");
    expect(item).toMatchObject({
      nickname: "みずき",
      title: c.title,
      seal: "写",
      verdict: "continue",
      days: 3,
      reflection: c.reflection,
      startDate: "2026-09-01",
      recipeId: "photo",
      status: "published",
      gsi2pk: `AUTHOR#${s.user.id}`,
      gsi2sk: `SHARE#${body.id}`,
    });
    expect(JSON.stringify(item)).not.toContain("ひみつのメモ");
    expect((await getChallengeItem(api.deps, s.user.id, c.id))?.shareId).toBe(body.id);
    expect((await getStats(api.deps)).shares).toBe(sharesBefore + 1);
  });

  it("builds absolute URLs from x-forwarded-host (CloudFront)", async () => {
    const s = await api.createSession();
    const c = await seedChallenge(s, challenge());
    const body = await share(s, c.id, { "x-forwarded-host": "thirty.example.cloudfront.net" });
    expect(body.url).toBe(`https://thirty.example.cloudfront.net/s/${body.id}`);
    expect(body.imageUrl).toBe(`https://thirty.example.cloudfront.net/media/share/${body.id}.png`);
  });

  it("replaces the previous card of the same challenge", async () => {
    const s = await api.createSession();
    const c = await seedChallenge(s, challenge());
    const first = await share(s, c.id);
    const second = await share(s, c.id);
    expect(second.id).not.toBe(first.id);
    expect(await getItem(`SHARE#${first.id}`, "META")).toBeUndefined();
    expect(api.media.objects.has(`share/${first.id}.png`)).toBe(false);
    expect(api.media.objects.has(`share/${second.id}.png`)).toBe(true);
    expect((await getChallengeItem(api.deps, s.user.id, c.id))?.shareId).toBe(second.id);
    expect((await api.request(`/s/${first.id}`)).status).toBe(404);
  });

  it("rejects images that are not a 1200x630 PNG", async () => {
    const s = await api.createSession();
    const c = await seedChallenge(s, challenge());
    const send = (imageBase64: string) => api.request("/api/shares", { token: s.token, body: { challengeId: c.id, imageBase64 } });
    const mediaBefore = api.media.objects.size;

    const wrongSize = await send(makePng(1200, 600).toString("base64"));
    expect(wrongSize.status).toBe(400);
    expect((await errorOf(wrongSize)).fields?.imageBase64).toContain("1200×630");
    expect((await send(Buffer.from("GIF89a".padEnd(200, "x")).toString("base64"))).status).toBe(400);
    expect((await send(`data:image/png;base64,${PNG_B64}`)).status).toBe(400);
    expect((await send(`${PNG_B64.slice(0, 100)}\n${PNG_B64.slice(100)}`)).status).toBe(400);
    expect(api.media.objects.size).toBe(mediaBefore);
    expect((await getChallengeItem(api.deps, s.user.id, c.id))?.shareId).toBeNull();
  });

  it("is 413 when the decoded image is over the limit", async () => {
    const s = await api.createSession();
    const c = await seedChallenge(s, challenge());
    const big = Buffer.alloc(LIMITS.shareImageBytes + 3, 1).toString("base64");
    const res = await api.request("/api/shares", { token: s.token, body: { challengeId: c.id, imageBase64: big } });
    expect(res.status).toBe(413);
    expect((await errorOf(res)).code).toBe("payload_too_large");
  });

  it("only shares the caller's finished challenges", async () => {
    const s = await api.createSession();
    const other = await api.createSession();
    const active = await seedChallenge(s, challenge({ status: "active", verdict: null, reflection: null, finishedAt: null, finishedDay: null }));
    const notDone = await api.request("/api/shares", { token: s.token, body: { challengeId: active.id, imageBase64: PNG_B64 } });
    expect(notDone.status).toBe(409);
    expect((await errorOf(notDone)).code).toBe("conflict");

    const theirs = await seedChallenge(other, challenge());
    expect((await api.request("/api/shares", { token: s.token, body: { challengeId: theirs.id, imageBase64: PNG_B64 } })).status).toBe(404);
    expect((await api.request("/api/shares", { token: s.token, body: { challengeId: newId(16), imageBase64: PNG_B64 } })).status).toBe(404);
    expect((await api.request("/api/shares", { body: { challengeId: theirs.id, imageBase64: PNG_B64 } })).status).toBe(401);
    expect((await api.request("/api/shares", { token: s.token, body: { challengeId: "x", imageBase64: PNG_B64 } })).status).toBe(400);
  });

  it("allows sharesPerUserPerDay", async () => {
    const s = await api.createSession();
    const c = await seedChallenge(s, challenge());
    for (let i = 0; i < QUOTAS.sharesPerUserPerDay; i++) await share(s, c.id);
    const res = await api.request("/api/shares", { token: s.token, body: { challengeId: c.id, imageBase64: PNG_B64 } });
    expect(res.status).toBe(429);
  });
});

describe("DELETE /api/shares/:id", () => {
  it("is owner-only and removes the image, the item and challenge.shareId", async () => {
    const s = await api.createSession();
    const other = await api.createSession();
    const c = await seedChallenge(s, challenge());
    const { id } = await share(s, c.id);

    expect((await api.request(`/api/shares/${id}`, { method: "DELETE", token: other.token })).status).toBe(404);
    expect((await api.request(`/api/shares/${id}`, { method: "DELETE" })).status).toBe(401);
    expect(api.media.objects.has(`share/${id}.png`)).toBe(true);

    expect((await api.request(`/api/shares/${id}`, { method: "DELETE", token: s.token })).status).toBe(204);
    expect(api.media.objects.has(`share/${id}.png`)).toBe(false);
    expect(await getItem(`SHARE#${id}`, "META")).toBeUndefined();
    expect((await getChallengeItem(api.deps, s.user.id, c.id))?.shareId).toBeUndefined();
    expect((await api.request(`/s/${id}`)).status).toBe(404);
    expect((await api.request(`/api/shares/${id}`, { method: "DELETE", token: s.token })).status).toBe(404);
  });

  it("cards go with the owner's account", async () => {
    const s = await api.createSession();
    const c = await seedChallenge(s, challenge());
    const { id } = await share(s, c.id);
    expect((await api.request("/api/me", { method: "DELETE", token: s.token })).status).toBe(204);
    expect(await getItem(`SHARE#${id}`, "META")).toBeUndefined();
    expect(api.media.objects.has(`share/${id}.png`)).toBe(false);
  });
});

// ---------- GET /s/:id ----------

describe("GET /s/:id", () => {
  it("renders the card with OGP tags and a CTA to the same recipe", async () => {
    const s = await api.createSession("ゆう");
    const c = await seedChallenge(s, challenge());
    const { id } = await share(s, c.id, { "x-forwarded-host": "thirty.example.net" });

    const res = await api.request(`/s/${id}`, { headers: { "x-forwarded-host": "thirty.example.net" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).not.toContain("script-src");
    const html = await res.text();
    expect(html).toMatch(/^<!doctype html>\n<html lang="ja">/);
    expect(html).toContain(`<meta property="og:title" content="ゆうの30日「毎日1枚、写真を撮る」">`);
    expect(html).toContain(`<meta property="og:description" content="続ける · 3/30日 — 続けてよかった。 来月も撮る。">`);
    expect(html).toContain(`<meta property="og:image" content="https://thirty.example.net/media/share/${id}.png">`);
    expect(html).toContain(`<meta property="og:image:width" content="1200">`);
    expect(html).toContain(`<meta property="og:image:height" content="630">`);
    expect(html).toContain(`<meta property="og:url" content="https://thirty.example.net/s/${id}">`);
    expect(html).toContain(`<meta property="og:type" content="article">`);
    expect(html).toContain(`<meta name="twitter:card" content="summary_large_image">`);
    expect(html).toContain(`<img src="/media/share/${id}.png"`);
    expect(html).toContain(`href="/recipes/photo"`);
    expect(html).toContain("自分も30日やってみる");
    expect(html).toContain(`href="/about"`);
    expect(html).toContain(`href="${TED_TALK_URL}"`);
    expect(html).toContain("Matt Cutts “Try something new for 30 days”");
    expect(html).toContain("着想：");
    expect(html).toContain("続けてよかった。\n来月も撮る。");
    expect(html).not.toMatch(/<script/i);
    // Nothing private.
    expect(html).not.toContain(s.user.id);
    expect(html).not.toContain("ひみつのメモ");
  });

  it("escapes every interpolated value", async () => {
    const s = await api.createSession(`"><b>x`);
    const evil = `<script>alert("x")</script>'"&`;
    const c = await seedChallenge(s, challenge({ title: evil, seal: "<", reflection: `</blockquote><script>alert('y')</script>`, recipeId: null }));
    const { id } = await share(s, c.id);
    const html = await (await api.request(`/s/${id}`)).text();
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("<b>x");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39;&quot;&amp;");
    expect(html).toContain("&quot;&gt;&lt;b&gt;x");
    expect(html).toContain("&lt;/blockquote&gt;&lt;script&gt;alert(&#39;y&#39;)&lt;/script&gt;");
    // Attribute values cannot be broken out of.
    const ogTitle = html.match(/<meta property="og:title" content="([^"]*)">/);
    expect(ogTitle?.[1]).toContain("&lt;script&gt;");
    // No recipe → the CTA goes home.
    expect(html).toContain(`<a class="cta display" href="/">`);
  });

  it("is a 404 HTML page for unknown, malformed and hidden cards", async () => {
    for (const path of ["/s/nosuchshare00000", "/s/BAD!", "/s/%3Cscript%3E"]) {
      const res = await api.request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const html = await res.text();
      expect(html).toContain("カードが見つかりません");
      expect(html).toContain(`<html lang="ja">`);
      expect(html).not.toMatch(/<script/i);
    }
    const s = await api.createSession();
    const c = await seedChallenge(s, challenge());
    const { id } = await share(s, c.id);
    const item = await getItem(`SHARE#${id}`, "META");
    await api.deps.db.send(new PutCommand({ TableName: api.deps.tableName, Item: { ...item, ...shareKey(id), status: "hidden" } }));
    expect((await api.request(`/s/${id}`)).status).toBe(404);
  });
});

// ---------- POST /api/metrics/share ----------

describe("POST /api/metrics/share", () => {
  it("counts the channel anonymously", async () => {
    const before = Number((await getItem(statsKey().pk, statsKey().sk))?.share_x ?? 0);
    const res = await api.request("/api/metrics/share", { body: { channel: "x" } });
    expect(res.status).toBe(204);
    expect(Number((await getItem(statsKey().pk, statsKey().sk))?.share_x)).toBe(before + 1);
    expect((await api.request("/api/metrics/share", { body: { channel: "fax" } })).status).toBe(400);
    expect((await api.request("/api/metrics/share", { raw: "channel=x", contentType: "text/plain" })).status).toBe(415);
  });

  it("is limited per IP and day", async () => {
    const ip = "203.0.113.7";
    for (let i = 0; i < 100; i++) {
      const res = await api.request("/api/metrics/share", { body: { channel: "line" }, ip });
      expect(res.status).toBe(204);
    }
    expect((await api.request("/api/metrics/share", { body: { channel: "line" }, ip })).status).toBe(429);
    expect((await api.request("/api/metrics/share", { body: { channel: "line" } })).status).toBe(204);
  });
});
