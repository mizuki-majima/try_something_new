import { Hono } from "hono";
import { API, QUOTAS, SessionCreateSchema, TransferRedeemSchema, type SessionResponse } from "@thirty/shared";
import { clientIpHash, newToken, sha256 } from "../auth";
import { enforceQuota } from "../db/rate";
import { bumpStats } from "../db/stats";
import { createUser, getUser, putToken, redeemTransferCode } from "../db/users";
import { badRequest } from "../errors";
import { log } from "../log";
import type { Deps } from "../ports";
import type { AppEnv } from "../types";
import { readJson } from "../validate";

const INVALID_CODE = "引き継ぎコードが正しくないか、有効期限（15分）が切れています。もう一度発行してください";

export function sessionRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();

  // Anonymous account (FR-1).
  r.post(API.session, async (c) => {
    const input = await readJson(c, SessionCreateSchema);
    await enforceQuota(deps, "session-ip", clientIpHash(deps, c), QUOTAS.sessionsPerIpPerHour, "hour");
    const user = await createUser(deps, input);
    const token = newToken();
    await putToken(deps, user.id, sha256(token));
    await bumpStats(deps, { users: 1 });
    log.info("session created", { uid: user.id });
    return c.json<SessionResponse>({ token, user }, 201);
  });

  // Device hand-over (FR-2): a one-time code gives this device a new token for the same user.
  r.post(API.sessionTransfer, async (c) => {
    const { code } = await readJson(c, TransferRedeemSchema);
    // Counted before the lookup so guessing codes is throttled.
    await enforceQuota(deps, "transfer-redeem-ip", clientIpHash(deps, c), QUOTAS.transferRedeemPerIpPerHour, "hour");
    const uid = await redeemTransferCode(deps, code);
    const user = uid ? await getUser(deps, uid) : undefined;
    if (!user) throw badRequest(INVALID_CODE, { code: INVALID_CODE });
    const token = newToken();
    await putToken(deps, user.id, sha256(token));
    log.info("session transferred", { uid: user.id });
    return c.json<SessionResponse>({ token, user }, 200);
  });

  return r;
}
