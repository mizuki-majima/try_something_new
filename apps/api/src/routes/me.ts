import { Hono } from "hono";
import {
  API,
  BackupFileSchema,
  MePatchSchema,
  QUOTAS,
  REMINDER_STEP_MINUTES,
  todayIn,
  type BackupFile,
  type ImportResponse,
  type MeResponse,
  type TransferCodeResponse,
  type User,
} from "@thirty/shared";
import { forgetTokens, requireUser } from "../auth";
import { exportBackup, importBackup } from "../backup";
import { deleteAccount } from "../db/account";
import { syncUserProjection } from "../db/challenges";
import { acquireLock, releaseLock } from "../db/lock";
import { reminderSlot, updateUserSlots } from "../db/push";
import { enforceQuota } from "../db/rate";
import { createTransferCode, updateUser, type UserPatch } from "../db/users";
import { conflict, unauthorized } from "../errors";
import { log } from "../log";
import type { Deps } from "../ports";
import type { AppEnv } from "../types";
import { readJson } from "../validate";

/** Rate-limit scope of QUOTAS.profileChangesPerUserPerDay. */
export const PROFILE_CHANGE_SCOPE = "profile-change";

/** One import per user at a time (NF-5); the lock expires on its own after this long. */
export const IMPORT_LOCK_SECONDS = 60;
export const IMPORT_BUSY = "読み込み中です。少し待ってからもう一度お試しください";

/** The scheduler runs on a REMINDER_STEP_MINUTES grid, so off-grid times would never fire. */
export function floorToStep(time: string): string {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const floored = m - (m % REMINDER_STEP_MINUTES);
  return `${String(h).padStart(2, "0")}:${String(floored).padStart(2, "0")}`;
}

export function meRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  const auth = requireUser(deps);
  const meResponse = (user: User): MeResponse => ({ user, today: todayIn(user.tz, deps.now()) });

  r.get(API.me, auth, (c) => c.json<MeResponse>(meResponse(c.var.user)));

  r.patch(API.me, auth, async (c) => {
    const input = await readJson(c, MePatchSchema);
    const before = c.var.user;
    // A nickname or shareProgress change rewrites the cohort projection of the user's challenges:
    // bounded per day (cost, NF-1). Changing the reminder or time zone, or sending the same value, is free.
    const changesProfile =
      (input.nickname !== undefined && input.nickname !== before.nickname) ||
      (input.shareProgress !== undefined && input.shareProgress !== before.shareProgress);
    if (changesProfile) await enforceQuota(deps, PROFILE_CHANGE_SCOPE, before.id, QUOTAS.profileChangesPerUserPerDay, "day");
    const patch: UserPatch = {
      ...input,
      ...(input.reminder ? { reminder: { enabled: input.reminder.enabled, time: floorToStep(input.reminder.time) } } : {}),
    };
    const user = await updateUser(deps, before.id, patch);
    if (!user) throw unauthorized();

    if (user.nickname !== before.nickname || user.shareProgress !== before.shareProgress) {
      await syncUserProjection(deps, user.id, { nickname: user.nickname, shareProgress: user.shareProgress });
    }
    if (input.tz !== undefined || input.reminder !== undefined) {
      await updateUserSlots(deps, user.id, reminderSlot(user, deps.now()));
    }
    return c.json<MeResponse>(meResponse(user));
  });

  r.delete(API.me, auth, async (c) => {
    const { tokenHashes, deletedItems } = await deleteAccount(deps, c.var.uid);
    forgetTokens(tokenHashes);
    log.info("account deleted", { uid: c.var.uid, deletedItems });
    return c.body(null, 204);
  });

  r.post(API.meTransferCode, auth, async (c) => {
    await enforceQuota(deps, "transfer-code", c.var.uid, QUOTAS.transferCodesPerUserPerHour, "hour");
    const res = await createTransferCode(deps, c.var.uid);
    return c.json<TransferCodeResponse>(res, 201);
  });

  r.get(API.meExport, auth, async (c) => c.json<BackupFile>(await exportBackup(deps, c.var.user)));

  r.post(API.meImport, auth, async (c) => {
    const file = await readJson(c, BackupFileSchema);
    // Serialised per user: the free room (open / total challenges) is read once per import, so two
    // at the same time would each fill it (NF-5). A busy lock is not counted against the quota.
    const lock = await acquireLock(deps, "import", c.var.uid, IMPORT_LOCK_SECONDS);
    if (!lock) throw conflict(IMPORT_BUSY);
    try {
      await enforceQuota(deps, "import", c.var.uid, QUOTAS.importsPerUserPerDay, "day");
      const res = await importBackup(deps, c.var.user, file);
      log.info("backup imported", { uid: c.var.uid, ...res });
      return c.json<ImportResponse>(res);
    } finally {
      await releaseLock(deps, "import", c.var.uid, lock);
    }
  });

  return r;
}
