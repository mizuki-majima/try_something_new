/**
 * Public share card page (/s/:id, FR-7 / CUF-2): a complete HTML document with OGP tags,
 * rendered on the server. No scripts (the CSP for /s/* has no script-src) and no external
 * resources; every interpolated value goes through escapeHtml.
 */
import { VERDICTS, jpDate, isValidDate, shareImagePath, sharePagePath, TOTAL_DAYS } from "@thirty/shared";
import type { Context } from "hono";
import type { ShareView } from "./db/shares";

export const TED_TALK_URL = "https://www.ted.com/talks/matt_cutts_try_something_new_for_30_days";
export const SITE_NAME = "30日だけ";

/** CSP sent with the page (CloudFront adds its own policy on top; this one keeps local runs honest). */
export const SHARE_PAGE_CSP =
  "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape text for HTML element content and quoted attribute values. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

const HOST_RE = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/i;

/**
 * Public origin for absolute URLs. Behind CloudFront the Lambda sees the API Gateway host, so the
 * viewer-request function passes the real one in x-forwarded-host (always https there).
 */
export function publicOrigin(c: Context): string {
  const forwarded = c.req.header("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwarded && HOST_RE.test(forwarded)) return `https://${forwarded.toLowerCase()}`;
  return new URL(c.req.url).origin;
}

const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });

/** One line, at most `max` graphemes, with an ellipsis when cut. */
export function excerpt(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  const parts = Array.from(segmenter.segment(line), (s) => s.segment);
  return parts.length <= max ? line : parts.slice(0, max).join("").trimEnd() + "…";
}

export function shareTitle(v: Pick<ShareView, "nickname" | "title">): string {
  return `${v.nickname}の30日「${v.title}」`;
}

export function shareDescription(v: Pick<ShareView, "verdict" | "days" | "reflection">): string {
  const head = [v.verdict ? VERDICTS[v.verdict].label : null, `${v.days}/${TOTAL_DAYS}日`].filter(Boolean).join(" · ");
  return v.reflection ? `${head} — ${excerpt(v.reflection, 80)}` : head;
}

// Neo-brutalism (docs/design.md): cream grid background, 3px ink borders, hard offset shadows,
// flat colours, heavy headings. Fonts are not loaded here, so headings fall back to heavy system fonts.
const STYLE = `
:root{--bg:#FFF4D6;--surface:#FFFFFF;--ink:#111111;--muted:#4A4A4A;--shu:#FF4B2B;--yellow:#FFD43B;--mint:#3DDC97;--blue:#6C8CFF;--gray:#E6E1D3;--on-accent:#111111;--grid:rgba(17,17,17,.08);color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--surface:#1F1F1F;--ink:#F7F3E8;--muted:#C9C4B8;--shu:#FF5A3C;--blue:#7C98FF;--gray:#3A3A3A;--grid:rgba(247,243,232,.08)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;background-color:var(--bg);background-image:linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px);background-size:24px 24px;color:var(--ink);font-family:"Zen Kaku Gothic New","Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic UI","Yu Gothic",Meiryo,system-ui,sans-serif;line-height:1.7;font-size:16px}
a{color:inherit}
a:focus-visible{outline:3px solid var(--blue);outline-offset:3px}
.display{font-family:"Dela Gothic One","Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic",system-ui,sans-serif;font-weight:900;letter-spacing:.01em}
.top{background:var(--surface);border-bottom:3px solid var(--ink);padding:10px 16px}
.logo{display:inline-flex;align-items:center;gap:10px;text-decoration:none;font-size:20px;min-height:44px}
.logo-seal{display:inline-grid;place-items:center;width:36px;height:36px;border-radius:50%;background:var(--shu);color:var(--on-accent);border:3px solid var(--ink);box-shadow:3px 3px 0 var(--ink);transform:rotate(-6deg);font-size:18px}
main{max-width:760px;margin:0 auto;padding:24px 16px 32px}
.shot{margin:0 0 24px;border:3px solid var(--ink);border-radius:12px;box-shadow:6px 6px 0 var(--ink);overflow:hidden;background:var(--surface)}
.shot img{display:block;width:100%;height:auto;aspect-ratio:1200/630}
.card{background:var(--surface);border:3px solid var(--ink);border-radius:12px;box-shadow:6px 6px 0 var(--ink);padding:20px}
.head{display:flex;gap:16px;align-items:center}
.seal{flex:none;display:grid;place-items:center;width:72px;height:72px;border-radius:50%;background:var(--shu);color:var(--on-accent);border:3px solid var(--ink);box-shadow:3px 3px 0 var(--ink);transform:rotate(-6deg);font-size:38px;line-height:1}
.who{margin:0;color:var(--muted);font-weight:700;font-size:14px}
h1{margin:2px 0 0;font-size:clamp(22px,5vw,32px);line-height:1.3;overflow-wrap:anywhere}
.facts{display:flex;flex-wrap:wrap;align-items:center;gap:12px 16px;margin:18px 0 0}
.sticker{display:inline-block;padding:4px 14px;border:3px solid var(--ink);border-radius:999px;color:var(--on-accent);font-size:18px;transform:rotate(-3deg);box-shadow:3px 3px 0 var(--ink)}
.v-continue{background:var(--mint)}.v-stop{background:var(--gray);color:var(--ink)}.v-modify{background:var(--blue)}
.days{font-size:28px;line-height:1}.days small{font-size:15px;margin-left:2px}
.period{color:var(--muted);font-size:14px}
.reflection{margin:18px 0 0;padding:14px 16px;border:2px solid var(--ink);border-radius:12px;background:var(--bg);white-space:pre-wrap;overflow-wrap:anywhere}
.cta{display:flex;justify-content:center;align-items:center;min-height:56px;margin:28px 0 0;padding:12px 20px;background:var(--shu);color:var(--on-accent);border:3px solid var(--ink);border-radius:12px;box-shadow:5px 5px 0 var(--ink);font-size:20px;text-decoration:none;text-align:center}
@media (prefers-reduced-motion:no-preference){.cta{transition:transform .1s,box-shadow .1s}.cta:hover{transform:translate(-2px,-2px);box-shadow:7px 7px 0 var(--ink)}.cta:active{transform:translate(3px,3px);box-shadow:2px 2px 0 var(--ink)}}
.sub{margin:18px 0 0;text-align:center}
.sub a{display:inline-block;padding:10px 4px;font-weight:700}
.empty{text-align:center}
.empty p{margin:12px 0 0}
footer{max-width:760px;margin:0 auto;padding:8px 16px 32px;color:var(--muted);font-size:13px;text-align:center}
footer a{display:inline-block;padding:10px 0}
`;

type PageParts = { title: string; head: string; body: string };

function layout({ title, head, body }: PageParts): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="robots" content="noindex">
<meta name="theme-color" content="#FFF4D6">
${head}
<style>${STYLE}</style>
</head>
<body>
<header class="top"><a class="logo display" href="/"><span class="logo-seal" aria-hidden="true">卅</span>${escapeHtml(SITE_NAME)}</a></header>
<main>
${body}
</main>
<footer>着想：<a href="${escapeHtml(TED_TALK_URL)}" rel="noopener noreferrer">Matt Cutts “Try something new for 30 days”</a></footer>
</body>
</html>
`;
}

const meta = (property: string, content: string) => `<meta property="${escapeHtml(property)}" content="${escapeHtml(content)}">`;
const metaName = (name: string, content: string) => `<meta name="${escapeHtml(name)}" content="${escapeHtml(content)}">`;

/** The public card page. `origin` is the public https origin (see publicOrigin). */
export function renderSharePage(v: ShareView, origin: string): string {
  const title = shareTitle(v);
  const description = shareDescription(v);
  const pageUrl = origin + sharePagePath(v.id);
  const imagePath = shareImagePath(v.id);
  const imageUrl = origin + imagePath;
  const verdict = v.verdict ? VERDICTS[v.verdict] : null;
  const imageAlt = `${title}の振り返りカード`;
  const cta = v.recipeId ? `/recipes/${encodeURIComponent(v.recipeId)}` : "/";

  const head = [
    metaName("description", description),
    meta("og:site_name", SITE_NAME),
    meta("og:locale", "ja_JP"),
    meta("og:type", "article"),
    meta("og:title", title),
    meta("og:description", description),
    meta("og:url", pageUrl),
    meta("og:image", imageUrl),
    meta("og:image:type", "image/png"),
    meta("og:image:width", "1200"),
    meta("og:image:height", "630"),
    meta("og:image:alt", imageAlt),
    metaName("twitter:card", "summary_large_image"),
    metaName("twitter:title", title),
    metaName("twitter:description", description),
    metaName("twitter:image", imageUrl),
    `<link rel="canonical" href="${escapeHtml(pageUrl)}">`,
  ].join("\n");

  const sticker = verdict && v.verdict ? `<span class="sticker display v-${escapeHtml(v.verdict)}">${escapeHtml(verdict.label)}</span>` : "";
  // Start date only: a card may close early ("ここで区切る"), so a 30-day period would be wrong.
  const since = isValidDate(v.startDate) ? `<span class="period">${escapeHtml(jpDate(v.startDate))}から</span>` : "";
  const reflection = v.reflection ? `<blockquote class="reflection">${escapeHtml(v.reflection)}</blockquote>` : "";

  const body = `<figure class="shot"><img src="${escapeHtml(imagePath)}" width="1200" height="630" alt="${escapeHtml(imageAlt)}"></figure>
<article class="card">
<div class="head">
<span class="seal display" aria-hidden="true">${escapeHtml(v.seal)}</span>
<div>
<p class="who">${escapeHtml(v.nickname)}の30日</p>
<h1 class="display">${escapeHtml(v.title)}</h1>
</div>
</div>
<p class="facts">${sticker}<span class="days display">${escapeHtml(v.days)}<small>/${TOTAL_DAYS}日</small></span>${since}</p>
${reflection}
</article>
<a class="cta display" href="${escapeHtml(cta)}">自分も30日やってみる</a>
<p class="sub"><a href="/about">「${escapeHtml(SITE_NAME)}」について</a></p>`;

  return layout({ title: `${title} | ${SITE_NAME}`, head, body });
}

/** 404 page in the same look (missing, hidden or deleted card). */
export function renderShareNotFound(): string {
  const body = `<article class="card empty">
<h1 class="display">カードが見つかりません</h1>
<p>このカードは削除されたか、公開を止めています。</p>
</article>
<a class="cta display" href="/">自分も30日やってみる</a>
<p class="sub"><a href="/about">「${escapeHtml(SITE_NAME)}」について</a></p>`;
  return layout({ title: `カードが見つかりません | ${SITE_NAME}`, head: "", body });
}
