import { Hono } from "hono";
import { API, PushSubscriptionSchema, PushUnsubscribeSchema, QUOTAS, type PushPublicKeyResponse } from "@thirty/shared";
import { requireUser } from "../auth";
import {
  deletePushSubscription,
  deliverToSubscriptions,
  listPushItems,
  prunePushSubscriptions,
  pushHash,
  reminderSlot,
  savePushSubscription,
} from "../db/push";
import { enforceQuota } from "../db/rate";
import { badRequest, conflict } from "../errors";
import { log } from "../log";
import type { Deps } from "../ports";
import { isAllowedPushEndpoint } from "../providers/push";
import type { AppEnv } from "../types";
import { readJson } from "../validate";

const ENDPOINT_NOT_ALLOWED = "この通知の宛先には対応していません。対応しているブラウザで通知を許可してください";
const NO_SUBSCRIPTION = "この端末の通知が登録されていません。先に通知を許可してください";

export const TEST_PUSH_PAYLOAD = {
  title: "30日だけ",
  body: "テスト通知です。この時刻にリマインドが届きます。",
  url: "/",
} as const;

/**
 * Web Push reminders (FR-14).
 *   GET    /api/push/public-key     → PushPublicKeyResponse
 *   POST   /api/push/subscriptions  PushSubscriptionInput → 204 (requireUser)
 *   DELETE /api/push/subscriptions  PushUnsubscribe → 204 (requireUser; DELETE with a JSON body)
 *   POST   /api/push/test           → 204, 409 when the user has no subscription (requireUser)
 *
 * Endpoints never appear in responses or logs.
 */
export function pushRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  const auth = requireUser(deps);

  r.get(API.pushPublicKey, (c) => c.json<PushPublicKeyResponse>({ publicKey: deps.config.vapidPublicKey ?? null }));

  r.post(API.pushSubscriptions, auth, async (c) => {
    const sub = await readJson(c, PushSubscriptionSchema);
    if (!isAllowedPushEndpoint(sub.endpoint)) throw badRequest(ENDPOINT_NOT_ALLOWED, { endpoint: ENDPOINT_NOT_ALLOWED });
    const user = c.var.user;
    const { hash, created } = await savePushSubscription(deps, user.id, sub, reminderSlot(user, deps.now()));
    const pruned = await prunePushSubscriptions(deps, user.id, hash);
    log.info("push subscribed", { uid: user.id, created, pruned });
    return c.body(null, 204);
  });

  r.delete(API.pushSubscriptions, auth, async (c) => {
    const { endpoint } = await readJson(c, PushUnsubscribeSchema);
    const existed = await deletePushSubscription(deps, c.var.uid, pushHash(endpoint));
    log.info("push unsubscribed", { uid: c.var.uid, existed });
    return c.body(null, 204);
  });

  r.post(API.pushTest, auth, async (c) => {
    const uid = c.var.uid;
    const items = await listPushItems(deps, uid);
    if (items.length === 0) throw conflict(NO_SUBSCRIPTION);
    await enforceQuota(deps, "push-test", uid, QUOTAS.pushTestsPerUserPerDay, "day");
    const res = await deliverToSubscriptions(deps, uid, items, TEST_PUSH_PAYLOAD);
    log.info("push test", { uid, ...res });
    // Every subscription turned out to be gone: the browser has to subscribe again.
    if (res.gone === items.length) throw conflict(NO_SUBSCRIPTION);
    return c.body(null, 204);
  });

  return r;
}
