/**
 * Share actions for the reflection card (FR-7): text + intent URLs for X / LINE, the public link
 * (POST /api/shares with the PNG), and the anonymous "which channel was used" metric.
 */
import { API, VERDICTS, graphemeLength, sharePagePath, type ShareMetric, type ShareResponse } from "@thirty/shared";
import { request } from "../../lib/api";
import { graphemes } from "./shareCard";

export type ShareChannel = ShareMetric["channel"];

/** Fire-and-forget count of a share action (no user id, no content). Errors are ignored. */
export function trackShare(channel: ShareChannel): void {
  try {
    void request("POST", API.shareMetric, { body: { channel }, auth: "none" }).catch(() => undefined);
  } catch {
    // never let a metric break the action
  }
}

const REFLECTION_IN_TEXT = 40;

/** "30日だけ「毎日1枚、写真を撮る」をやってみた。23/30日、結果は「続ける」。…" */
export function shareText(c: { title: string; count: number; verdict: keyof typeof VERDICTS | null; reflection?: string | null }): string {
  const verdict = c.verdict ? `、結果は「${VERDICTS[c.verdict].label}」` : "";
  let reflection = (c.reflection ?? "").replace(/\s+/g, " ").trim();
  if (graphemeLength(reflection) > REFLECTION_IN_TEXT) reflection = graphemes(reflection).slice(0, REFLECTION_IN_TEXT - 1).join("") + "…";
  return `30日だけ「${c.title}」をやってみた。${c.count}/30日${verdict}。${reflection ? `「${reflection}」` : ""} #30日だけ`;
}

/** X (Twitter) post intent. The url is added only when there is a public link. */
export function xIntentUrl(text: string, url?: string | null): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}${url ? `&url=${encodeURIComponent(url)}` : ""}`;
}

/** LINE share (needs a public URL). */
export function lineShareUrl(url: string): string {
  return `https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(url)}`;
}

/** Public page of an existing share id on this site. */
export function publicShareUrl(shareId: string, origin: string = typeof location !== "undefined" ? location.origin : ""): string {
  return `${origin}${sharePagePath(shareId)}`;
}

/** "30days-写.png" (characters that file systems reject are dropped). */
export function cardFileName(seal: string): string {
  const safe = seal.replace(/[\\/:*?"<>|\s]/g, "");
  return `30days-${safe || "card"}.png`;
}

/** Base64 of a Blob, without the data: prefix. */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result ?? "");
      const i = s.indexOf(",");
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

/** Upload the card and create (or replace) the public link /s/:id. */
export async function createShareLink(challengeId: string, png: Blob): Promise<ShareResponse> {
  const imageBase64 = await blobToBase64(png);
  return request<ShareResponse>("POST", API.shares, { body: { challengeId, imageBase64 }, auth: "required", timeoutMs: 30_000 });
}

export async function deleteShareLink(shareId: string): Promise<void> {
  await request<void>("DELETE", API.share(shareId), { auth: "required" });
}
