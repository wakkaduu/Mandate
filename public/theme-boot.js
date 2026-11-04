// Loaded in <head>, before first paint: reads saved preferences and sets data-* attributes on <html> so the page never
// flashes the wrong theme / density / motion. It is also the single source of truth for what a preference may be
// (ui/prefs.js imports it via window.__prefsCore). Preferences live only in this browser (localStorage).
(() => {
  const KEY = 'mandate.prefs.v1';
  const OPTIONS = {
    theme: ['system', 'light', 'dark'],
    accent: ['sky', 'midnight', 'blue', 'green', 'ink'],
    density: ['comfortable', 'compact'],
    text: ['default', 'large'],
    motion: ['system', 'full', 'reduced', 'off'],
    startPage: ['overview', 'search', 'ledger'],
  };
  const DEFAULTS = {
    theme: 'system', accent: 'sky', density: 'comfortable', text: 'default', motion: 'system', startPage: 'overview',
    showChips: true, traceOpen: false, showHint: true, hintDismissed: false,
  };
  const BOOLS = ['showChips', 'traceOpen', 'showHint', 'hintDismissed'];
  const media = (q) => Boolean(window.matchMedia && window.matchMedia(q).matches);

  const valid = (k, v) => (k in OPTIONS ? OPTIONS[k].includes(v) : BOOLS.includes(k) && typeof v === 'boolean');
  function load() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { /* corrupt or blocked storage: use defaults */ }
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (valid(k, saved[k])) out[k] = saved[k];
    return out;
  }
  function save(prefs) { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* storage blocked: preferences last for this visit only */ } }
  function apply(prefs) {
    const root = document.documentElement;
    const scheme = prefs.theme === 'system' ? (media('(prefers-color-scheme: dark)') ? 'dark' : 'light') : prefs.theme;
    const motion = prefs.motion === 'system' ? (media('(prefers-reduced-motion: reduce)') ? 'reduced' : 'full') : prefs.motion;
    root.dataset.theme = prefs.theme;
    root.dataset.scheme = scheme;
    root.dataset.accent = prefs.accent;
    root.dataset.density = prefs.density;
    root.dataset.text = prefs.text;
    root.dataset.motion = motion;
    return { scheme, motion };
  }

  window.__prefsCore = { KEY, OPTIONS, DEFAULTS, valid, load, save, apply };
  apply(load());
})();
