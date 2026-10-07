/**
 * Lambda "reminder" (EventBridge, every 15 minutes): Web Push to users whose reminder slot is now
 * and who still have an unstamped active challenge today (SPEC FR-14).
 *
 * slot = utcSlotOf(scheduled time) → gsi3 SLOT#<slot> → group by user → for each user: profile + challenges →
 * send to that user's subscriptions on the slot; delete the ones the push service reports gone.
 * Only counts are logged (no endpoints, titles or notes). One failing user never stops the run.
 */
import {
  REMINDER_STEP_MINUTES,
  TOTAL_DAYS,
  challengePhase,
  dayIndex,
  todayIn,
  utcSlotOf,
  type Challenge,
  type User,
} from "@thirty/shared";
import { loadConfig, loadSecrets, type Config, type Secrets } from "./config";
import { listUserChallenges } from "./db/challenges";
import { createDocClient } from "./db/client";
import { deliverToSubscriptions, listSlotSubscriptions, reminderSlot, updateUserSlots } from "./db/push";
import { getUser } from "./db/users";
import type { Item } from "./db/util";
import { log, setLogLevel } from "./log";
import type { Deps } from "./ports";
import { createPushSender } from "./providers/push";

export type ReminderDeps = Pick<Deps, "db" | "tableName" | "now" | "push">;

/** Upper bound of subscriptions handled in one run (a run has 60 s; the service expects ~100 users). */
export const MAX_SUBSCRIPTIONS_PER_RUN = 2000;
/** Users handled in parallel (each sends to ≤ 5 subscriptions at once, 5 s timeout per send). */
const USER_CONCURRENCY = 25;
/** Stop starting new users when the Lambda has less than this left. */
const SAFETY_MARGIN_MS = 8_000;

export type ReminderPayload = { title: string; body: string; url: string; tag: string };

export type ReminderResult = {
  slot: string;
  subscriptions: number;
  users: number;
  notified: number;
  sent: number;
  failed: number;
  gone: number;
  reslotted: number;
  errors: number;
  capped: boolean;
  stoppedEarly: boolean;
};

type LambdaContextLike = { getRemainingTimeInMillis?: () => number };

/** The notification for a user's unstamped active challenges, or null when there are none. */
export function reminderPayload(pending: { title: string; day: number }[]): ReminderPayload | null {
  if (pending.length === 0) return null;
  const body =
    pending.length === 1
      ? `「${pending[0]!.title}」${pending[0]!.day}日目の印がまだです`
      : `今日の印がまだのチャレンジが${pending.length}件あります`;
  return { title: "30日だけ", body, url: "/", tag: "daily-reminder" };
}

/** Active challenges whose day for `today` has no stamp yet. */
export function unstampedToday(challenges: Challenge[], today: string): { title: string; day: number }[] {
  return challenges
    .filter((c) => challengePhase(c, today) === "active")
    .map((c) => ({ c, day: dayIndex(c.startDate, today) }))
    // An unreadable start date gives NaN, which challengePhase cannot rule out on its own.
    .filter(({ c, day }) => Number.isInteger(day) && day >= 1 && day <= TOTAL_DAYS && !c.stamps[String(day)])
    .map(({ c, day }) => ({ title: c.title, day }));
}

function localMinutes(tz: string, now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return get("hour") * 60 + get("minute");
}

/**
 * Whether `now` falls in the user's reminder window (reminder time .. +15 minutes, local time).
 * False after a DST change moved the user's local offset since the slot was computed.
 */
export function isInReminderWindow(user: Pick<User, "tz" | "reminder">, now: Date): boolean {
  const [h, m] = user.reminder.time.split(":").map(Number) as [number, number];
  const diff = (((localMinutes(user.tz, now) - (h * 60 + m)) % 1440) + 1440) % 1440;
  return diff < REMINDER_STEP_MINUTES;
}

function groupByUser(items: Item[]): Map<string, Item[]> {
  const byUser = new Map<string, Item[]>();
  for (const item of items) {
    const pk = String(item.pk);
    if (!pk.startsWith("USER#")) continue;
    const uid = pk.slice("USER#".length);
    const list = byUser.get(uid);
    if (list) list.push(item);
    else byUser.set(uid, [item]);
  }
  return byUser;
}

/**
 * The moment this run is for: the EventBridge event's scheduled `time` when present, so a delayed
 * or duplicated delivery still handles its own slot (not the one the clock has moved on to).
 */
export function scheduledTime(event: unknown, fallback: Date): Date {
  const time = (event as { time?: unknown } | null | undefined)?.time;
  const ms = typeof time === "string" ? Date.parse(time) : NaN;
  return Number.isFinite(ms) ? new Date(ms) : fallback;
}

/** Build the job with injected deps (tests pass dynalite, a fake sender and a fixed clock). */
export function makeReminderHandler(deps: ReminderDeps) {
  return async (event?: unknown, context?: LambdaContextLike): Promise<ReminderResult> => {
    const now = scheduledTime(event, deps.now());
    const slot = utcSlotOf(now, REMINDER_STEP_MINUTES);
    const result: ReminderResult = {
      slot,
      subscriptions: 0,
      users: 0,
      notified: 0,
      sent: 0,
      failed: 0,
      gone: 0,
      reslotted: 0,
      errors: 0,
      capped: false,
      stoppedEarly: false,
    };

    const { items, capped } = await listSlotSubscriptions(deps, slot, MAX_SUBSCRIPTIONS_PER_RUN);
    result.subscriptions = items.length;
    result.capped = capped;
    if (capped) log.warn("reminder: subscription cap reached", { slot, cap: MAX_SUBSCRIPTIONS_PER_RUN });
    const byUser = groupByUser(items);
    result.users = byUser.size;

    const processUser = async (uid: string, subs: Item[]) => {
      const user = await getUser(deps, uid);
      if (!user) return; // deleted meanwhile; account deletion removes the subscriptions
      if (!user.reminder.enabled) {
        await updateUserSlots(deps, uid, null);
        result.reslotted++;
        return;
      }
      if (!isInReminderWindow(user, now)) {
        // The local offset changed (DST) since the slot was computed: move to the right slot.
        await updateUserSlots(deps, uid, reminderSlot(user, now));
        result.reslotted++;
        return;
      }
      const pending = unstampedToday(await listUserChallenges(deps, uid), todayIn(user.tz, now));
      const payload = reminderPayload(pending);
      if (!payload) return;
      const res = await deliverToSubscriptions(deps, uid, subs, payload);
      result.notified++;
      result.sent += res.sent;
      result.failed += res.failed;
      result.gone += res.gone;
    };

    const users = [...byUser.entries()];
    for (let i = 0; i < users.length; i += USER_CONCURRENCY) {
      const remaining = context?.getRemainingTimeInMillis?.();
      if (remaining !== undefined && remaining < SAFETY_MARGIN_MS) {
        result.stoppedEarly = true;
        log.warn("reminder: stopped before the Lambda timeout", { slot, left: users.length - i });
        break;
      }
      await Promise.all(
        users.slice(i, i + USER_CONCURRENCY).map(async ([uid, subs]) => {
          try {
            await processUser(uid, subs);
          } catch (err) {
            result.errors++;
            log.warn("reminder: user failed", { uid, errName: (err as Error | undefined)?.name });
          }
        }),
      );
    }

    log.info("reminder run", { ...result });
    return result;
  };
}

// ---------- Lambda entry ----------

let lambda: { config: Config; secrets: Secrets; run: ReturnType<typeof makeReminderHandler> } | undefined;

/** Built on the first invocation (not at import), so tests can import this module freely. */
export const handler = async (event?: unknown, context?: LambdaContextLike): Promise<void> => {
  if (!lambda) {
    const config = loadConfig();
    setLogLevel(config.logLevel);
    const secrets: Secrets = {};
    const deps: ReminderDeps = {
      db: createDocClient({ region: config.region, endpoint: config.dynamoEndpoint }),
      tableName: config.tableName,
      now: () => new Date(),
      push: createPushSender(config, secrets),
    };
    lambda = { config, secrets, run: makeReminderHandler(deps) };
  }
  // The sender reads the private key from this object at send time.
  Object.assign(lambda.secrets, await loadSecrets(lambda.config));
  await lambda.run(event, context);
};
