// Settings and Information pages, laid out as document sections (title left, content right). DOM calls only (no innerHTML).
import { h } from './dom.js';
import { icon } from './icons.js';
import { OPTIONS, DEFAULTS, getPrefs, setPref, setAll, onPrefs } from './prefs.js';

// ------------------------------------------------------------------ shared layout
function section(title, desc, ...body) {
  return h('section', { class: 'doc-section' },
    h('div', { class: 'doc-title' }, h('h2', {}, title), desc ? h('p', { class: 'muted' }, desc) : null),
    h('div', { class: 'doc-body' }, body));
}

// ------------------------------------------------------------------ Settings
// [label, swatch color, check-mark color]: the check must contrast with its swatch (white on Sky Blue would be 1.8:1)
const ACCENTS = {
  sky: ['Sky Blue', '#60cdff', '#000000'], midnight: ['Midnight', '#002991', '#ffffff'], blue: ['Link Blue', '#0070e0', '#ffffff'], green: ['Success Green', '#007a56', '#ffffff'], ink: ['Ink', '#000000', '#ffffff'],
};
const LABELS = {
  theme: { system: 'System', light: 'Light', dark: 'Dark' },
  density: { comfortable: 'Comfortable', compact: 'Compact' },
  text: { default: 'Default', large: 'Large' },
  motion: { system: 'Follow my system', full: 'Full', reduced: 'Reduced', off: 'Off' },
  startPage: { overview: 'Account', search: 'Search', ledger: 'Ledger' },
};

const syncers = [];

function row(label, hint, control, id) {
  return h('div', { class: 'set-row' },
    h('div', { class: 'set-text' }, h('span', { class: 'set-label', id: id ? `${id}-label` : null }, label), hint ? h('small', {}, hint) : null),
    h('div', { class: 'set-ctl' }, control));
}

function segmented(key, labelId) {
  const el = h('div', { class: 'seg', role: 'radiogroup', 'aria-labelledby': `${labelId}-label` },
    OPTIONS[key].map((v) => h('label', { class: 'seg-opt' },
      h('input', { type: 'radio', name: `pref-${key}`, value: v, onchange: () => setPref(key, v) }),
      h('span', {}, LABELS[key][v]))));
  syncers.push(() => el.querySelectorAll('input').forEach((i) => { i.checked = i.value === getPrefs()[key]; }));
  return el;
}

function swatches(labelId) {
  const el = h('div', { class: 'swatches', role: 'radiogroup', 'aria-labelledby': `${labelId}-label` },
    OPTIONS.accent.map((v) => h('label', { class: 'swatch', title: ACCENTS[v][0] },
      h('input', { type: 'radio', name: 'pref-accent', value: v, 'aria-label': ACCENTS[v][0], onchange: () => setPref('accent', v) }),
      h('span', { style: `--sw:${ACCENTS[v][1]};--sw-ink:${ACCENTS[v][2]}` }, icon('check', { size: 16 })))));
  syncers.push(() => el.querySelectorAll('input').forEach((i) => { i.checked = i.value === getPrefs().accent; }));
  return el;
}

function toggle(key, ariaLabel) {
  const input = h('input', { type: 'checkbox', role: 'switch', 'aria-label': ariaLabel, onchange: (e) => setPref(key, e.target.checked) });
  syncers.push(() => { input.checked = Boolean(getPrefs()[key]); });
  return h('label', { class: 'switch' }, input, h('span', { class: 'track' }, h('span', { class: 'thumb' })));
}

function select(key, labelId) {
  const el = h('select', { class: 'select', 'aria-labelledby': `${labelId}-label`, onchange: (e) => setPref(key, e.target.value) },
    OPTIONS[key].map((v) => h('option', { value: v }, LABELS[key][v])));
  syncers.push(() => { el.value = getPrefs()[key]; });
  return el;
}

export function renderSettings(root, { toast, startTour }) {
  const preview = h('div', { class: 'motion-demo', 'aria-hidden': 'true' }, h('span', {}), h('span', {}), h('span', {}));
  const play = () => { preview.classList.remove('play'); void preview.offsetWidth; preview.classList.add('play'); };

  root.replaceChildren(
    section('Help', 'A short walkthrough of how Mandate works.',
      row('Welcome tour', 'It opens by itself the first time you visit on this device, and not again. Replay it here whenever you like.',
        h('button', { class: 'btn', type: 'button', id: 'btn-replay-tour', onclick: () => startTour() }, icon('help', { size: 16 }), 'Replay tour'), 'set-tour')),
    section('Appearance', 'Color, density and text size.',
      row('Theme', 'System follows your device.', segmented('theme', 'set-theme'), 'set-theme'),
      row('Accent color', 'Used for buttons and highlights.', swatches('set-accent'), 'set-accent'),
      row('Density', 'Compact fits more on screen.', segmented('density', 'set-density'), 'set-density'),
      row('Text size', null, segmented('text', 'set-text'), 'set-text')),
    section('Motion', 'Animations are short and quiet. Choose fewer if you prefer.',
      row('Animations', 'System follows your device\'s "reduce motion" setting. Off removes every animation and transition.', segmented('motion', 'set-motion'), 'set-motion'),
      h('div', { class: 'set-row' }, h('div', { class: 'set-text' }, h('span', { class: 'set-label' }, 'Preview'), h('small', {}, 'Plays a sample with your current setting.')),
        h('div', { class: 'set-ctl motion-preview' }, preview, h('button', { class: 'btn small', type: 'button', onclick: play }, 'Play')))),
    section('Layout and content', 'What you see, and where you start.',
      row('Start page', 'Where Mandate opens.', select('startPage', 'set-start'), 'set-start'),
      row('Suggestions', 'Example requests under the message box.', toggle('showChips', 'Show suggestions'), 'set-chips'),
      row('Open agent activity', 'Expand the step-by-step trace of each reply by default.', toggle('traceOpen', 'Open agent activity by default'), 'set-trace'),
      row('"New here?" hint', 'A one-line pointer to How it works on the Account page.', toggle('showHint', 'Show the new-here hint'), 'set-hint')),
    section('This device', 'Saved in this browser only. Nothing here is sent to the server, and none of it changes your mandate or payments.',
      h('div', { class: 'set-row' }, h('div', { class: 'set-text' }, h('span', { class: 'set-label' }, 'Reset preferences'), h('small', {}, 'Restore every setting on this page to its default.')),
        h('div', { class: 'set-ctl' }, h('button', { class: 'btn', type: 'button', onclick: () => {
          const before = getPrefs();
          setAll({ ...DEFAULTS });
          toast('Preferences reset.', false, { label: 'Undo', run: () => setAll(before) });
        } }, 'Reset')))),
  );
  const sync = () => syncers.forEach((fn) => fn());
  sync();
  onPrefs(sync);
}

// ------------------------------------------------------------------ Information
const yes = (v) => (v ? 'ok' : 'warn');

function infoSection(title, rows) {
  return section(title, null,
    h('dl', { class: 'info-list' }, rows.map(([k, v, kind, extra]) => h('div', { class: 'info-row' },
      h('dt', {}, k),
      h('dd', {}, Array.isArray(v) ? v : h('span', { class: 'val' }, kind ? h('span', { class: `dot ${kind}`, 'aria-hidden': 'true' }) : null, v), extra ?? null)))));
}

/** Everything shown here comes from GET /api/config. No secrets and no vendor names: only what is switched on. */
export function infoModel(cfg) {
  return {
    paypal: { environment: cfg.paypalMode === 'mock' ? 'Offline simulator (development)' : 'Sandbox (test mode)', credentials: Boolean(cfg.paypalConfigured), currency: cfg.currency, webhooks: Boolean(cfg.webhooks) },
    safety: { refundCoolingSeconds: cfg.refundCoolingSeconds ?? null, highValueCents: cfg.highValueCents ?? null },
    assistant: { enabled: Boolean(cfg.aiEnabled) },
    search: { sources: cfg.searchSources ?? 0, strictPrices: cfg.strictPrices !== false, cacheMinutes: cfg.searchCacheMinutes ?? null, dailyBudget: cfg.searchesPerDay ?? null },
    hosting: { mode: cfg.serverless ? 'Serverless' : 'Server', persistent: cfg.persistent !== false, version: cfg.version ?? null },
    agentAccess: { endpoint: `${location.origin}${cfg.agentPath ?? '/agent'}` },
  };
}

export function renderInfo(root, cfg, { toast }) {
  const m = infoModel(cfg);
  const health = h('span', {}, 'Checking...');
  const healthDot = h('span', { class: 'dot', 'aria-hidden': 'true' });
  const healthRow = [h('span', { class: 'val' }, healthDot, health)];
  const checkHealth = async () => {
    const t0 = performance.now();
    health.textContent = 'Checking...';
    healthDot.className = 'dot';
    try {
      const r = await fetch('/healthz', { cache: 'no-store' });
      const ok = r.ok && (await r.json()).ok;
      health.textContent = ok ? `Healthy (${Math.round(performance.now() - t0)} ms)` : 'Not responding';
      healthDot.className = `dot ${ok ? 'ok' : 'bad'}`;
    } catch { health.textContent = 'Not reachable'; healthDot.className = 'dot bad'; }
  };
  const copy = async (text, label) => {
    try { await navigator.clipboard.writeText(text); toast(`${label} copied.`); } catch { toast('Copy is blocked in this browser. Select the text and press Ctrl+C.', true); }
  };
  const money = (c) => `$${(c / 100).toFixed(2)}`;

  root.replaceChildren(
    infoSection('Payments', [
      ['Payment environment', m.paypal.environment, cfg.paypalMode === 'mock' ? 'warn' : null],
      ['Credentials', m.paypal.credentials ? 'Configured' : 'Missing', yes(m.paypal.credentials)],
      ['Currency', m.paypal.currency ?? 'USD', null],
      ['Webhooks', m.paypal.webhooks ? 'Verified endpoint on' : 'Not configured', m.paypal.webhooks ? 'ok' : null],
      ['Refunds', m.safety.refundCoolingSeconds != null ? `Two steps, ${m.safety.refundCoolingSeconds}s cooling-off, then confirm` : 'Two steps', null],
      ['High-value payments', m.safety.highValueCents != null ? `${money(m.safety.highValueCents)} and above: type the amount to confirm` : '-', null],
    ]),
    infoSection('Assistant', [
      ['AI assistant', m.assistant.enabled ? 'Enabled' : 'Not set up', yes(m.assistant.enabled)],
      ['What it can do', 'Search products, read your mandate, request a purchase', null],
      ['Can spend money', 'No: it can only request purchases', 'ok'],
      ['Can set a price', 'No: prices are read by the server', 'ok'],
    ]),
    infoSection('Web search', [
      ['Search sources', m.search.sources > 0 ? `${m.search.sources} configured` : 'None configured', yes(m.search.sources > 0)],
      ['Price check', m.search.strictPrices ? 'Strict: read from the retailer\'s page' : 'Accepts search-result prices', m.search.strictPrices ? 'ok' : 'warn'],
      ['Result cache', m.search.cacheMinutes != null ? `${m.search.cacheMinutes} minutes` : '-', null],
      ['Daily search budget', m.search.dailyBudget != null ? `${m.search.dailyBudget} searches` : '-', null],
    ]),
    infoSection('Data and hosting', [
      ['Storage', m.hosting.persistent ? 'Persistent database' : 'Temporary (resets between visits)', yes(m.hosting.persistent)],
      ['Deployment', m.hosting.mode, null],
      ['Version', m.hosting.version ?? '-', null],
      ['Server health', healthRow, null, h('button', { class: 'btn small', type: 'button', onclick: checkHealth }, icon('refresh', { size: 14 }), 'Recheck')],
    ]),
    infoSection('Agent access', [
      ['Endpoint', h('code', {}, m.agentAccess.endpoint), null, h('button', { class: 'btn small', type: 'button', onclick: () => copy(m.agentAccess.endpoint, 'Endpoint') }, icon('copy', { size: 14 }), 'Copy')],
      ['Authentication', 'Bearer token, issued per session by the API', null],
      ['Rules', 'External agents pass the same policy checks and PayPal approval', 'ok'],
    ]),
    h('div', { class: 'info-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => copy(JSON.stringify({ ...m, generatedAt: new Date().toISOString() }, null, 2), 'Diagnostics') }, icon('copy', { size: 16 }), 'Copy diagnostics'),
      h('span', { class: 'muted' }, 'Contains no keys or secrets: only what is configured.')),
  );
  checkHealth();
}
