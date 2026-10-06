// zod 4 probes `new Function` when schemas are built (to JIT-compile parsers). Under our CSP
// (script-src 'self', no 'unsafe-eval') that probe is reported as a violation on every load.
// Turning on `jitless` skips the probe. This must run before zod is evaluated, so main.tsx
// imports this module first and it must not import anything itself.
const g = globalThis as { __zod_globalConfig?: { jitless?: boolean } };
(g.__zod_globalConfig ??= {}).jitless = true;

export {};
