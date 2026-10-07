// Bundles the two Lambda functions with esbuild:
//   src/lambda.ts   → dist/api/index.mjs
//   src/reminder.ts → dist/reminder/index.mjs
// The AWS SDK v3 is provided by the Node.js 22 Lambda runtime, so it stays external.
import { rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
rmSync(dist, { recursive: true, force: true });

const entries = {
  api: "src/lambda.ts",
  reminder: "src/reminder.ts",
};

// Some dependencies (web-push, ...) are CommonJS and call require() for Node built-ins.
const banner = [
  'import { createRequire as __thirtyCreateRequire } from "node:module";',
  "const require = __thirtyCreateRequire(import.meta.url);",
].join("\n");

for (const [name, entry] of Object.entries(entries)) {
  const outfile = path.join(dist, name, "index.mjs");
  await build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile,
    bundle: true,
    minify: true,
    sourcemap: false,
    platform: "node",
    target: "node22",
    format: "esm",
    external: ["@aws-sdk/*"],
    banner: { js: banner },
    legalComments: "none",
    logLevel: "warning",
  });
  console.log(`built ${path.relative(root, outfile)} (${Math.round(statSync(outfile).size / 1024)} KB)`);
}
