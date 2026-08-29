// theme-boot.js — runs BLOCKING in <head> before stylesheets so the chosen
// theme applies before first paint (no flash). Plain script, CSP-safe
// (external, same-origin). Mirrors the applyTheme logic in app.js.
(function () {
  var THEMES = ['system', 'light', 'paper', 'slate', 'rose', 'solar', 'mint', 'lilac', 'latte',
    'azure', 'glass-light', 'conifer', 'clay', 'coral', 'mustard', 'fog',
    'dark', 'spruce', 'midnight', 'ember', 'nord', 'grape', 'ocean', 'terminal',
    'cobalt', 'glass-dark', 'synthwave', 'maroon', 'plum', 'jade', 'charcoal'];
  var DARK = ['dark', 'spruce', 'midnight', 'ember', 'nord', 'grape', 'ocean', 'terminal',
    'cobalt', 'glass-dark', 'synthwave', 'maroon', 'plum', 'jade', 'charcoal'];
  var pref = 'system';
  try { pref = localStorage.getItem('av-tasks-theme') || 'system'; } catch (e) { /* blocked */ }
  if (THEMES.indexOf(pref) === -1) pref = 'system';
  var dark = false;
  try { dark = matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { /* old UA */ }
  var resolved = pref === 'system' ? (dark ? 'dark' : 'light') : pref;
  var h = document.documentElement;
  h.setAttribute('data-theme', resolved);
  h.classList.remove('wa-dark', 'wa-light');
  h.classList.add(DARK.indexOf(resolved) !== -1 ? 'wa-dark' : 'wa-light');
})();
