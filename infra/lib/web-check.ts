/**
 * Link previews (X, LINE) need an absolute og:image / twitter:image. The web build makes them
 * absolute when PUBLIC_ORIGIN is set (apps/web/vite.config.ts); without it they stay relative,
 * which is right for local runs and E2E but not for a deploy (docs/deploy.md).
 */

const IMAGE_KEYS = new Set(["og:image", "twitter:image"]);

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[2] ?? m[3]) : undefined;
}

/** The og:image / twitter:image URLs in an HTML document, in order. */
export function previewImageUrls(html: string): Array<{ key: string; url: string }> {
  const found: Array<{ key: string; url: string }> = [];
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attr(tag, "property") ?? attr(tag, "name"))?.toLowerCase();
    const url = attr(tag, "content");
    if (key && IMAGE_KEYS.has(key) && url !== undefined) found.push({ key, url });
  }
  return found;
}

/**
 * What is wrong with the built index.html for a public deploy ([] when nothing). With publicOrigin
 * (the PUBLIC_ORIGIN the deploy was started with), the images must also point at that origin, so a
 * stale build made without it is caught.
 */
export function previewImageProblems(html: string, publicOrigin?: string): string[] {
  const origin = publicOrigin?.trim().replace(/\/+$/, "");
  const problems: string[] = [];
  for (const { key, url } of previewImageUrls(html)) {
    if (!/^https?:\/\//i.test(url)) problems.push(`${key} が絶対 URL ではありません（${url}）`);
    else if (origin && !url.startsWith(`${origin}/`)) problems.push(`${key} が PUBLIC_ORIGIN（${origin}）を指していません（${url}）`);
  }
  return problems;
}
