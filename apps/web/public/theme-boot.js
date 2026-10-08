// A manual theme choice (設定 → 表示: ライト / ダーク), applied before the first paint. Without it a
// phone in light mode with 「ダーク」 chosen showed a full paper-white frame on every load until the
// app's module script ran applyTheme() (apps/web/src/lib/theme.ts, which still runs and stays the
// source of truth). index.html loads this as a blocking classic script in <head>, after the
// theme-color metas (CSP: script-src 'self', no inline script). Keep the key and the colours in step
// with lib/storage.ts KEYS.theme and lib/theme.ts THEME_COLORS (apps/web/test/indexHtml.test.ts).
(function () {
  var pref;
  try {
    pref = window.localStorage.getItem("thirty-days.theme");
  } catch {
    return; // storage blocked: follow the device, as the app does
  }
  if (pref !== "light" && pref !== "dark") return;
  document.documentElement.setAttribute("data-theme", pref);
  var color = pref === "dark" ? "#1c1b19" : "#faf8f4";
  var metas = document.querySelectorAll('meta[name="theme-color"]');
  for (var i = 0; i < metas.length; i++) metas[i].setAttribute("content", color);
})();
