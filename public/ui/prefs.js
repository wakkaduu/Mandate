// Preferences store (localStorage, this browser only). Allowed values and persistence live in /theme-boot.js so the
// very first paint already uses them; this module adds change notification for the rest of the UI.
const core = window.__prefsCore;
let prefs = core.load();
const listeners = new Set();

export const OPTIONS = core.OPTIONS;
export const DEFAULTS = core.DEFAULTS;
export const getPrefs = () => ({ ...prefs });
export const onPrefs = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (key) => { const resolved = core.apply(prefs); listeners.forEach((fn) => fn(getPrefs(), key, resolved)); };

export function setPref(key, value) {
  if (!core.valid(key, value) || prefs[key] === value) return;
  prefs = { ...prefs, [key]: value };
  core.save(prefs);
  emit(key);
}

/** Replace every preference at once (used by "reset" and its undo). Unknown / invalid values fall back to defaults. */
export function setAll(next) {
  const merged = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (core.valid(k, next?.[k])) merged[k] = next[k];
  prefs = merged;
  core.save(prefs);
  emit('*');
}

// "System" settings follow the OS: re-resolve when the OS theme or reduced-motion setting changes.
for (const q of ['(prefers-color-scheme: dark)', '(prefers-reduced-motion: reduce)']) {
  window.matchMedia?.(q).addEventListener?.('change', () => emit('system'));
}
