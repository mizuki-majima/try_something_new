// zod 4 probes `new Function` when the first schema is built (to JIT-compile parsers). Under the
// site's CSP (script-src 'self', no 'unsafe-eval') the probe is reported as a violation on every
// page load. `jitless` skips it. index.html loads this classic script before the app's module
// scripts, so the flag is set before any chunk that contains zod is evaluated, however the
// bundler splits the code.
(function () {
  var g = globalThis;
  g.__zod_globalConfig = g.__zod_globalConfig || {};
  g.__zod_globalConfig.jitless = true;
})();
