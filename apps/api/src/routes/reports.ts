import { Hono } from "hono";
import { API, AUTO_HIDE_MIN_NETWORKS, AUTO_HIDE_REPORTS, ContactCreateSchema, QUOTAS, ReportCreateSchema } from "@thirty/shared";
import { clientIpHash, clientNetworkHash, optionalUser, requireUser } from "../auth";
import { createContact } from "../db/contacts";
import { enforceQuota } from "../db/rate";
import { addReport, countReporterNetworks, hideTarget, isTrustedReporter, resolveTarget } from "../db/reports";
import { badRequest, notFound } from "../errors";
import { log } from "../log";
import type { Deps } from "../ports";
import { viewer, type AppEnv } from "../types";
import { readJson } from "../validate";

const TARGET_NOT_FOUND = "通報する対象が見つかりませんでした";
const OWN_CONTENT = "自分の投稿や記録は通報できません";

/**
 * Reports and contact (FR-18, FR-19).
 *   POST /api/reports  ReportCreate → 204 (requireUser)
 *   POST /api/contact  ContactCreate → 204 (optionalUser)
 *
 * Reporter markers (REPORT#…/BY#<uid>) carry gsi2 AUTHOR#<uid>, so DELETE /api/me removes them.
 */
export function reportsRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();

  r.post(API.reports, requireUser(deps), async (c) => {
    const input = await readJson(c, ReportCreateSchema);
    // Counted before the lookup, so probing ids (and reading story partitions) is bounded too.
    await enforceQuota(deps, "report", c.var.uid, QUOTAS.reportsPerUserPerDay, "day");
    const target = await resolveTarget(deps, input.targetType, input.targetId);
    if (!target) throw notFound(TARGET_NOT_FOUND);
    if (target.ownerId === c.var.uid) throw badRequest(OWN_CONTENT);

    // Brand-new or empty accounts are recorded but do not count towards auto-hide (see isTrustedReporter).
    const trusted = await isTrustedReporter(deps, c.var.user);
    const net = trusted ? clientNetworkHash(deps, c) : undefined;
    const tally = await addReport(deps, { uid: c.var.uid, trusted, net }, target, input.reason || undefined);
    if (trusted && tally && tally.trustedCount >= AUTO_HIDE_REPORTS && target.status === "published") {
      // ...and only when those reporters are not all on one network (security-4).
      const networks = await countReporterNetworks(deps, target.type, target.id, tally.since);
      if (networks >= AUTO_HIDE_MIN_NETWORKS) {
        await hideTarget(deps, target);
        log.info("auto-hidden after reports", { targetType: target.type, count: tally.trustedCount, networks });
      } else {
        // Left to the moderator (GET /api/admin/reports lists it).
        log.warn("auto-hide held: the reporters share one network", { targetType: target.type, count: tally.trustedCount, networks });
      }
    }
    return c.body(null, 204);
  });

  r.post(API.contact, optionalUser(deps), async (c) => {
    const input = await readJson(c, ContactCreateSchema);
    const user = viewer(c);
    const key = user ? `user:${user.id}` : `ip:${clientIpHash(deps, c)}`;
    await enforceQuota(deps, "contact", key, QUOTAS.contactPerUserPerDay, "day");
    await createContact(deps, { message: input.message, replyTo: input.replyTo || undefined });
    log.info("contact received", { signedIn: user !== undefined });
    return c.body(null, 204);
  });

  return r;
}
