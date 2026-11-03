// Mandate front-end. Plain ES modules, no build step. All dynamic text goes through textContent (no innerHTML).
const $ = (id) => document.getElementById(id);
const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

let cfg = {};
let state = null;
let sdkReady = null;
let sandboxHintShown = false;
let gridP; let gridA;
const SUGGESTIONS = [
  'Set up my desk: a lamp under $40, a mechanical keyboard and a 4K monitor',
  'Add a felt desk mat and a USB-C hub',
  'Buy the premium architect lamp',
  'An ergonomic chair',
];

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const err = data.error ?? {};
    throw Object.assign(new Error(err.message || `Request failed (${res.status})`), { status: res.status, code: err.code, requestId: err.requestId });
  }
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast${bad ? ' bad' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

// ------------------------------------------------------------------ PayPal SDK
function loadPayPalSdk() {
  if (sdkReady) return sdkReady;
  sdkReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(cfg.paypalClientId)}&currency=${cfg.currency}&intent=capture&components=buttons`;
    s.onload = () => resolve(window.paypal);
    s.onerror = () => { sdkReady = null; reject(new Error('Could not load the PayPal JS SDK.')); };
    document.head.append(s);
  });
  return sdkReady;
}

async function renderPayPalButtons(p, slot) {
  if (cfg.paypalMode === 'sandbox' && cfg.paypalConfigured && !sandboxHintShown) {
    sandboxHintShown = true;
    slot.after(h('div', { class: 'hint' }, 'PayPal Sandbox: sign in with your sandbox buyer account (no real money moves).'));
  }
  if (cfg.paypalMode === 'mock') {
    slot.append(
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: () => mockApprove(p, 'ok') }, 'Approve with PayPal (simulated)'),
        h('button', { class: 'btn ghost', onclick: () => mockApprove(p, 'decline') }, 'Simulate declined card'),
      ),
      h('div', { class: 'pmeta' }, 'Offline PayPal simulator - real sandbox buttons appear when PAYPAL_MODE=sandbox.'),
    );
    return;
  }
  if (!cfg.paypalConfigured) {
    slot.append(h('div', { class: 'pmeta' }, 'PayPal sandbox credentials are not configured on the server.'));
    return;
  }
  try {
    const paypal = await loadPayPalSdk();
    await paypal.Buttons({
      style: { layout: 'horizontal', color: 'gold', shape: 'pill', label: 'pay', height: 40, tagline: false },
      // The order already exists: the SERVER created it with server-side prices. The browser only hands back its id.
      createOrder: () => p.paypal_order_id,
      onApprove: () => capture(p.id),
      onCancel: () => toast('Approval cancelled. The order is still pending - approve it again or dismiss it.'),
      onError: (err) => { console.error(err); toast('PayPal reported an error. You can try again or dismiss this order.', true); },
    }).render(slot);
  } catch (e) {
    slot.append(h('div', { class: 'pmeta' }, e.message));
  }
}

async function mockApprove(p, outcome) {
  await fetch(`/mock-paypal/_sim/approve/${encodeURIComponent(p.paypal_order_id)}?outcome=${outcome}`, { method: 'POST' });
  await capture(p.id);
}

// ------------------------------------------------------------------ actions
async function capture(id) {
  try {
    const r = await api(`/api/purchases/${id}/capture`, { method: 'POST' });
    if (r.outcome === 'declined') toast('PayPal declined that payment method. The budget was released - re-request to try again.', true);
    else if (r.outcome === 'pending_review') toast('Payment is under PayPal review; it will finalise automatically.');
    else toast(`Paid ${usd(r.purchase.amount_cents)} for ${r.purchase.product_name} via PayPal.`);
  } catch (e) {
    toast(e.message, true);
  }
  await refresh();
}

async function simple(path, okMsg) {
  try {
    const r = await api(path, { method: 'POST' });
    if (okMsg) toast(r.allowed === false ? (r.reason || 'Blocked') : okMsg, r.allowed === false);
  } catch (e) { toast(e.message, true); }
  await refresh();
}

// ------------------------------------------------------------------ rendering
let approvalsSig = '';

const CHECKS = [['MANDATE_EXPIRED', 'Active'], ['CATEGORY_NOT_ALLOWED', 'Category'], ['DUPLICATE', 'Not a duplicate'], ['OVER_ITEM_CAP', 'Under cap'], ['OVER_BUDGET', 'Within budget'], ['OVER_PACE', 'Pace']];
const splitReason = (reason) => {
  const m = /^([A-Z_]+): (.*)$/.exec(reason ?? '');
  return m ? { code: m[1], text: m[2] } : { code: null, text: reason ?? '' };
};
/** Policy checklist: all green for allowed purchases; the failing rule (and those after it, skipped) for blocked ones. */
function policyChecks(p) {
  const failCode = p.status === 'blocked' ? splitReason(p.reason).code : null;
  let failed = false;
  return h('div', { class: 'checks', 'aria-label': 'Policy checks' }, CHECKS.map(([code, label]) => {
    if (failed) return h('span', { class: 'check skip' }, `- ${label}`);
    if (code === failCode) { failed = true; return h('span', { class: 'check fail' }, `\u2717 ${label}`); }
    return h('span', { class: 'check' }, `\u2713 ${label}`);
  }));
}

function renderMandate(m) {
  const pct = (c) => `${Math.min(100, (c / m.budget_cents) * 100)}%`;
  const held = m.committed_cents - m.captured_cents;
  $('mandate').replaceChildren(
    h('div', { class: 'm-name' }, m.name),
    h('div', { class: 'm-remaining' }, usd(m.remaining_cents), ' ', h('small', {}, `left of ${usd(m.budget_cents)}`)),
    h('div', { class: 'bar', role: 'img', 'aria-label': `${usd(m.captured_cents)} spent, ${usd(held)} awaiting approval, ${usd(m.remaining_cents)} remaining` },
      h('i', { class: 'spent', style: `width:${pct(m.captured_cents)}` }),
      h('i', { class: 'held', style: `width:${pct(held)}` })),
    h('div', { class: 'legend' },
      h('span', {}, h('b', { style: 'background:var(--ok)' }), `Spent ${usd(m.captured_cents)}`),
      h('span', {}, h('b', { style: 'background:#f5a623' }), `Awaiting approval ${usd(held)}`)),
    h('div', { class: 'rules' },
      h('div', {}, h('span', {}, 'Per-purchase cap'), h('b', {}, usd(m.per_item_cap_cents))),
      h('div', {}, h('span', {}, 'Pace'), h('b', {}, m.max_per_hour ? `${m.max_per_hour} requests / hour` : 'Unlimited')),
      h('div', {}, h('span', {}, 'Expires'), m.expired ? h('b', { style: 'color:var(--bad)' }, 'Expired') : h('b', {}, m.expires_at ? new Date(m.expires_at).toLocaleDateString() : 'Never')),
      h('div', {}, h('span', {}, 'Allowed'), h('span', { class: 'cats' }, m.categories.length ? m.categories.map((c) => h('span', { class: 'cat' }, c)) : h('span', { class: 'muted' }, 'nothing'))),
      h('div', {}, h('span', {}, 'Settlement'), h('b', {}, 'PayPal, human-approved'))),
  );
}

let msgSig = '';
function renderMessages(msgs) {
  const box = $('messages');
  const sig = JSON.stringify(msgs);
  if (sig === msgSig) return; // keep open <details> / scroll position stable across polling refreshes
  msgSig = sig;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const list = msgs.length ? msgs : [{ role: 'assistant', content: 'Hi! I shop within your mandate. Tell me what you need and I will request each item. Anything outside the rules gets blocked before it ever reaches PayPal.' }];
  box.replaceChildren(...list.map((m) => {
    const bubble = h('div', { class: `msg ${m.role}` }, m.content);
    if (m.role !== 'assistant' || !m.trace?.length) return bubble;
    return h('div', { class: 'msg-wrap' }, bubble,
      h('details', { class: 'trace' },
        h('summary', {}, `Agent activity (${m.trace.length} step${m.trace.length === 1 ? '' : 's'})`),
        h('ol', {}, m.trace.map((t) => h('li', { class: t.ok ? '' : 'fail' }, t.text)))));
  }));
  if (atBottom || msgs.length < 3) box.scrollTop = box.scrollHeight;
}

function renderApprovals(purchases) {
  const pending = purchases.filter((p) => ['pending', 'capturing', 'reserving'].includes(p.status));
  const recent = purchases.filter((p) => !['pending', 'capturing', 'reserving'].includes(p.status)).slice(0, 6);
  $('approvals-count').textContent = pending.length ? `${pending.length} waiting` : '';
  const sig = JSON.stringify([...pending, ...recent].map((p) => [p.id, p.status, p.reason]));
  if (sig === approvalsSig) return;
  approvalsSig = sig;
  sandboxHintShown = false;

  const root = $('approvals');
  const kids = [];
  if (!pending.length) kids.push(h('div', { class: 'empty' }, 'Nothing waiting. Ask the agent to buy something - allowed purchases land here for one-tap PayPal approval.'));
  for (const p of pending) {
    const slot = h('div', { class: 'pp-slot' });
    kids.push(h('div', { class: 'pcard pending' },
      h('div', { class: 'prow' }, h('span', { class: 'pname' }, `${p.product_name}${p.qty > 1 ? ` x${p.qty}` : ''}`), h('span', { class: 'pamt' }, usd(p.amount_cents))),
      h('div', { class: 'pmeta' }, `${p.merchant} - ${p.category}`),
      p.rationale ? h('div', { class: 'why' }, `Agent: ${p.rationale}`) : null,
      policyChecks(p),
      p.status === 'pending' ? slot : h('div', { class: 'pmeta' }, p.reason || 'Processing payment...'),
      p.status === 'pending' ? h('div', { class: 'actions' }, h('button', { class: 'btn small ghost danger', onclick: () => simple(`/api/purchases/${p.id}/cancel`, 'Dismissed. Budget released.') }, 'Dismiss')) : null,
    ));
    if (p.status === 'pending') queueMicrotask(() => renderPayPalButtons(p, slot));
  }
  if (recent.length) {
    kids.push(h('div', { class: 'recent-title' }, 'Recent'));
    for (const p of recent) {
      const retry = ['declined', 'cancelled', 'expired', 'failed'].includes(p.status);
      kids.push(h('div', { class: 'pcard' },
        h('div', { class: 'prow' }, h('span', { class: 'pname' }, p.product_name), h('span', { class: `status ${p.status}` }, p.status)),
        h('div', { class: 'pmeta' }, `${usd(p.amount_cents)}${p.paypal_capture_id ? ` - capture ${p.paypal_capture_id}` : ''}`),
        p.status === 'blocked' ? policyChecks(p) : null,
        p.reason ? h('div', { class: 'pmeta' }, splitReason(p.reason).text) : null,
        (retry || p.status === 'captured') ? h('div', { class: 'actions' },
          retry ? h('button', { class: 'btn small', onclick: () => simple(`/api/purchases/${p.id}/rerequest`, 'Re-requested - approve it above.') }, 'Re-request') : null,
          p.status === 'captured' ? h('button', { class: 'btn small ghost', onclick: () => simple(`/api/purchases/${p.id}/refund`, 'Refunded through PayPal.') }, 'Refund') : null,
        ) : null,
      ));
    }
  }
  root.replaceChildren(...kids);
}

const statusRenderer = (params) => h('span', { class: `status ${params.value}` }, params.value);
const timeFmt = (p) => new Date(p.value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function ensureGrids() {
  if (gridP || !window.agGrid) return;
  try { window.agGrid.ModuleRegistry?.registerModules?.([window.agGrid.AllCommunityModule]); } catch { /* already registered */ }
  const common = { animateRows: true, defaultColDef: { sortable: true, filter: true, resizable: true }, theme: window.agGrid.themeQuartz };
  gridP = window.agGrid.createGrid($('grid-purchases'), {
    ...common,
    getRowId: (p) => p.data.id,
    columnDefs: [
      { field: 'created_at', headerName: 'Time', valueFormatter: timeFmt, width: 110, sort: 'desc' },
      { field: 'product_name', headerName: 'Item', flex: 1.4, minWidth: 160 },
      { field: 'merchant', width: 120 },
      { field: 'qty', width: 80 },
      { field: 'amount_cents', headerName: 'Amount', valueFormatter: (p) => usd(p.value), width: 100, type: 'rightAligned' },
      { field: 'status', cellRenderer: statusRenderer, width: 120 },
      { field: 'reason', headerName: 'Policy / note', flex: 1.6, minWidth: 200, tooltipField: 'reason' },
      { field: 'paypal_order_id', headerName: 'PayPal order', width: 150 },
      { field: 'paypal_capture_id', headerName: 'PayPal capture', width: 150 },
    ],
    tooltipShowDelay: 300,
  });
  gridA = window.agGrid.createGrid($('grid-audit'), {
    ...common,
    getRowId: (p) => String(p.data.id),
    columnDefs: [
      { field: 'id', headerName: '#', width: 70, sort: 'desc' },
      { field: 'created_at', headerName: 'Time', valueFormatter: timeFmt, width: 110 },
      { field: 'type', width: 190 },
      { field: 'product_name', headerName: 'Item', width: 200 },
      { field: 'detail', flex: 1, minWidth: 300, tooltipField: 'detail' },
    ],
    tooltipShowDelay: 300,
  });
}

function render(s) {
  state = s;
  renderMandate(s.mandate);
  renderMessages(s.messages);
  renderApprovals(s.purchases);
  ensureGrids();
  gridP?.setGridOption('rowData', s.purchases);
  gridA?.setGridOption('rowData', s.audit);
}

async function refresh() {
  try { render(await api('/api/state')); } catch (e) { console.error(e); }
}

// ------------------------------------------------------------------ chat
async function send(text) {
  const input = $('chat-input');
  const msg = (text ?? input.value).trim();
  if (!msg) return;
  input.value = '';
  $('chat-send').disabled = true;
  const box = $('messages');
  box.append(h('div', { class: 'msg user' }, msg), h('div', { class: 'msg assistant thinking', id: 'thinking' }, 'Checking the catalog and your mandate...'));
  box.scrollTop = box.scrollHeight;
  try {
    await api('/api/chat', { method: 'POST', body: { message: msg } });
  } catch (e) {
    toast(e.message, true);
  } finally {
    $('chat-send').disabled = false;
    await refresh();
    input.focus();
  }
}

// ------------------------------------------------------------------ mandate editor
function openEditor() {
  const m = state.mandate;
  const f = $('form-edit');
  f.elements.name.value = m.name;
  f.elements.budget.value = m.budget_cents / 100;
  f.elements.cap.value = m.per_item_cap_cents / 100;
  f.elements.pace.value = m.max_per_hour ?? '';
  f.elements.expires.value = m.expires_at ? new Date(m.expires_at).toISOString().slice(0, 10) : '';
  $('edit-cats').replaceChildren(...state.categories.map((c) => h('label', {}, h('input', { type: 'checkbox', value: c, checked: m.categories.includes(c) }), c)));
  $('edit-error').hidden = true;
  $('dlg-edit').showModal();
}

async function saveEditor(ev) {
  ev.preventDefault();
  const f = $('form-edit');
  try {
    await api('/api/mandate', { method: 'PUT', body: {
      name: f.elements.name.value,
      budget_cents: Math.round(Number(f.elements.budget.value) * 100),
      per_item_cap_cents: Math.round(Number(f.elements.cap.value) * 100),
      categories: [...$('edit-cats').querySelectorAll('input:checked')].map((i) => i.value),
      max_per_hour: f.elements.pace.value === '' ? null : Number(f.elements.pace.value),
      // end of the chosen day, local time
      expires_at: f.elements.expires.value === '' ? null : new Date(`${f.elements.expires.value}T23:59:59`).getTime(),
    } });
    $('dlg-edit').close();
    toast('Mandate updated.');
    await refresh();
  } catch (e) {
    $('edit-error').textContent = e.message;
    $('edit-error').hidden = false;
  }
}

// ------------------------------------------------------------------ connect an agent (MCP)
async function openConnect() {
  const info = await api('/api/connect');
  $('connect-empty').hidden = false;
  $('connect-ready').hidden = true;
  $('btn-gen').textContent = info.connected ? 'Generate a new token (revokes the old one)' : 'Generate connection token';
  $('btn-revoke').hidden = !info.connected;
  $('dlg-connect').showModal();
}

async function generateToken() {
  try {
    const r = await api('/api/connect', { method: 'POST' });
    $('c-url').value = r.url;
    $('c-token').value = r.token;
    $('c-cmd').value = `claude mcp add --transport http mandate ${r.url} --header "Authorization: Bearer ${r.token}"`;
    $('connect-empty').hidden = true;
    $('connect-ready').hidden = false;
    $('btn-revoke').hidden = false;
    await refresh();
  } catch (e) { toast(e.message, true); }
}

async function revokeToken() {
  try { await api('/api/connect', { method: 'DELETE' }); $('dlg-connect').close(); toast('External agent access revoked.'); await refresh(); } catch (e) { toast(e.message, true); }
}

// ------------------------------------------------------------------ boot
async function boot() {
  cfg = await api('/api/config');
  const pp = $('pill-paypal');
  pp.textContent = cfg.paypalMode === 'mock' ? 'PayPal: offline simulator' : 'PayPal: Sandbox';
  pp.classList.add(cfg.paypalMode === 'mock' || !cfg.paypalConfigured ? 'warn' : 'ok');
  const ag = $('pill-agent');
  ag.textContent = cfg.agentMode === 'claude' ? `Agent: Claude (${cfg.model})` : 'Agent: built-in (offline)';
  ag.classList.add(cfg.agentMode === 'claude' ? 'ok' : 'warn');
  $('agent-note').textContent = cfg.agentMode === 'claude' ? 'AI-powered' : 'rule-based demo agent';
  if (cfg.paypalMode === 'sandbox' && !cfg.paypalConfigured) {
    const b = $('banner');
    b.hidden = false;
    b.textContent = 'PayPal sandbox credentials are missing: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (see README) or run with PAYPAL_MODE=mock. The agent and policy engine still work, but orders cannot be created.';
  }

  $('chips').replaceChildren(...SUGGESTIONS.map((s) => h('button', { class: 'chip', type: 'button', onclick: () => send(s) }, s)));
  $('chat-form').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  $('btn-edit').addEventListener('click', openEditor);
  $('btn-connect').addEventListener('click', () => openConnect().catch((e) => toast(e.message, true)));
  $('btn-gen').addEventListener('click', generateToken);
  $('btn-revoke').addEventListener('click', revokeToken);
  $('btn-close-connect').addEventListener('click', () => $('dlg-connect').close());
  document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    const el = $(b.dataset.copy);
    try { await navigator.clipboard.writeText(el.value); toast('Copied.'); } catch { el.select(); toast('Press Ctrl+C to copy.'); }
  }));
  $('edit-save').addEventListener('click', saveEditor);
  $('btn-reset').addEventListener('click', async () => {
    if (!confirm('Reset this demo session? Purchases, history and mandate are restored to defaults.')) return;
    approvalsSig = '';
    await api('/api/reset', { method: 'POST' });
    await refresh();
    toast('Demo reset.');
  });
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => { x.classList.toggle('active', x === t); x.setAttribute('aria-selected', x === t); });
    $('grid-purchases').hidden = t.dataset.tab !== 'purchases';
    $('grid-audit').hidden = t.dataset.tab !== 'audit';
  }));

  await refresh();
  // Picks up webhook-driven changes (e.g. capture completed server-side) without a manual reload.
  setInterval(() => { if (!document.hidden) refresh(); }, 5000);
}

boot().catch((e) => { console.error(e); toast('Failed to start the app.', true); });
