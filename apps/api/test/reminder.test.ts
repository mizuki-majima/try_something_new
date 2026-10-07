import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it } from "vitest";
import { newId, type Challenge, type SessionResponse } from "@thirty/shared";
import { toChallengeItem } from "../src/db/challenges";
import type { Db } from "../src/db/client";
import { pushKey, pushSlotGsi3 } from "../src/db/keys";
import { listSlotSubscriptions, pushHash } from "../src/db/push";
import { getStats } from "../src/db/stats";
import type { PushSender, PushTarget } from "../src/ports";
import { isInReminderWindow, makeReminderHandler, reminderPayload, scheduledTime, unstampedToday } from "../src/reminder";
import { setupApi } from "./helpers";

class FakeSender implements PushSender {
  readonly sent: { sub: PushTarget; payload: object }[] = [];
  readonly gone = new Set<string>();
  readonly failing = new Set<string>();

  async send(sub: PushTarget, payload: object) {
    if (this.failing.has(sub.endpoint)) throw new Error("network down");
    this.sent.push({ sub, payload });
    return this.gone.has(sub.endpoint) ? { ok: false, gone: true } : { ok: true, gone: false };
  }

  to(endpoints: string[]) {
    return this.sent.filter((m) => endpoints.includes(m.sub.endpoint));
  }
}

const api = setupApi();
let sender: FakeSender;

beforeEach(() => {
  sender = new FakeSender();
});

const run = (db?: Db) => makeReminderHandler({ ...api.deps, ...(db ? { db } : {}), push: sender })();

const KEYS = { p256dh: "B".repeat(87), auth: "a".repeat(22) };
const endpoint = () => `https://fcm.googleapis.com/fcm/send/${newId(24)}`;

function challenge(overrides: Partial<Challenge> = {}): Challenge {
  const now = api.clock.now().getTime();
  return {
    id: newId(16),
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
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const stamp = (at = 0) => ({ at });

/** A user with the reminder on at `time` (local), `subs` push subscriptions and the given challenges. */
async function seedUser(opts: { tz?: string; time?: string; enabled?: boolean; subs?: number; challenges?: Challenge[] }) {
  const s: SessionResponse = await api.createSession(undefined, opts.tz ?? "Asia/Tokyo");
  const reminder = { enabled: opts.enabled ?? true, time: opts.time ?? "21:00" };
  const patched = await api.request("/api/me", { method: "PATCH", token: s.token, body: { reminder } });
  expect(patched.status).toBe(200);
  const endpoints: string[] = [];
  for (let i = 0; i < (opts.subs ?? 1); i++) {
    const ep = endpoint();
    const res = await api.request("/api/push/subscriptions", { token: s.token, body: { endpoint: ep, keys: KEYS } });
    expect(res.status).toBe(204);
    endpoints.push(ep);
  }
  for (const c of opts.challenges ?? []) {
    await api.deps.db.send(new PutCommand({ TableName: api.deps.tableName, Item: toChallengeItem(s.user.id, s.user, c) }));
  }
  return { ...s, endpoints };
}

const getPush = async (uid: string, ep: string) =>
  (await api.deps.db.send(new GetCommand({ TableName: api.deps.tableName, Key: pushKey(uid, pushHash(ep)) }))).Item;

describe("reminder helpers", () => {
  it("builds the notification body for one or several challenges", () => {
    expect(reminderPayload([])).toBeNull();
    expect(reminderPayload([{ title: "毎日20分歩く", day: 3 }])).toEqual({
      title: "30日だけ",
      body: "「毎日20分歩く」3日目の印がまだです",
      url: "/",
      tag: "daily-reminder",
    });
    expect(reminderPayload([{ title: "a", day: 1 }, { title: "b", day: 9 }])?.body).toBe("今日の印がまだのチャレンジが2件あります");
  });

  it("only counts active challenges whose day is not stamped", () => {
    const today = "2026-10-06";
    const list = [
      challenge({ title: "未", startDate: "2026-10-01" }),
      challenge({ title: "済", startDate: "2026-10-01", stamps: { "6": stamp() } }),
      challenge({ title: "昨日だけ", startDate: "2026-10-01", stamps: { "5": stamp() } }),
      challenge({ title: "予約", startDate: "2026-11-01" }),
      challenge({ title: "終わり", startDate: "2026-08-01" }),
      challenge({ title: "振り返り済み", startDate: "2026-10-01", status: "done", verdict: "stop" }),
    ];
    expect(unstampedToday(list, today)).toEqual([
      { title: "未", day: 6 },
      { title: "昨日だけ", day: 6 },
    ]);
  });

  it("checks the local reminder window (reminder time + 15 minutes)", () => {
    const user = { tz: "Asia/Tokyo", reminder: { enabled: true, time: "21:00" } };
    expect(isInReminderWindow(user, new Date("2026-10-06T12:00:00Z"))).toBe(true);
    expect(isInReminderWindow(user, new Date("2026-10-06T12:14:59Z"))).toBe(true);
    expect(isInReminderWindow(user, new Date("2026-10-06T12:15:00Z"))).toBe(false);
    expect(isInReminderWindow(user, new Date("2026-10-06T11:59:00Z"))).toBe(false);
    const midnight = { tz: "Asia/Tokyo", reminder: { enabled: true, time: "00:00" } };
    expect(isInReminderWindow(midnight, new Date("2026-10-06T15:05:00Z"))).toBe(true);
  });
});

describe("reminder job: the scheduled time", () => {
  it("reads EventBridge's scheduled time, falling back to the clock", () => {
    const fallback = new Date("2026-10-07T12:20:00Z");
    expect(scheduledTime({ time: "2026-10-07T12:00:00Z" }, fallback).toISOString()).toBe("2026-10-07T12:00:00.000Z");
    for (const event of [undefined, null, {}, { time: "soon" }, { time: 42 }, "x"]) expect(scheduledTime(event, fallback)).toBe(fallback);
  });

  it("a delayed delivery handles its own slot, not the one the clock has moved on to", async () => {
    api.clock.set("2026-10-07T03:00:00.000Z");
    const at2100 = await seedUser({ time: "21:00", challenges: [challenge({ startDate: "2026-10-01" })] });
    const at2115 = await seedUser({ time: "21:15", challenges: [challenge({ startDate: "2026-10-01" })] });

    // The 12:00 UTC (21:00 JST) event arrives 20 minutes late.
    api.clock.set("2026-10-07T12:20:00.000Z");
    const late = await makeReminderHandler({ ...api.deps, push: sender })({ "detail-type": "Scheduled Event", time: "2026-10-07T12:00:00Z" });
    expect(late.slot).toBe("12:00");
    expect(sender.to(at2100.endpoints)).toHaveLength(1);
    expect(sender.to(at2115.endpoints)).toEqual([]);

    // The 12:15 event (on time or late) is still the 21:15 users' run.
    const next = await makeReminderHandler({ ...api.deps, push: sender })({ time: "2026-10-07T12:15:00Z" });
    expect(next.slot).toBe("12:15");
    expect(sender.to(at2115.endpoints)).toHaveLength(1);
    expect(sender.to(at2100.endpoints)).toHaveLength(1);
  });
});

describe("reminder job", () => {
  it("notifies only users at this slot with an unstamped active challenge today", async () => {
    api.clock.set("2026-10-06T03:00:00.000Z"); // 12:00 JST
    const one = await seedUser({ challenges: [challenge({ startDate: "2026-10-01", stamps: { "1": stamp() } })] });
    const several = await seedUser({
      subs: 2,
      challenges: [challenge({ startDate: "2026-10-01" }), challenge({ title: "3行日記", startDate: "2026-10-05" })],
    });
    const stamped = await seedUser({ challenges: [challenge({ startDate: "2026-10-01", stamps: { "6": stamp() } })] });
    const notActive = await seedUser({
      challenges: [
        challenge({ startDate: "2026-11-01" }), // waiting
        challenge({ startDate: "2026-08-01" }), // ended, not reflected yet
        challenge({ startDate: "2026-10-01", status: "done", verdict: "continue" }),
      ],
    });
    const noChallenges = await seedUser({});
    const laterSlot = await seedUser({ time: "22:00", challenges: [challenge()] });
    const off = await seedUser({ enabled: false, challenges: [challenge()] });

    api.clock.set("2026-10-06T12:05:00.000Z"); // 21:05 JST
    const result = await run();
    expect(result.slot).toBe("12:00");

    const oneMsgs = sender.to(one.endpoints);
    expect(oneMsgs).toHaveLength(1);
    expect(oneMsgs[0]!.payload).toEqual({ title: "30日だけ", body: "「毎日1枚、写真を撮る」6日目の印がまだです", url: "/", tag: "daily-reminder" });
    expect(oneMsgs[0]!.sub).toEqual({ endpoint: one.endpoints[0], keys: KEYS });

    const severalMsgs = sender.to(several.endpoints);
    expect(severalMsgs.map((m) => m.sub.endpoint).sort()).toEqual([...several.endpoints].sort());
    for (const m of severalMsgs) {
      expect(m.payload).toEqual({ title: "30日だけ", body: "今日の印がまだのチャレンジが2件あります", url: "/", tag: "daily-reminder" });
    }

    for (const u of [stamped, notActive, noChallenges, laterSlot, off]) expect(sender.to(u.endpoints)).toEqual([]);
    expect(result.notified).toBeGreaterThanOrEqual(2);
    expect(result.sent).toBeGreaterThanOrEqual(3);

    // The 22:00 user is picked up by the next-hour slot.
    sender.sent.length = 0;
    api.clock.set("2026-10-06T13:00:30.000Z");
    expect((await run()).slot).toBe("13:00");
    expect(sender.to(laterSlot.endpoints)).toHaveLength(1);
    expect(sender.to(one.endpoints)).toEqual([]);
  });

  it("moves a user whose slot drifted with DST instead of notifying at the wrong local time", async () => {
    api.clock.set("2026-10-20T03:00:00.000Z"); // EDT (UTC-4)
    const ny = await seedUser({ tz: "America/New_York", time: "21:00", challenges: [challenge({ startDate: "2026-10-25" })] });
    expect((await getPush(ny.user.id, ny.endpoints[0]!))?.gsi3pk).toBe("SLOT#01:00");

    // 2026-11-01 DST ends: 01:00 UTC is now 20:00 EST.
    api.clock.set("2026-11-03T01:00:00.000Z");
    const drift = await run();
    expect(sender.to(ny.endpoints)).toEqual([]);
    expect(drift.reslotted).toBeGreaterThanOrEqual(1);
    expect(await getPush(ny.user.id, ny.endpoints[0]!)).toMatchObject({ gsi3pk: "SLOT#02:00", gsi3sk: `${ny.user.id}#${pushHash(ny.endpoints[0]!)}` });

    // 02:00 UTC = 21:00 EST on 11/2 (day 9 of a challenge that started 10/25).
    api.clock.set("2026-11-03T02:00:00.000Z");
    await run();
    const msgs = sender.to(ny.endpoints);
    expect(msgs).toHaveLength(1);
    expect((msgs[0]!.payload as { body: string }).body).toBe("「毎日1枚、写真を撮る」9日目の印がまだです");
  });

  it("takes stale subscriptions of a user whose reminder is off off the schedule", async () => {
    api.clock.set("2026-10-06T03:00:00.000Z");
    const u = await seedUser({ enabled: false, challenges: [challenge()] });
    const hash = pushHash(u.endpoints[0]!);
    // Left on a slot by an older version or a race with PATCH /api/me.
    await api.deps.db.send(
      new PutCommand({
        TableName: api.deps.tableName,
        Item: { ...pushKey(u.user.id, hash), ...pushSlotGsi3("09:00", u.user.id, hash), type: "push", endpoint: u.endpoints[0], keys: KEYS, createdAt: 0 },
      }),
    );
    api.clock.set("2026-10-06T09:00:00.000Z");
    await run();
    expect(sender.to(u.endpoints)).toEqual([]);
    expect((await getPush(u.user.id, u.endpoints[0]!))?.gsi3pk).toBeUndefined();
  });

  it("deletes subscriptions the push service reports as gone", async () => {
    api.clock.set("2026-10-06T03:00:00.000Z");
    const u = await seedUser({ time: "20:00", subs: 2, challenges: [challenge()] });
    const [alive, dead] = u.endpoints as [string, string];
    sender.gone.add(dead);
    const before = (await getStats(api.deps)).pushSubscriptions;

    api.clock.set("2026-10-06T11:00:00.000Z"); // 20:00 JST
    const result = await run();
    expect(result.gone).toBeGreaterThanOrEqual(1);
    expect(await getPush(u.user.id, dead)).toBeUndefined();
    expect(await getPush(u.user.id, alive)).toBeDefined();
    expect(sender.to([alive])).toHaveLength(1);
    expect((await getStats(api.deps)).pushSubscriptions).toBe(before - 1);
  });

  it("never throws for one bad user or subscription and carries on with the others", async () => {
    api.clock.set("2026-10-06T03:00:00.000Z");
    const throwing = await seedUser({ time: "19:00", challenges: [challenge()] });
    const broken = await seedUser({ time: "19:00", challenges: [challenge()] });
    const fine = await seedUser({ time: "19:00", challenges: [challenge()] });
    sender.failing.add(throwing.endpoints[0]!);
    // A subscription whose user no longer exists, and one with a damaged item.
    const ghostHash = "f".repeat(64);
    await api.deps.db.send(
      new PutCommand({
        TableName: api.deps.tableName,
        Item: { ...pushKey("ghostuser0000000", ghostHash), ...pushSlotGsi3("10:00", "ghostuser0000000", ghostHash), type: "push", endpoint: endpoint(), keys: KEYS },
      }),
    );
    const damagedHash = "e".repeat(64);
    await api.deps.db.send(
      new PutCommand({
        TableName: api.deps.tableName,
        Item: { ...pushKey(fine.user.id, damagedHash), ...pushSlotGsi3("10:00", fine.user.id, damagedHash), type: "push" },
      }),
    );
    // Reading one user's profile fails.
    const flaky = {
      send: (cmd: { input?: { Key?: { pk?: string; sk?: string } } }) => {
        const key = cmd.input?.Key;
        if (key?.pk === `USER#${broken.user.id}` && key.sk === "PROFILE") return Promise.reject(new Error("throttled"));
        return api.deps.db.send(cmd as never);
      },
    } as unknown as Db;

    api.clock.set("2026-10-06T10:00:00.000Z"); // 19:00 JST
    const result = await run(flaky);
    expect(result.errors).toBe(1);
    expect(sender.to(fine.endpoints)).toHaveLength(1);
    expect(sender.to(broken.endpoints)).toEqual([]);
    expect(result.failed).toBeGreaterThanOrEqual(2); // the throwing sender + the damaged item
  });

  it("reads at most `cap` subscriptions of a slot", async () => {
    for (let i = 0; i < 5; i++) {
      const uid = `capuser${String(i).padStart(9, "0")}`;
      const hash = String(i).repeat(64);
      await api.deps.db.send(
        new PutCommand({
          TableName: api.deps.tableName,
          Item: { ...pushKey(uid, hash), ...pushSlotGsi3("03:45", uid, hash), type: "push", endpoint: endpoint(), keys: KEYS },
        }),
      );
    }
    expect(await listSlotSubscriptions(api.deps, "03:45", 3)).toMatchObject({ capped: true, items: { length: 3 } });
    expect(await listSlotSubscriptions(api.deps, "03:45", 5)).toMatchObject({ capped: false, items: { length: 5 } });
    expect(await listSlotSubscriptions(api.deps, "03:45", 100)).toMatchObject({ capped: false, items: { length: 5 } });
    expect(await listSlotSubscriptions(api.deps, "03:30", 100)).toEqual({ capped: false, items: [] });
  });

  it("stops starting new users when the Lambda is about to time out", async () => {
    api.clock.set("2026-10-06T03:00:00.000Z");
    const u = await seedUser({ time: "17:00", challenges: [challenge()] });
    api.clock.set("2026-10-06T08:00:00.000Z");
    const handler = makeReminderHandler({ ...api.deps, push: sender });
    const result = await handler({}, { getRemainingTimeInMillis: () => 1_000 });
    expect(result.stoppedEarly).toBe(true);
    expect(sender.to(u.endpoints)).toEqual([]);
  });
});
