// theme-boot.js — runs BLOCKING in <head> before stylesheets so the chosen
// theme applies before first paint (no flash). Plain script, CSP-safe
// (external, same-origin). Mirrors the applyTheme logic in app.js.
(function () {
  var pref = 'system';
  try { pref = localStorage.getItem('av-tasks-theme') || 'system'; } catch (e) { /* blocked */ }
  if (['system', 'light', 'dark', 'paper', 'spruce'].indexOf(pref) === -1) pref = 'system';
  var dark = false;
  try { dark = matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { /* old UA */ }
  var resolved = pref === 'system' ? (dark ? 'dark' : 'light') : pref;
  var h = document.documentElement;
  h.setAttribute('data-theme', resolved);
  h.classList.remove('wa-dark', 'wa-light');
  h.classList.add(resolved === 'dark' || resolved === 'spruce' ? 'wa-dark' : 'wa-light');
})();
