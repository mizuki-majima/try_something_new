#!/usr/bin/env node
// npm run dev: local API (dynalite + Hono on :8787) and Vite (:5173, proxies /api /s /media) together.
// Ctrl+C stops both; if one exits, the other is stopped too.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const apiPort = process.env.PORT ?? "8787";

const procs = [
  {
    name: "api",
    cmd: isWindows ? "npx.cmd" : "npx",
    args: ["tsx", "apps/api/src/local.ts"],
    env: { PORT: apiPort },
  },
  {
    name: "web",
    cmd: isWindows ? "npm.cmd" : "npm",
    args: ["run", "dev", "-w", "apps/web"],
    env: { API_ORIGIN: `http://127.0.0.1:${apiPort}` },
  },
];

let stopping = false;
const children = procs.map(({ name, cmd, args, env }) => {
  const child = spawn(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
  child.on("exit", (code, signal) => {
    if (!stopping) {
      console.error(`[dev] ${name} exited (${signal ?? code}); stopping the rest`);
      stop(code ?? 1);
    }
  });
  return child;
});

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 3000).unref();
  Promise.all(children.map((c) => (c.exitCode !== null ? null : new Promise((r) => c.once("exit", r))))).then(() =>
    process.exit(code),
  );
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

console.log(`
  30日だけ — local development
  Web   http://localhost:5173
  API   http://127.0.0.1:${apiPort}/api/health
  Admin http://localhost:5173/admin  (token: local-admin-token)
`);
