// Settings and Information pages. Both are built with DOM calls only (no innerHTML).
import { $, h } from './dom.js';
import { icon } from './icons.js';
import { OPTIONS, DEFAULTS, getPrefs, setPref, setAll, onPrefs } from './prefs.js';

// ------------------------------------------------------------------ Settings
const ACCENTS = {
  indigo: ['Indigo', '#4f46e5'], blue: ['Blue', '#1d4ed8'], teal: ['Teal', '#0f766e'], violet: ['Violet', '#7c3aed'], rose: ['Rose', '#be123c'],
};
const LABELS = {
  theme: { system: 'System', light: 'Light', dark: 'Dark' },
  density: { comfortable: 'Comfortable', compact: 'Compact' },
  text: { default: 'Default', large: 'Large' },
  motion: { system: 'Follow my system', full: 'Full', reduced: 'Reduced', off: 'Off' },
  sidebar: { expanded: 'Expanded', collapsed: 'Collapsed' },
  startPage: { overview: 'Overview', search: 'Search', ledger: 'Ledger' },
};

const syncers = [];

function row(label, hint, control, id) {
  return h('div', { class: 'set-row' },
    h('div', { class: 'set-text' }, h('span', { class: 'set-label', id: id ? `${id}-label` : null }, label), hint ? h('small', {}, hint) : null),
    h('div', { class: 'set-ctl' }, control));
}

function card(iconName, title, desc, ...rows) {
  return h('section', { class: 'card settings-card' },
    h('header', { class: 'set-head' }, h('span', { class: 'set-ico' }, icon(iconName)), h('div', {}, h('h2', {}, title), h('p', { class: 'muted' }, desc))),
    h('div', { class: 'set-body' }, rows));
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
      h('span', { style: `--sw:${ACCENTS[v][1]}` }, icon('check', { size: 16 })))));
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

export function renderSettings(root, { toast }) {
  const preview = h('div', { class: 'motion-demo', 'aria-hidden': 'true' }, h('span', {}), h('span', {}), h('span', {}));
  const play = () => { preview.classList.remove('play'); void preview.offsetWidth; preview.classList.add('play'); };

  root.replaceChildren(
    card('palette', 'Appearance', 'Colors, density and text size.',
      row('Theme', 'System follows your device.', segmented('theme', 'set-theme'), 'set-theme'),
      row('Accent color', 'Used for buttons, links and highlights.', swatches('set-accent'), 'set-accent'),
      row('Density', 'Compact fits more on screen.', segmented('density', 'set-density'), 'set-density'),
      row('Text size', null, segmented('text', 'set-text'), 'set-text')),
    card('motion', 'Motion', 'Animations are subtle. Pick fewer if you prefer.',
      row('Animations', 'System follows your device\'s "reduce motion" setting. Off removes every animation and transition.', segmented('motion', 'set-motion'), 'set-motion'),
      h('div', { class: 'set-row' }, h('div', { class: 'set-text' }, h('span', { class: 'set-label' }, 'Preview'), h('small', {}, 'Plays a sample with your current setting.')),
        h('div', { class: 'set-ctl motion-preview' }, preview, h('button', { class: 'btn small', type: 'button', onclick: play }, 'Play')))),
    card('layout', 'Layout and content', 'What you see, and where you start.',
      row('Side panel', 'Collapsed shows icons only.', segmented('sidebar', 'set-sidebar'), 'set-sidebar'),
      row('Start page', 'Where Mandate opens.', select('startPage', 'set-start'), 'set-start'),
      row('Suggested prompts', 'Quick-start chips under the chat box.', toggle('showChips', 'Show suggested prompts'), 'set-chips'),
      row('Open agent activity', 'Expand each reply\'s step-by-step trace by default.', toggle('traceOpen', 'Open agent activity by default'), 'set-trace'),
      row('"New here?" hint', 'A one-line pointer to How it works on the Overview.', toggle('showHint', 'Show the new-here hint'), 'set-hint')),
    card('shield', 'This device', 'Preferences are saved in this browser only. Nothing here is sent to the server and none of it changes your mandate or payments.',
      h('div', { class: 'set-row' }, h('div', { class: 'set-text' }, h('span', { class: 'set-label' }, 'Reset preferences'), h('small', {}, 'Restore every setting on this page to its default.')),
        h('div', { class: 'set-ctl' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => {
          const before = getPrefs();
          setAll({ ...DEFAULTS });
          toast('Preferences reset.', false, { label: 'Undo', run: () => setAll(before) });
        } }, icon('reset', { size: 16 }), 'Reset')))),
  );
  const sync = () => syncers.forEach((fn) => fn());
  sync();
  onPrefs(sync);
}

// ------------------------------------------------------------------ Information
const yes = (v) => (v ? 'ok' : 'warn');

function infoCard(iconName, title, rows) {
  return h('section', { class: 'card info-card' },
    h('header', { class: 'set-head' }, h('span', { class: 'set-ico' }, icon(iconName)), h('h2', {}, title)),
    h('dl', { class: 'info-list' }, rows.map(([k, v, kind, extra]) => h('div', { class: 'info-row' },
      h('dt', {}, k),
      h('dd', {}, Array.isArray(v) ? v : h('span', { class: 'val' }, kind ? h('span', { class: `dot ${kind}`, 'aria-hidden': 'true' }) : null, v), extra ?? null)))));
}

/** Everything shown here comes from GET /api/config (no secrets: only whether a key is configured). */
export function infoModel(cfg) {
  const brain = { gemini: 'Gemini', claude: 'Claude' }[cfg.agentMode];
  return {
    paypal: { environment: cfg.paypalMode === 'mock' ? 'Offline simulator (development)' : 'Sandbox', credentials: Boolean(cfg.paypalConfigured), currency: cfg.currency, webhooks: Boolean(cfg.webhooks) },
    ai: { provider: brain ?? 'Not configured', model: cfg.model ?? null, fallbacks: (cfg.models ?? []).filter((m) => m !== cfg.model) },
    search: { providers: cfg.searchProviders ?? [], strictPrices: cfg.strictPrices !== false, cacheMinutes: cfg.searchCacheMinutes ?? null, dailyBudget: cfg.searchesPerDay ?? null },
    hosting: { host: cfg.host === 'vercel' ? 'Vercel (serverless)' : 'Node server', persistent: cfg.persistent !== false, version: cfg.version ?? null },
    mcp: { endpoint: `${location.origin}${cfg.mcpPath ?? '/mcp'}` },
  };
}

export function renderInfo(root, cfg, { toast }) {
  const m = infoModel(cfg);
  const health = h('span', {}, 'Checking...');
  const healthDot = h('span', { class: 'dot neutral', 'aria-hidden': 'true' });
  const healthRow = [h('span', { class: 'val' }, healthDot, health)];
  const checkHealth = async () => {
    const t0 = performance.now();
    health.textContent = 'Checking...';
    healthDot.className = 'dot neutral';
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
  const providerChips = m.search.providers.length
    ? h('span', { class: 'chips-inline' }, m.search.providers.map((p, i) => h('span', { class: 'cat' }, `${i + 1}. ${p}`)))
    : 'None configured';

  root.replaceChildren(
    h('div', { class: 'info-grid' },
      infoCard('card', 'Payments', [
        ['PayPal', m.paypal.environment, cfg.paypalMode === 'mock' ? 'warn' : 'ok'],
        ['Credentials', m.paypal.credentials ? 'Configured' : 'Missing', yes(m.paypal.credentials)],
        ['Currency', m.paypal.currency ?? 'USD', null],
        ['Webhooks', m.paypal.webhooks ? 'Verified endpoint on' : 'Not configured', m.paypal.webhooks ? 'ok' : 'neutral'],
        ['Money', 'No real money moves: sandbox only', 'ok'],
      ]),
      infoCard('sparkle', 'AI agent', [
        ['Provider', m.ai.provider, yes(cfg.agentMode === 'gemini' || cfg.agentMode === 'claude')],
        ['Model', m.ai.model ?? '-', null],
        ['Fallback models', m.ai.fallbacks.length ? m.ai.fallbacks.join(', ') : '-', null],
        ['Tools', 'search_products, propose_purchase, get_mandate', null],
        ['Can spend money', 'No: it can only request purchases', 'ok'],
      ]),
      infoCard('globe', 'Web search', [
        ['Providers (in order)', providerChips, yes(m.search.providers.length > 0)],
        ['Price check', m.search.strictPrices ? 'Strict: read from the retailer\'s page' : 'Accepts search-result prices', m.search.strictPrices ? 'ok' : 'warn'],
        ['Result cache', m.search.cacheMinutes != null ? `${m.search.cacheMinutes} minutes` : '-', null],
        ['Daily search budget', m.search.dailyBudget != null ? `${m.search.dailyBudget} searches` : '-', null],
      ]),
      infoCard('database', 'Data and hosting', [
        ['Storage', m.hosting.persistent ? 'Persistent database' : 'Temporary (resets between visits)', yes(m.hosting.persistent)],
        ['Host', m.hosting.host, null],
        ['Version', m.hosting.version ?? '-', null],
        ['Server health', healthRow, null, h('button', { class: 'btn small ghost', type: 'button', onclick: checkHealth }, icon('refresh', { size: 14 }), 'Recheck')],
      ]),
      infoCard('plug', 'Agent access (MCP)', [
        ['Endpoint', h('code', {}, m.mcp.endpoint), null, h('button', { class: 'btn small ghost', type: 'button', onclick: () => copy(m.mcp.endpoint, 'Endpoint') }, icon('copy', { size: 14 }), 'Copy')],
        ['Authentication', 'Bearer token, issued per session by the API', null],
        ['Rules', 'External agents pass the same policy checks and PayPal approval', 'ok'],
      ]),
    ),
    h('div', { class: 'info-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => copy(JSON.stringify({ ...m, generatedAt: new Date().toISOString() }, null, 2), 'Diagnostics') }, icon('copy', { size: 16 }), 'Copy diagnostics'),
      h('span', { class: 'muted' }, 'Contains no keys or secrets: only what is configured.')),
  );
  checkHealth();
}
