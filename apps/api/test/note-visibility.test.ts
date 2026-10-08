/**
 * #17: a day note is shown in 「みんな」 only when its owner chose it (db/notes.ts). Private by default,
 * private again on any change, and gone from the public route on the very next request after an
 * un-share, progress turned off, a moderator's hide or a deleted account.
 */
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIMITS,
  QUOTAS,
  TOTAL_DAYS,
  newId,
  type ApiError,
  type BackupFile,
  type Challenge,
  type ChallengeCreate,
  type ChallengeListResponse,
  type ChallengeResponse,
  type CohortMember,
  type CohortResponse,
  type ImportResponse,
  type MemberNote,
  type MemberNotesResponse,
  type SessionResponse,
} from "@thirty/shared";
import { toChallengeItem, type ChallengeFlags } from "../src/db/challenges";
import { challengeKey, userKey } from "../src/db/keys";
import { getQuotaUsage, quotaCounterKey, windowFor } from "../src/db/rate";
import type { Item } from "../src/db/util";
import { MESSAGES } from "../src/errors";
import { CHALLENGE_MESSAGES as M, NOTE_SHOW_QUOTA_SCOPE } from "../src/routes/challenges";
import { ADMIN_TOKEN, json, setupApi } from "./helpers";

const api = setupApi();

/** 12:00 in Tokyo on 2026-10-06. */
const BASE = "2026-10-06T03:00:00.000Z";
const TODAY = "2026-10-06";
/** A start date 6 days back: today is day 6, so days 1..7 can be stamped. */
const EARLIER = "2026-10-01";
const NOT_FOUND = { error: { code: "not_found", message: MESSAGES.notFound } };

beforeEach(() => api.clock.set(BASE));

async function put(item: Item) {
  await api.deps.db.send(new PutCommand({ TableName: api.deps.tableName, Item: item }));
}

const rawItem = async (s: SessionResponse, id: string) =>
  (await api.deps.db.send(new GetCommand({ TableName: api.deps.tableName, Key: challengeKey(s.user.id, id) }))).Item;
const rawStamp = async (s: SessionResponse, id: string, day: number) =>
  ((await rawItem(s, id))?.stamps as Record<string, Record<string, unknown>> | undefined)?.[String(day)];

/** Write stamps.<day> directly (data from before today's rules, or a crafted state). */
async function setRawStamp(s: SessionResponse, id: string, day: number, value: Record<string, unknown>) {
  await api.deps.db.send(
    new UpdateCommand({
      TableName: api.deps.tableName,
      Key: challengeKey(s.user.id, id),
      UpdateExpression: "SET #stamps.#day = :v",
      ExpressionAttributeNames: { "#stamps": "stamps", "#day": String(day) },
      ExpressionAttributeValues: { ":v": value },
    }),
  );
}

async function create(s: SessionResponse, overrides: Partial<ChallengeCreate> = {}): Promise<Challenge> {
  const body: ChallengeCreate = { id: newId(16), recipeId: "photo", title: "毎日1枚、写真を撮る", seal: "写", startDate: TODAY, ...overrides };
  const res = await api.request("/api/challenges", { token: s.token, body });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return (await json<ChallengeResponse>(res)).challenge;
}

function challenge(overrides: Partial<Challenge> = {}): Challenge {
  const now = api.clock.now().getTime();
  return {
    id: newId(16),
    recipeId: null,
    title: "毎日スクワット",
    seal: "筋",
    startDate: EARLIER,
    status: "active",
    stamps: {},
    verdict: null,
    reflection: null,
    finishedAt: null,
    finishedDay: null,
    cheers: 0,
    shareId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** A challenge item written directly, with raw stamps (anything a stored item could hold). */
async function seed(s: SessionResponse, c: Challenge, stamps: Record<string, unknown>, flags: ChallengeFlags = {}) {
  await put({ ...toChallengeItem(s.user.id, s.user, c, flags), stamps });
  await put({ pk: `CHREF#${c.id}`, sk: "REF", userId: s.user.id });
}

const stamp = (s: SessionResponse, id: string, day: number, body?: unknown) =>
  api.request(`/api/challenges/${id}/stamps/${day}`, { method: "PUT", token: s.token, body });
const unstamp = (s: SessionResponse, id: string, day: number) =>
  api.request(`/api/challenges/${id}/stamps/${day}`, { method: "DELETE", token: s.token });
const visibility = (s: SessionResponse | undefined, id: string, day: number | string, body: unknown) =>
  api.request(`/api/challenges/${id}/stamps/${day}/visibility`, { method: "PUT", token: s?.token, body });
const show = (s: SessionResponse, id: string, day: number, note: string) => visibility(s, id, day, { show: true, note });
const unshow = (s: SessionResponse, id: string, day: number) => visibility(s, id, day, { show: false });
const notesOf = (id: string, viewer?: SessionResponse) => api.request(`/api/members/${id}/notes`, { token: viewer?.token });
const setMe = (s: SessionResponse, body: unknown) => api.request("/api/me", { method: "PATCH", token: s.token, body });
const moderate = (targetType: string, targetId: string, action: string) =>
  api.request("/api/admin/moderate", { headers: { "x-admin-token": ADMIN_TOKEN }, body: { targetType, targetId, action } });

const challengeOf = async (res: Response) => (await json<ChallengeResponse>(res)).challenge;
const errorOf = async (res: Response) => (await json<ApiError>(res)).error;

/** The notes anyone sees for the member, or null when the route answers 404 (always the same body). */
async function visible(id: string, viewer?: SessionResponse): Promise<MemberNote[] | null> {
  const res = await notesOf(id, viewer);
  if (res.status === 404) {
    expect(await res.json()).toEqual(NOT_FOUND);
    return null;
  }
  expect(res.status).toBe(200);
  const body = await json<MemberNotesResponse>(res);
  expect(body.challengeId).toBe(id);
  return body.notes;
}

async function cohort(month: string, viewer?: SessionResponse): Promise<{ raw: string; data: CohortResponse }> {
  const res = await api.request(`/api/cohorts/${month}`, { token: viewer?.token });
  expect(res.status).toBe(200);
  const raw = await res.text();
  return { raw, data: JSON.parse(raw) as CohortResponse };
}
const memberOf = async (month: string, id: string, viewer?: SessionResponse): Promise<CohortMember | undefined> =>
  (await cohort(month, viewer)).data.members.find((m) => m.challengeId === id);

async function ownStamps(s: SessionResponse, id: string): Promise<Challenge["stamps"]> {
  const list = await json<ChallengeListResponse>(await api.request("/api/challenges", { token: s.token }));
  return list.challenges.find((c) => c.id === id)!.stamps;
}

async function stampAndShow(s: SessionResponse, id: string, day: number, note: string) {
  expect((await stamp(s, id, day, { note })).status).toBe(200);
  const res = await show(s, id, day, note);
  expect(res.status, await res.clone().text()).toBe(200);
  return res;
}

const noteShows = async (s: SessionResponse) =>
  (await getQuotaUsage(api.deps, NOTE_SHOW_QUOTA_SCOPE, s.user.id, QUOTAS.noteShowsPerUserPerDay, "day")).count;

/** Run `before` once, just before the first command `match` picks is sent (a request racing another). */
function beforeSend(match: (command: unknown) => boolean, before: (send: (command: unknown) => Promise<unknown>) => Promise<void>) {
  const db = api.deps.db;
  const send = db.send.bind(db) as (command: unknown) => Promise<unknown>;
  const state = { fired: false };
  const spy = vi.spyOn(db, "send").mockImplementation((async (command: unknown) => {
    if (!state.fired && match(command)) {
      state.fired = true;
      await before(send);
    }
    return send(command);
  }) as never);
  return { state, restore: () => spy.mockRestore() };
}
const isUpdate = (command: unknown, expression: string) =>
  command instanceof UpdateCommand && String(command.input.UpdateExpression).includes(expression);

type GetInput = { Key: { pk: string; sk: string }; ConsistentRead?: boolean };

type Answer = (input: GetInput, out: { Item?: Item }, send: (command: unknown) => Promise<unknown>) => { Item?: Item } | Promise<{ Item?: Item }>;

/**
 * The GetCommand inputs sent while `run` runs (dynalite always reads consistently, so only the
 * request can show a strong read). `answer` may change what a read returns (a stale replica), and
 * may write with `send` once the read is done (a write that races the request).
 */
async function readsDuring(run: () => Promise<void>, answer?: Answer): Promise<GetInput[]> {
  const db = api.deps.db;
  const send = db.send.bind(db) as (command: unknown) => Promise<unknown>;
  const reads: GetInput[] = [];
  const spy = vi.spyOn(db, "send").mockImplementation((async (command: unknown) => {
    if (!(command instanceof GetCommand)) return send(command);
    const input = command.input as unknown as GetInput;
    reads.push(input);
    const out = (await send(command)) as { Item?: Item };
    return answer ? answer(input, out, send) : out;
  }) as never);
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return reads;
}

describe("day notes in 「みんな」 (#17)", () => {
  it("(a) keeps every note private by default: not in the list, not in the member's notes, no `shown`", async () => {
    const a = await api.createSession("Aさん");
    const b = await api.createSession("Bさん");
    const ch = await create(a);
    const t0 = api.clock.now().getTime();
    expect((await challengeOf(await stamp(a, ch.id, 1, { note: "ないしょのメモ1" }))).stamps).toEqual({ "1": { at: t0, note: "ないしょのメモ1" } });
    expect((await stamp(a, ch.id, 2, { note: "ないしょのメモ2" })).status).toBe(200);
    expect(await ownStamps(a, ch.id)).toEqual({ "1": { at: t0, note: "ないしょのメモ1" }, "2": { at: t0, note: "ないしょのメモ2" } });

    for (const viewer of [undefined, b, a]) {
      const { raw } = await cohort("2026-10", viewer);
      expect(raw).not.toContain("ないしょ");
      expect(raw).not.toMatch(/"shownNote"/);
      expect(await memberOf("2026-10", ch.id, viewer)).not.toHaveProperty("shownNoteCount");
      const res = await notesOf(ch.id, viewer);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(JSON.parse(body)).toEqual({ challengeId: ch.id, notes: [] });
      expect(body).not.toContain("ないしょ");
    }
    expect(JSON.stringify(await rawItem(a, ch.id))).not.toContain("shownNote");
  });

  it("(b) never shows a note stored without the visibility route: legacy data, an inert `shown`, a stale or broken consent", async () => {
    const a = await api.createSession("昔からの人");
    const c = challenge();
    await seed(a, c, {
      "1": { at: 1, note: "古いメモ" }, // written before #17
      "2": { at: 2, note: "古いメモ2", shown: true }, // a copy of the owner view written back
      "3": { at: 3, note: "書き換えた", shownNote: "書き換える前" }, // consent for another text
      "4": { at: 4, note: "https://example.com", shownNote: "https://example.com" }, // breaks the public rules
      "5": { at: 5, note: "  空白つき  ", shownNote: "  空白つき  " }, // not normalised
      "6": { at: 6, shownNote: "メモのない日" },
      "7": { at: "7", note: "壊れた印", shownNote: "壊れた印" }, // not a stamp
    });
    expect(await visible(c.id)).toEqual([]);
    const { raw } = await cohort("2026-10");
    for (const text of ["古いメモ", "書き換え", "example.com", "空白つき", "メモのない日", "壊れた印"]) expect(raw).not.toContain(text);
    expect(await memberOf("2026-10", c.id)).not.toHaveProperty("shownNoteCount");
    const own = await ownStamps(a, c.id);
    expect(Object.values(own).some((s) => "shown" in s)).toBe(false);
    expect(JSON.stringify(own)).not.toContain("shownNote");

    // An item without a stamps map at all (the oldest format): a stamp is private, then can be shown.
    const legacy = challenge();
    const { stamps: _none, ...withoutStamps } = toChallengeItem(a.user.id, a.user, legacy);
    await put(withoutStamps);
    await put({ pk: `CHREF#${legacy.id}`, sk: "REF", userId: a.user.id });
    expect((await challengeOf(await stamp(a, legacy.id, 1, { note: "最初の印" }))).stamps["1"]).not.toHaveProperty("shown");
    expect(await visible(legacy.id)).toEqual([]);
    await show(a, legacy.id, 1, "最初の印");
    expect(await visible(legacy.id)).toEqual([{ day: 1, note: "最初の印" }]);
  });

  it("(c) shows exactly the day the owner chose, only through the member route, never as text in the list", async () => {
    const a = await api.createSession("Aさん");
    const b = await api.createSession("Bさん");
    const ch = await create(a);
    const t0 = api.clock.now().getTime();
    await stamp(a, ch.id, 1, { note: "1日目はないしょ" });
    await stamp(a, ch.id, 2, { note: "2日目は見せる" });

    const res = await show(a, ch.id, 2, "2日目は見せる");
    expect(res.status).toBe(200);
    expect((await challengeOf(res)).stamps).toEqual({
      "1": { at: t0, note: "1日目はないしょ" },
      "2": { at: t0, note: "2日目は見せる", shown: true },
    });
    expect(await ownStamps(a, ch.id)).toEqual({ "1": { at: t0, note: "1日目はないしょ" }, "2": { at: t0, note: "2日目は見せる", shown: true } });

    for (const viewer of [undefined, b]) {
      const notes = await notesOf(ch.id, viewer);
      expect(notes.status).toBe(200);
      expect(notes.headers.get("cache-control")).toBe("no-store");
      const body = await notes.text();
      expect(JSON.parse(body)).toEqual({ challengeId: ch.id, notes: [{ day: 2, note: "2日目は見せる" }] });
      expect(body).not.toContain("ないしょ");
      expect(body).not.toContain(a.user.id);

      const { raw } = await cohort("2026-10", viewer);
      expect(raw).not.toContain("ないしょ");
      expect(raw).not.toContain("2日目は見せる");
      expect(raw).not.toMatch(/"shownNote"/);
      expect(raw).not.toContain(a.user.id);
    }
    expect(await memberOf("2026-10", ch.id, b)).toEqual({
      challengeId: ch.id,
      nickname: "Aさん",
      seal: "写",
      title: "毎日1枚、写真を撮る",
      recipeId: "photo",
      startDate: TODAY,
      stampDays: [1, 2],
      done: false,
      verdict: null,
      cheers: 0,
      cheeredToday: false,
      isMine: false,
      updatedAt: t0,
      shownNoteCount: 1,
    });

    // Unknown, unlisted or malformed ids.
    expect(await visible(newId(16))).toBeNull();
    expect((await notesOf("BAD!")).status).toBe(400);
    const p = await api.createSession("非公開の人");
    await setMe(p, { shareProgress: false });
    const priv = await create(p);
    await stamp(p, priv.id, 1, { note: "見せられない" });
    expect(await visible(priv.id)).toBeNull();
  });

  it("(d) refuses a stale note (409), and a URL, an empty note or an unstamped day (400); a private URL note still saves", async () => {
    const a = await api.createSession("断られる");
    const ch = await create(a, { startDate: EARLIER });
    await stamp(a, ch.id, 1, { note: "いまのメモ" });

    const stale = await show(a, ch.id, 1, "ほかの端末で見た前のメモ");
    expect(stale.status).toBe(409);
    const staleBody = await stale.text();
    expect(JSON.parse(staleBody).error.message).toBe(M.noteChanged);
    expect(staleBody).not.toContain("いまのメモ");

    // A URL is fine in a private note, but it cannot be shown.
    expect((await stamp(a, ch.id, 2, { note: "https://example.com を読んだ" })).status).toBe(200);
    const url = await show(a, ch.id, 2, "https://example.com を読んだ");
    expect(url.status).toBe(400);
    expect((await errorOf(url)).fields).toEqual({ note: "ひとことにURLは入れられません" });

    await stamp(a, ch.id, 3);
    for (const day of [3, 5]) {
      const res = await show(a, ch.id, day, "なにか");
      expect(res.status, String(day)).toBe(400);
      expect(await errorOf(res)).toMatchObject({ message: M.noteMissing, fields: { note: M.noteMissing } });
    }

    // Stored before today's rules: not normalised, or over the UTF-8 cap.
    await setRawStamp(a, ch.id, 4, { at: 4, note: "  空白つき  " });
    const notNormal = await show(a, ch.id, 4, "  空白つき  ");
    expect(notNormal.status).toBe(400);
    expect(await errorOf(notNormal)).toMatchObject({ message: M.noteNotNormal, fields: { note: M.noteNotNormal } });
    const fat = "a" + String.fromCodePoint(0x20dd).repeat(LIMITS.note * 4 + 15);
    await setRawStamp(a, ch.id, 6, { at: 6, note: fat });
    const tooBig = await show(a, ch.id, 6, fat);
    expect(tooBig.status).toBe(400);
    expect((await errorOf(tooBig)).fields?.note).toBe("ひとことが長すぎます（絵文字などが多いため、あと1文字減らしてください）");

    for (const body of [{}, { show: true }, { show: true, note: "" }, { show: "yes", note: "いまのメモ" }, { note: "いまのメモ" }]) {
      expect((await visibility(a, ch.id, 1, body)).status, JSON.stringify(body)).toBe(400);
    }
    for (const day of ["0", "31", "x", "1.5"]) expect((await visibility(a, ch.id, day, { show: false })).status, day).toBe(400);
    expect((await visibility(a, "BAD!", 1, { show: false })).status).toBe(400);
    expect((await visibility(undefined, ch.id, 1, { show: true, note: "いまのメモ" })).status).toBe(401);
    const noJson = await api.request(`/api/challenges/${ch.id}/stamps/1/visibility`, { method: "PUT", token: a.token, raw: "{", contentType: "application/json" });
    expect(noJson.status).toBe(400);

    expect(JSON.stringify(await rawItem(a, ch.id))).not.toContain("shownNote");
    expect(await noteShows(a)).toBe(0);
    expect(await visible(ch.id)).toEqual([]);
  });

  it("(e) any change of the text makes it private again; a re-stamp or saving the same text keeps it", async () => {
    const a = await api.createSession("書き換える");
    const ch = await create(a);
    const t0 = api.clock.now().getTime();
    await stampAndShow(a, ch.id, 1, "見せるメモ");
    const shown = [{ day: 1, note: "見せるメモ" }];

    // A re-stamp ({} from an outbox) and the same text (after normalising) keep it.
    expect((await challengeOf(await stamp(a, ch.id, 1))).stamps["1"]).toEqual({ at: t0, note: "見せるメモ", shown: true });
    expect((await challengeOf(await stamp(a, ch.id, 1, {}))).stamps["1"]).toEqual({ at: t0, note: "見せるメモ", shown: true });
    expect((await challengeOf(await stamp(a, ch.id, 1, { note: "  見せるメモ  " }))).stamps["1"]).toEqual({ at: t0, note: "見せるメモ", shown: true });
    expect(await visible(ch.id)).toEqual(shown);

    // A new text is private, and so is going back to the old one.
    expect((await challengeOf(await stamp(a, ch.id, 1, { note: "書き換えたメモ" }))).stamps["1"]).toEqual({ at: t0, note: "書き換えたメモ" });
    expect(await visible(ch.id)).toEqual([]);
    expect(await rawStamp(a, ch.id, 1)).toEqual({ at: t0, note: "書き換えたメモ" });
    expect((await challengeOf(await stamp(a, ch.id, 1, { note: "見せるメモ" }))).stamps["1"]).toEqual({ at: t0, note: "見せるメモ" });
    expect(await visible(ch.id)).toEqual([]);

    // Clearing the note.
    expect((await show(a, ch.id, 1, "見せるメモ")).status).toBe(200);
    expect(await visible(ch.id)).toEqual(shown);
    expect((await challengeOf(await stamp(a, ch.id, 1, { note: "" }))).stamps["1"]).toEqual({ at: t0 });
    expect(await rawStamp(a, ch.id, 1)).toEqual({ at: t0 });
    expect((await challengeOf(await stamp(a, ch.id, 1, { note: "見せるメモ" }))).stamps["1"]).toEqual({ at: t0, note: "見せるメモ" });
    expect(await visible(ch.id)).toEqual([]);

    // Removing the stamp removes the choice with it.
    expect((await show(a, ch.id, 1, "見せるメモ")).status).toBe(200);
    expect((await unstamp(a, ch.id, 1)).status).toBe(200);
    expect(await visible(ch.id)).toEqual([]);
    expect((await challengeOf(await stamp(a, ch.id, 1, { note: "見せるメモ" }))).stamps["1"]).not.toHaveProperty("shown");
    expect(await visible(ch.id)).toEqual([]);
  });

  it("(f) a re-stamp read before an un-share and written after it never puts the choice back", async () => {
    const a = await api.createSession("ふたつの端末");
    const ch = await create(a);
    const t0 = api.clock.now().getTime();
    await stampAndShow(a, ch.id, 1, "見せていたメモ");

    // The phone's queued {} has read the stamp (shown); the owner stops showing it on the PC before it writes.
    const race = beforeSend(
      (command) => isUpdate(command, "#stamps.#day = :stamp"),
      async () => {
        expect((await unshow(a, ch.id, 1)).status).toBe(200);
      },
    );
    let res: Response;
    try {
      res = await stamp(a, ch.id, 1);
    } finally {
      race.restore();
    }
    expect(race.state.fired).toBe(true);
    expect(res.status).toBe(200);
    expect((await challengeOf(res)).stamps["1"]).toEqual({ at: t0, note: "見せていたメモ" });
    expect(await rawStamp(a, ch.id, 1)).toEqual({ at: t0, note: "見せていたメモ" });
    expect(await visible(ch.id)).toEqual([]);
  });

  it("(g) counts only a real private → shown change, and gives it back when the note changed meanwhile; done challenges can show and stop", async () => {
    const a = await api.createSession("数える");
    const ch = await create(a, { startDate: "2026-09-29" }); // today is day 8
    await stamp(a, ch.id, 1, { note: "数えるメモ" });
    expect(await noteShows(a)).toBe(0);
    expect((await show(a, ch.id, 1, "数えるメモ")).status).toBe(200);
    expect(await noteShows(a)).toBe(1);
    expect((await show(a, ch.id, 1, "数えるメモ")).status).toBe(200); // already shown
    expect((await show(a, ch.id, 1, "ちがうメモ")).status).toBe(409); // refused before counting
    expect(await noteShows(a)).toBe(1);
    expect((await unshow(a, ch.id, 1)).status).toBe(200);
    expect((await unshow(a, ch.id, 1)).status).toBe(200); // nothing left to stop
    const noStamp = await unshow(a, ch.id, 9);
    expect(noStamp.status).toBe(200);
    expect((await challengeOf(noStamp)).stamps["1"]).toMatchObject({ note: "数えるメモ" });
    expect(await noteShows(a)).toBe(1);

    // The note is rewritten on another device between the checks and the write: nothing is shown,
    // the use is given back.
    const race = beforeSend(
      (command) => isUpdate(command, "SET #stamps.#day.#sn = :note"),
      async (send) => {
        await send(
          new UpdateCommand({
            TableName: api.deps.tableName,
            Key: challengeKey(a.user.id, ch.id),
            UpdateExpression: "SET #stamps.#day.#note = :n",
            ExpressionAttributeNames: { "#stamps": "stamps", "#day": "1", "#note": "note" },
            ExpressionAttributeValues: { ":n": "ほかの端末で書き換え" },
          }),
        );
      },
    );
    let raced: Response;
    try {
      raced = await show(a, ch.id, 1, "数えるメモ");
    } finally {
      race.restore();
    }
    expect(race.state.fired).toBe(true);
    expect(raced.status).toBe(409);
    expect((await errorOf(raced)).message).toBe(M.noteChanged);
    expect(await noteShows(a)).toBe(1);
    expect(await rawStamp(a, ch.id, 1)).not.toHaveProperty("shownNote");

    // After the reflection the record is closed, but the choice can still be made and undone.
    await stamp(a, ch.id, 1, { note: "数えるメモ" });
    expect((await api.request(`/api/challenges/${ch.id}/reflect`, { token: a.token, body: { verdict: "continue" } })).status).toBe(200);
    expect((await stamp(a, ch.id, 2)).status).toBe(409);
    const doneShow = await show(a, ch.id, 1, "数えるメモ");
    expect(doneShow.status).toBe(200);
    expect(await challengeOf(doneShow)).toMatchObject({ status: "done", stamps: { "1": { note: "数えるメモ", shown: true } } });
    expect(await visible(ch.id)).toEqual([{ day: 1, note: "数えるメモ" }]);
    expect(await memberOf("2026-09", ch.id)).toMatchObject({ done: true, verdict: "continue", shownNoteCount: 1 });
    expect(await noteShows(a)).toBe(2);
    expect((await unshow(a, ch.id, 1)).status).toBe(200);
    expect(await visible(ch.id)).toEqual([]);
  });

  it("(g) stopping is never refused: on hidden and imported challenges, and with the daily quota used up", async () => {
    const a = await api.createSession("やめたい");
    const ch = await create(a);
    await stampAndShow(a, ch.id, 1, "やめたいメモ");

    // Hidden by a moderator: stopping works, showing is refused.
    expect((await moderate("member", ch.id, "hide")).status).toBe(204);
    expect((await unshow(a, ch.id, 1)).status).toBe(200);
    expect(await rawStamp(a, ch.id, 1)).not.toHaveProperty("shownNote");
    const hidden = await show(a, ch.id, 1, "やめたいメモ");
    expect(hidden.status).toBe(409);
    expect((await errorOf(hidden)).message).toBe(M.notListed);
    expect((await moderate("member", ch.id, "restore")).status).toBe(204);

    // Imported (private until used): a consent stored on it can be removed; showing is refused.
    const imported = challenge();
    await seed(a, imported, { "1": { at: 1, note: "読み込んだメモ", shownNote: "読み込んだメモ" } }, { imported: true });
    expect(await visible(imported.id)).toBeNull();
    expect((await unshow(a, imported.id, 1)).status).toBe(200);
    expect(await rawStamp(a, imported.id, 1)).toEqual({ at: 1, note: "読み込んだメモ" });
    const refused = await show(a, imported.id, 1, "読み込んだメモ");
    expect(refused.status).toBe(409);
    expect((await errorOf(refused)).message).toBe(M.notListed);
    expect((await rawItem(a, imported.id))?.imported).toBe(true);

    // The day's quota is used up: showing is 429, stopping still works.
    expect((await show(a, ch.id, 1, "やめたいメモ")).status).toBe(200);
    const now = api.clock.now();
    await put({ ...quotaCounterKey(NOTE_SHOW_QUOTA_SCOPE, a.user.id, windowFor("day", now).id), count: QUOTAS.noteShowsPerUserPerDay });
    await stamp(a, ch.id, 2, { note: "もうひとつ" });
    const limited = await show(a, ch.id, 2, "もうひとつ");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect((await errorOf(limited)).code).toBe("rate_limited");
    expect(await rawStamp(a, ch.id, 2)).not.toHaveProperty("shownNote");
    expect(await visible(ch.id)).toEqual([{ day: 1, note: "やめたいメモ" }]);
    expect((await unshow(a, ch.id, 1)).status).toBe(200);
    expect(await visible(ch.id)).toEqual([]);
    expect(await noteShows(a)).toBe(QUOTAS.noteShowsPerUserPerDay);
  });

  it("(h) the visibility write leaves updatedAt, the list position, the nickname and `imported` alone", async () => {
    const a = await api.createSession("動かない");
    const ch = await create(a);
    await stamp(a, ch.id, 1, { note: "そっと見せる" });
    const before = await rawItem(a, ch.id);
    const unchanged = async () => {
      const after = await rawItem(a, ch.id);
      for (const k of ["updatedAt", "gsi1pk", "gsi1sk", "nickname", "imported", "hiddenFromCohort", "status", "cheers"]) {
        expect(after?.[k], k).toEqual(before?.[k]);
      }
    };
    api.clock.advance(3_600_000);
    const res = await show(a, ch.id, 1, "そっと見せる");
    expect((await challengeOf(res)).updatedAt).toBe(before?.updatedAt);
    await unchanged();
    expect(await memberOf("2026-10", ch.id)).toMatchObject({ updatedAt: before?.updatedAt, shownNoteCount: 1 });
    api.clock.advance(3_600_000);
    expect((await unshow(a, ch.id, 1)).status).toBe(200);
    await unchanged();
  });

  it("(i) shareProgress off: 404 at once, even while gsi1 still lists the challenge; on again, the same choices come back", async () => {
    const a = await api.createSession("オンオフ");
    const ch = await create(a);
    await stamp(a, ch.id, 2, { note: "見せていないメモ" });
    await stampAndShow(a, ch.id, 1, "見せているメモ");
    expect(await visible(ch.id)).toEqual([{ day: 1, note: "見せているメモ" }]);
    const listed = await rawItem(a, ch.id);

    expect((await setMe(a, { shareProgress: false })).status).toBe(200);
    expect(await visible(ch.id)).toBeNull();
    const off = await show(a, ch.id, 2, "見せていないメモ");
    expect(off.status).toBe(409);
    expect((await errorOf(off)).message).toBe(M.progressOff);
    // The owner's choice is kept (and still marked) while nobody can see it.
    expect((await ownStamps(a, ch.id))["1"]).toMatchObject({ shown: true });

    // The projection left behind (a sync that gave up): the fresh read of shareProgress still says no.
    await api.deps.db.send(
      new UpdateCommand({
        TableName: api.deps.tableName,
        Key: challengeKey(a.user.id, ch.id),
        UpdateExpression: "SET gsi1pk = :pk, gsi1sk = :sk",
        ExpressionAttributeValues: { ":pk": listed?.gsi1pk, ":sk": listed?.gsi1sk },
      }),
    );
    expect(await visible(ch.id)).toBeNull();

    expect((await setMe(a, { shareProgress: true })).status).toBe(200);
    expect(await visible(ch.id)).toEqual([{ day: 1, note: "見せているメモ" }]);
  });

  it("(j) a moderator's hide and auto-hide apply at once; restore brings back the same notes; delete is for good", async () => {
    const a = await api.createSession("通報される");
    const ch = await create(a, { startDate: EARLIER });
    await stamp(a, ch.id, 2, { note: "選んでいないメモ" });
    await stampAndShow(a, ch.id, 1, "選んだメモ");
    const chosen = [{ day: 1, note: "選んだメモ" }];

    expect((await moderate("member", ch.id, "hide")).status).toBe(204);
    expect(await visible(ch.id)).toBeNull();
    expect((await show(a, ch.id, 2, "選んでいないメモ")).status).toBe(409);
    expect((await moderate("member", ch.id, "restore")).status).toBe(204);
    expect(await visible(ch.id)).toEqual(chosen);

    // Auto-hide: trusted reporters from different networks.
    for (let i = 0; i < 3; i++) {
      const reporter = await api.trustedSession();
      expect((await api.request("/api/reports", { token: reporter.token, body: { targetType: "member", targetId: ch.id } })).status).toBe(204);
    }
    expect(await visible(ch.id)).toBeNull();
    expect((await moderate("member", ch.id, "restore")).status).toBe(204);
    expect(await visible(ch.id)).toEqual(chosen);

    expect((await moderate("member", ch.id, "delete")).status).toBe(204);
    expect(await visible(ch.id)).toBeNull();
    expect((await moderate("member", ch.id, "restore")).status).toBe(409);
    expect(await visible(ch.id)).toBeNull();

    // Export → delete → import: still out, private, and cannot be shown.
    const file = await json<BackupFile>(await api.request("/api/me/export", { token: a.token }));
    expect((await api.request(`/api/challenges/${ch.id}`, { method: "DELETE", token: a.token })).status).toBe(204);
    expect((await api.request("/api/me/import", { token: a.token, body: file })).status).toBe(200);
    expect(await rawItem(a, ch.id)).toMatchObject({ hiddenFromCohort: true });
    expect(await visible(ch.id)).toBeNull();
    const again = await show(a, ch.id, 1, "選んだメモ");
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe(M.notListed);
    expect((await stamp(a, ch.id, 3)).status).toBe(200);
    expect(await visible(ch.id)).toBeNull();
  });

  it("(k) an import never carries a choice: own ids, foreign ids and a crafted shownNote all come back private", async () => {
    const a = await api.createSession("読み込む");
    const b = await api.createSession("別の人");
    const ch = await create(a, { startDate: EARLIER });
    await stamp(a, ch.id, 2, { note: "見せていないメモ" });
    await stampAndShow(a, ch.id, 1, "見せていたメモ");

    const file = await json<BackupFile>(await api.request("/api/me/export", { token: a.token }));
    expect(file.version).toBe(1);
    const exported = file.challenges.find((c) => c.id === ch.id)!;
    expect(exported.stamps["1"]).toMatchObject({ note: "見せていたメモ", shown: true });
    expect(exported.stamps["2"]).not.toHaveProperty("shown");
    expect(JSON.stringify(file)).not.toContain("shownNote");

    // Crafted: every stamp claims to be shown.
    api.clock.advance(1000);
    const crafted = JSON.parse(JSON.stringify(file)) as BackupFile;
    for (const c of crafted.challenges) {
      c.updatedAt = api.clock.now().getTime(); // newer: replaces the item
      for (const s of Object.values(c.stamps)) Object.assign(s, { shown: true, shownNote: s.note });
    }
    const imported = await api.request("/api/me/import", { token: a.token, body: crafted });
    expect(await json<ImportResponse>(imported)).toEqual({ imported: 1, skipped: 0 });
    const own = await ownStamps(a, ch.id);
    expect(Object.values(own).some((s) => "shown" in s)).toBe(false);
    expect(JSON.stringify(await rawItem(a, ch.id))).not.toContain("shownNote");
    expect(await visible(ch.id)).toBeNull(); // imported: not listed

    // Used again (a stamp): listed, and still private.
    expect((await stamp(a, ch.id, 3)).status).toBe(200);
    expect(await visible(ch.id)).toEqual([]);

    // Someone else's file: a new id, private.
    expect(await json<ImportResponse>(await api.request("/api/me/import", { token: b.token, body: crafted }))).toEqual({ imported: 1, skipped: 0 });
    const copied = (await json<ChallengeListResponse>(await api.request("/api/challenges", { token: b.token }))).challenges[0]!;
    expect(copied.id).not.toBe(ch.id);
    expect(Object.values(copied.stamps).some((s) => "shown" in s)).toBe(false);
    expect(JSON.stringify(await rawItem(b, copied.id))).not.toContain("shownNote");

    // The same id after deleting it.
    expect((await api.request(`/api/challenges/${ch.id}`, { method: "DELETE", token: a.token })).status).toBe(204);
    expect(await json<ImportResponse>(await api.request("/api/me/import", { token: a.token, body: file }))).toEqual({ imported: 1, skipped: 0 });
    expect(JSON.stringify(await rawItem(a, ch.id))).not.toContain("shownNote");
    expect(Object.values(await ownStamps(a, ch.id)).some((s) => "shown" in s)).toBe(false);
  });

  it("(l) DELETE /api/me leaves no shown note behind, and the member route answers 404", async () => {
    const a = await api.createSession("消える人");
    const ch = await create(a);
    await stampAndShow(a, ch.id, 1, "消えるはずのメモ");
    expect(await visible(ch.id)).toEqual([{ day: 1, note: "消えるはずのメモ" }]);
    expect((await api.request("/api/me", { method: "DELETE", token: a.token })).status).toBe(204);
    const dump = JSON.stringify(await api.scanAll());
    expect(dump).not.toContain("消えるはずのメモ");
    expect(dump).not.toContain(a.user.id);
    expect(dump).not.toContain(ch.id);
    expect(await visible(ch.id)).toBeNull();
  });

  it("(m) the moderator's preview of a member carries the shown notes only", async () => {
    const a = await api.createSession("見せる人");
    const ch = await create(a, { title: "見せたい記録" });
    await stamp(a, ch.id, 2, { note: "見せていない2日目" });
    await stampAndShow(a, ch.id, 1, "見せた1日目");
    const reporter = await api.trustedSession();
    expect((await api.request("/api/reports", { token: reporter.token, body: { targetType: "member", targetId: ch.id } })).status).toBe(204);
    const preview = async () => {
      const res = await api.request("/api/admin/reports", { headers: { "x-admin-token": ADMIN_TOKEN } });
      return (await json<{ items: { targetId: string; preview: string }[] }>(res)).items.find((i) => i.targetId === ch.id)?.preview;
    };
    expect(await preview()).toBe("見せる人「見せたい記録」 1日目：見せた1日目");
    // Still readable while hidden, so the moderator sees what was reported before restoring.
    expect((await moderate("member", ch.id, "hide")).status).toBe(204);
    expect(await preview()).toBe("見せる人「見せたい記録」 1日目：見せた1日目");
    expect((await unshow(a, ch.id, 1)).status).toBe(200);
    expect(await preview()).toBe("見せる人「見せたい記録」");
  });

  it("(n) nobody else can show or stop showing someone's notes, and the answer carries no text", async () => {
    const a = await api.createSession("持ち主");
    const b = await api.createSession("他人");
    const ch = await create(a);
    await stamp(a, ch.id, 1, { note: "Aだけのメモ" });
    for (const res of [await show(b, ch.id, 1, "Aだけのメモ"), await unshow(b, ch.id, 1)]) {
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(JSON.parse(body)).toEqual(NOT_FOUND);
      expect(body).not.toContain("Aだけ");
    }
    expect(await visible(ch.id)).toEqual([]);

    await show(a, ch.id, 1, "Aだけのメモ");
    const res = await unshow(b, ch.id, 1);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("Aだけ");
    expect(await visible(ch.id)).toEqual([{ day: 1, note: "Aだけのメモ" }]);
    expect(await noteShows(b)).toBe(0);
  });

  it("(o) the member route answers at most 30 notes, by day, whatever the item holds", async () => {
    const a = await api.createSession("全部見せる");
    const c = challenge({ startDate: "2026-09-01" });
    const stamps: Record<string, unknown> = {};
    for (let day = TOTAL_DAYS; day >= 1; day--) {
      const note = `${day}日目`.padEnd(LIMITS.note, "あ");
      stamps[String(day)] = { at: day, note, shownNote: note };
    }
    for (const key of ["0", "31", "07", "1.5", "abc"]) stamps[key] = { at: 1, note: "おかしな日", shownNote: "おかしな日" };
    await seed(a, c, stamps);

    const res = await notesOf(c.id);
    expect(res.status).toBe(200);
    const body = await res.text();
    const notes = (JSON.parse(body) as MemberNotesResponse).notes;
    expect(notes.map((n) => n.day)).toEqual(Array.from({ length: TOTAL_DAYS }, (_, i) => i + 1));
    expect(notes.every((n) => n.note.length === LIMITS.note)).toBe(true);
    expect(body).not.toContain("おかしな日");
    expect(Buffer.byteLength(body)).toBeLessThan(16 * 1024);
    expect(await memberOf("2026-09", c.id)).toMatchObject({ shownNoteCount: TOTAL_DAYS });
  });

  it("(p) a stale consent is not revived by typing its old text again", async () => {
    const a = await api.createSession("古い同意");
    const c = challenge();
    await seed(a, c, { "3": { at: 3, note: "書き換えた", shownNote: "書き換える前" } });
    const res = await stamp(a, c.id, 3, { note: "書き換える前" });
    expect(res.status).toBe(200);
    expect((await challengeOf(res)).stamps["3"]).not.toHaveProperty("shown");
    expect(await rawStamp(a, c.id, 3)).not.toHaveProperty("shownNote");
    expect(await visible(c.id)).toEqual([]);
  });

  it("(q) the member route reads the challenge and the owner's progress strongly consistent", async () => {
    const a = await api.createSession("強く読む");
    const ch = await create(a);
    await stampAndShow(a, ch.id, 1, "見せるメモ");
    let notes: MemberNote[] | null = null;
    const reads = await readsDuring(async () => {
      notes = await visible(ch.id);
    });
    expect(notes).toEqual([{ day: 1, note: "見せるメモ" }]);
    // CHREF# only maps the id to its owner (it never changes); the two reads that decide are strong.
    const deciding = reads.filter((r) => !r.Key.pk.startsWith("CHREF#"));
    expect(deciding).toHaveLength(2);
    expect(deciding).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Key: challengeKey(a.user.id, ch.id), ConsistentRead: true }),
        expect.objectContaining({ Key: userKey(a.user.id), ConsistentRead: true }),
      ]),
    );
  });

  it("(r) the visibility route decides from strong reads, also to say why a show failed; a stale copy of progress off does not refuse showing", async () => {
    const a = await api.createSession("すぐ見せる");
    const ch = await create(a);
    await stamp(a, ch.id, 1, { note: "いま書いたメモ" });
    const isChallenge = (r: GetInput) => r.Key.pk === challengeKey(a.user.id, ch.id).pk && r.Key.sk === challengeKey(a.user.id, ch.id).sk;

    // The session's plain read of the user comes from a replica that has not seen progress turned on.
    let res!: Response;
    const reads = await readsDuring(
      async () => {
        res = await show(a, ch.id, 1, "いま書いたメモ");
      },
      (input, out) =>
        input.Key.sk === "PROFILE" && !input.ConsistentRead && out.Item ? { ...out, Item: { ...out.Item, shareProgress: false } } : out,
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await challengeOf(res)).stamps["1"]).toMatchObject({ shown: true });
    expect(reads.filter(isChallenge).map((r) => r.ConsistentRead)).toEqual([true]);
    expect(reads).toContainEqual(expect.objectContaining({ Key: userKey(a.user.id), ConsistentRead: true }));
    expect(await visible(ch.id)).toEqual([{ day: 1, note: "いま書いたメモ" }]);

    // Stopping on a day without a stamp answers from a strong read too.
    const noStamp = await readsDuring(async () => {
      expect((await unshow(a, ch.id, 2)).status).toBe(200);
    });
    expect(noStamp.filter(isChallenge).map((r) => r.ConsistentRead)).toEqual([true]);

    // The note is rewritten on another device between the route's read and its write, so the
    // conditional show fails. A replica that has not seen the rewrite yet would still answer the old
    // text (and the route would say "busy"): only a strong read again says why.
    await stamp(a, ch.id, 2, { note: "ふたつめのメモ" });
    let old: Item | undefined;
    let lost!: Response;
    const raced = await readsDuring(
      async () => {
        lost = await show(a, ch.id, 2, "ふたつめのメモ");
      },
      async (input, out, send) => {
        if (!isChallenge(input)) return out;
        if (old) return input.ConsistentRead ? out : { ...out, Item: old };
        old = out.Item;
        await send(
          new UpdateCommand({
            TableName: api.deps.tableName,
            Key: challengeKey(a.user.id, ch.id),
            UpdateExpression: "SET #stamps.#day.#note = :n",
            ExpressionAttributeNames: { "#stamps": "stamps", "#day": "2", "#note": "note" },
            ExpressionAttributeValues: { ":n": "ほかの端末で書き換え" },
          }),
        );
        return out;
      },
    );
    expect(lost.status).toBe(409);
    expect((await errorOf(lost)).message).toBe(M.noteChanged);
    expect(raced.filter(isChallenge).map((r) => r.ConsistentRead)).toEqual([true, true]);
    expect(await rawStamp(a, ch.id, 2)).not.toHaveProperty("shownNote");

    // Progress really off: still refused.
    expect((await unshow(a, ch.id, 1)).status).toBe(200);
    expect((await setMe(a, { shareProgress: false })).status).toBe(200);
    const off = await show(a, ch.id, 1, "いま書いたメモ");
    expect(off.status).toBe(409);
    expect((await errorOf(off)).message).toBe(M.progressOff);
  });
});
