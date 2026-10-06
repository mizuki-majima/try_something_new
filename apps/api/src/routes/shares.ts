import { Hono } from "hono";
import {
  API,
  ID_RE,
  LIMITS,
  ShareCreateSchema,
  ShareMetricSchema,
  QUOTAS,
  shareImagePath,
  sharePagePath,
  type ShareResponse,
} from "@thirty/shared";
import { clientIpHash, requireUser } from "../auth";
import { getChallengeItem, toChallenge } from "../db/challenges";
import { enforceQuota } from "../db/rate";
import { countShareAction, createShare, deleteShare, getShareItem, toShareView } from "../db/shares";
import { bumpStats } from "../db/stats";
import { badRequest, conflict, HttpError, notFound } from "../errors";
import { log } from "../log";
import { decodeBase64Strict, isShareCardPng } from "../png";
import type { Deps } from "../ports";
import { publicOrigin, renderShareNotFound, renderSharePage, SHARE_PAGE_CSP } from "../share-page";
import type { AppContext, AppEnv } from "../types";
import { readJson } from "../validate";

/** Anonymous share-action counts per IP hash and JST day (keeps the pilot metric honest). */
export const SHARE_METRICS_PER_IP_PER_DAY = 100;

const SHARE_NOT_FOUND = "共有カードが見つかりませんでした";
const CHALLENGE_NOT_FOUND = "チャレンジが見つかりませんでした";
const NOT_DONE = "振り返りを終えたチャレンジだけ共有できます";
const BAD_IMAGE = "カード画像の形式が正しくありません（1200×630 の PNG）";
const IMAGE_TOO_LARGE = "カード画像が大きすぎます（600KBまで）";

function htmlResponse(c: AppContext, html: string, status: 200 | 404): Response {
  return c.body(html, status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": SHARE_PAGE_CSP,
    "X-Content-Type-Options": "nosniff",
  });
}

/**
 * Share cards (FR-7, CUF-2).
 *   POST   /api/shares          ShareCreate → 201 ShareResponse (requireUser)
 *   DELETE /api/shares/:id      → 204 (owner)
 *   POST   /api/metrics/share   ShareMetric → 204 (anonymous; per-IP quota)
 *   GET    /s/:id               public HTML page with OGP tags (everything HTML-escaped)
 */
export function sharesRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  const auth = requireUser(deps);

  r.post(API.shares, auth, async (c) => {
    const input = await readJson(c, ShareCreateSchema);
    const item = await getChallengeItem(deps, c.var.uid, input.challengeId);
    if (!item) throw notFound(CHALLENGE_NOT_FOUND);
    const challenge = toChallenge(item);
    if (challenge.status !== "done") throw conflict(NOT_DONE);

    const png = decodeBase64Strict(input.imageBase64);
    if (!png) throw badRequest(BAD_IMAGE, { imageBase64: BAD_IMAGE });
    if (png.byteLength > LIMITS.shareImageBytes) throw new HttpError(413, "payload_too_large", IMAGE_TOO_LARGE);
    if (!isShareCardPng(png)) throw badRequest(BAD_IMAGE, { imageBase64: BAD_IMAGE });

    await enforceQuota(deps, "share", c.var.uid, QUOTAS.sharesPerUserPerDay, "day");
    const id = await createShare(deps, c.var.user, challenge, png);
    if (!id) throw notFound(CHALLENGE_NOT_FOUND);
    await bumpStats(deps, { shares: 1 });
    log.info("share created", { uid: c.var.uid, share: id });

    const origin = publicOrigin(c);
    return c.json<ShareResponse>({ id, url: origin + sharePagePath(id), imageUrl: origin + shareImagePath(id) }, 201);
  });

  r.delete(API.share(":id"), auth, async (c) => {
    const sid = c.req.param("id") ?? "";
    const item = ID_RE.test(sid) ? await getShareItem(deps, sid) : undefined;
    if (!item || item.userId !== c.var.uid) throw notFound(SHARE_NOT_FOUND);
    await deleteShare(deps, item);
    log.info("share deleted", { uid: c.var.uid, share: sid });
    return c.body(null, 204);
  });

  r.post(API.shareMetric, async (c) => {
    const { channel } = await readJson(c, ShareMetricSchema);
    await enforceQuota(deps, "share-metric-ip", clientIpHash(c), SHARE_METRICS_PER_IP_PER_DAY, "day");
    await countShareAction(deps, channel);
    return c.body(null, 204);
  });

  r.get(sharePagePath(":id"), async (c) => {
    const sid = c.req.param("id") ?? "";
    const item = ID_RE.test(sid) ? await getShareItem(deps, sid) : undefined;
    const view = item ? toShareView(item) : undefined;
    if (!view || view.status !== "published") return htmlResponse(c, renderShareNotFound(), 404);
    return htmlResponse(c, renderSharePage(view, publicOrigin(c)), 200);
  });

  return r;
}
