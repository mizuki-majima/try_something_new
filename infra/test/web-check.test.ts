import { describe, expect, it } from "vitest";
import { previewImageProblems, previewImageUrls } from "../lib/web-check";

const page = (image: string) => `<!doctype html><html><head>
  <meta property="og:image" content="${image}" />
  <meta property="og:image:width" content="1200" />
  <meta name="twitter:image" content="${image}">
</head><body></body></html>`;

describe("OGP image check for deploys (bin/app.ts warns)", () => {
  it("finds og:image and twitter:image, whatever the attribute order or quotes", () => {
    expect(previewImageUrls(page("/og-default.png"))).toEqual([
      { key: "og:image", url: "/og-default.png" },
      { key: "twitter:image", url: "/og-default.png" },
    ]);
    expect(previewImageUrls(`<meta content='https://x.example/a.png' property='og:image'>`)).toEqual([
      { key: "og:image", url: "https://x.example/a.png" },
    ]);
  });

  it("flags relative URLs (a build without PUBLIC_ORIGIN) and an unreplaced placeholder", () => {
    expect(previewImageProblems(page("/og-default.png"))).toHaveLength(2);
    expect(previewImageProblems(page("%PUBLIC_ORIGIN%/og-default.png"))[0]).toContain("絶対 URL");
  });

  it("accepts absolute URLs, and with PUBLIC_ORIGIN they must point at it", () => {
    const origin = "https://d1zw3n37kpuo7t.cloudfront.net";
    expect(previewImageProblems(page(`${origin}/og-default.png`))).toEqual([]);
    expect(previewImageProblems(page(`${origin}/og-default.png`), `${origin}/`)).toEqual([]);
    expect(previewImageProblems(page("https://old.example/og-default.png"), origin)[0]).toContain("PUBLIC_ORIGIN");
  });

  it("has nothing to say about a page without preview images", () => {
    expect(previewImageProblems("<html><head></head></html>")).toEqual([]);
  });
});
