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

// 「白いノート」 (docs/design.md): plain paper, white cards with a thin line, no offset shadows, a 朱 ring
// seal. Light, and the calm dark palette when the OS is dark (the page has no script, so no manual
// theme). No web fonts here: headings use the device's rounded / Japanese fonts at 700.
const STYLE = `
:root{--bg:#FAF8F4;--bg-2:#F3F0EA;--surface:#FFFFFF;--ink:#34312C;--muted:#6B655C;--line:#8C8579;--rule:#E2DDD3;--accent:#4A6B4E;--accent-hover:#3F5E43;--accent-ink:#3F6B4A;--accent-soft:#E6EEE3;--on-primary:#FFFFFF;--primary-border:#4A6B4E;--shu:#B9553D;--mist:#E3E9F0;--slate:#52637A;--gray-soft:#ECE8E1;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#1C1B19;--bg-2:#211F1D;--surface:#262522;--ink:#E6E1D8;--muted:#A9A398;--line:#827C72;--rule:#3A3834;--accent:#3E5A44;--accent-hover:#46654C;--accent-ink:#9CC3A0;--accent-soft:#2F3B30;--on-primary:#E6E1D8;--primary-border:#9CC3A0;--shu:#D4866F;--mist:#2B333C;--slate:#A9B8CB;--gray-soft:#33312D}.shot img{filter:brightness(.92)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Noto Sans CJK JP","Yu Gothic UI",Meiryo,system-ui,sans-serif;line-height:1.75;letter-spacing:.02em;font-size:16px}
a{color:inherit}
a:focus-visible{outline:2px solid var(--accent-ink);outline-offset:2px}
.display{font-family:"Hiragino Maru Gothic ProN","Hiragino Sans","Noto Sans JP",system-ui,sans-serif;font-weight:700;letter-spacing:.02em}
.top{background:var(--bg);border-bottom:1px solid var(--rule);padding:6px 16px}
.logo{display:inline-flex;align-items:center;gap:10px;text-decoration:none;font-size:19px;min-height:44px}
.logo-seal{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:50%;border:1.5px solid var(--shu);color:var(--shu);transform:rotate(-4deg);font-size:14px;line-height:1}
main{max-width:760px;margin:0 auto;padding:24px 16px 32px}
.shot{margin:0 0 24px;border:1px solid var(--rule);border-radius:12px;overflow:hidden;background:var(--surface)}
.shot img{display:block;width:100%;height:auto;aspect-ratio:1200/630}
.card{background:var(--surface);border:1px solid var(--rule);border-radius:14px 18px 13px 17px/17px 13px 18px 14px;padding:20px}
.head{display:flex;gap:16px;align-items:center}
.seal{flex:none;display:grid;place-items:center;width:64px;height:64px;border-radius:50%;border:1.75px solid var(--shu);color:var(--shu);transform:rotate(-4deg);font-size:32px;line-height:1}
.who{margin:0;color:var(--muted);font-weight:700;font-size:14px}
h1{margin:2px 0 0;font-size:clamp(22px,5vw,30px);line-height:1.35;overflow-wrap:anywhere}
.facts{display:flex;flex-wrap:wrap;align-items:center;gap:12px 16px;margin:18px 0 0}
.sticker{display:inline-block;padding:2px 14px;border:1px solid var(--line);border-radius:8px;background:var(--gray-soft);color:var(--ink);font-size:17px}
.v-continue{border-color:var(--accent-ink);background:var(--accent-soft);color:var(--accent-ink)}.v-modify{border-color:var(--slate);background:var(--mist);color:var(--slate)}
.days{font-size:28px;line-height:1}.days small{font-size:15px;margin-left:2px;color:var(--muted)}
.period{color:var(--muted);font-size:14px}
.reflection{margin:18px 0 0;padding:14px 16px;border-radius:12px;background:var(--bg-2);white-space:pre-wrap;overflow-wrap:anywhere}
.cta{display:flex;justify-content:center;align-items:center;min-height:56px;margin:28px 0 0;padding:12px 20px;background:var(--accent);color:var(--on-primary);border:1.5px solid var(--primary-border);border-radius:9px 11px 8px 12px/12px 8px 11px 9px;font-size:18px;text-decoration:none;text-align:center}
@media (hover:hover){.cta:hover{background:var(--accent-hover)}}
.sub{margin:18px 0 0;text-align:center}
.sub a{display:inline-block;padding:10px 4px;font-weight:600;color:var(--accent-ink)}
.report{margin-top:4px;font-size:14px}.report a{color:var(--muted);font-weight:400}
.empty{text-align:center}
.empty p{margin:12px 0 0}
footer{max-width:760px;margin:0 auto;padding:8px 16px 32px;color:var(--muted);font-size:13px;text-align:center}
footer a{display:inline-block;padding:10px 0}
footer nav{display:flex;flex-wrap:wrap;justify-content:center;gap:0 18px;border-top:1px solid var(--rule);font-size:14px}
footer nav a{padding:12px 2px;min-height:44px}
footer p{margin:4px 0 0}
`;

/**
 * The same links as the app's footer (apps/web Layout FOOTER_LINKS, SPEC FR-21 / D13): every screen,
 * this server-rendered one included, reaches the Terms and the Privacy Policy. Plain links (no script).
 */
export const SHARE_FOOTER_LINKS: readonly { href: string; label: string }[] = [
  { href: "/about", label: "このサービスについて" },
  { href: "/terms", label: "利用規約" },
  { href: "/privacy", label: "プライバシーポリシー" },
  { href: "/contact", label: "お問い合わせ" },
];

function footer(): string {
  const links = SHARE_FOOTER_LINKS.map((l) => `<a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`).join("");
  return `<footer>
<nav aria-label="このサイトについて">${links}</nav>
<p>着想：<a href="${escapeHtml(TED_TALK_URL)}" rel="noopener noreferrer">Matt Cutts “Try something new for 30 days”</a></p>
</footer>`;
}

type PageParts = { title: string; head: string; body: string };

function layout({ title, head, body }: PageParts): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="robots" content="noindex">
<meta name="theme-color" content="#1C1B19" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#FAF8F4">
${head}
<style>${STYLE}</style>
</head>
<body>
<header class="top"><a class="logo display" href="/"><span class="logo-seal" aria-hidden="true">卅</span>${escapeHtml(SITE_NAME)}</a></header>
<main>
${body}
</main>
${footer()}
</body>
</html>
`;
}

const meta = (property: string, content: string) => `<meta property="${escapeHtml(property)}" content="${escapeHtml(content)}">`;
const metaName = (name: string, content: string) => `<meta name="${escapeHtml(name)}" content="${escapeHtml(content)}">`;

/**
 * FR-18: public cards can be reported. This page has no scripts or forms (CSP), so the link opens
 * the app's contact page, which shows a report form for this card (POST /api/reports, type share).
 */
export function reportPath(shareId: string): string {
  return `/contact?report=share:${encodeURIComponent(shareId)}`;
}

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
<p class="sub"><a href="/about">「${escapeHtml(SITE_NAME)}」について</a></p>
<p class="sub report"><a href="${escapeHtml(reportPath(v.id))}" rel="nofollow">このカードを通報する</a></p>`;

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
