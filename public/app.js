// Mandate front-end. Plain ES modules, no build step. All dynamic text goes through text nodes (no HTML strings).
// Layout: masthead + pages (ui/shell.js), preferences (ui/prefs.js), Settings/Information pages (ui/pages.js).
import { $, h, usd, safeHref, tweenText, motionOn } from './ui/dom.js';
import { initShell, onRoute, setPendingApprovals, navigate } from './ui/shell.js';
import { getPrefs, setPref, onPrefs } from './ui/prefs.js';
import { renderSettings, renderInfo } from './ui/pages.js';

let cfg = {};
let state = null;
let sdkReady = null;
let chatBusy = false; // pause background polling while the assistant works so the progress bubble is not replaced
let gridP; let gridA;

const SUGGESTIONS = [
  'Find me an LED desk lamp under $40',
  'A mechanical keyboard under $90 and a large desk mat',
  'A 27-inch 4K monitor',
  'Get a USB-C hub with HDMI',
];

const sourceLine = (p) => h('p', { class: 'req-meta' },
  `${p.merchant} · ${p.category}`,
  safeHref(p.product_url) ? [' · ', h('a', { href: safeHref(p.product_url), target: '_blank', rel: 'noopener noreferrer' }, 'product page')] : null,
  h('span', { class: `tag ${p.price_verified ? 'ok' : 'warn'}`, title: p.price_verified ? 'The server read this price from the retailer\'s own page' : 'Price comes from the search result and was not confirmed on the retailer page' }, p.price_verified ? 'price verified' : 'price unverified'));

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
    throw Object.assign(new Error(err.message || `Request failed (${res.status})`), { status: res.status, code: err.code, details: err.details, requestId: err.requestId });
  }
  return data;
}

// ------------------------------------------------------------------ toast (optional action, e.g. Undo)
let toastTimer;
function toast(msg, bad = false, action = null) {
  const t = $('toast');
  t.className = `toast${bad ? ' bad' : ''}`;
  t.replaceChildren(...[h('span', {}, msg), action ? h('button', { class: 'toast-action', type: 'button', onclick: () => { t.hidden = true; action.run(); } }, action.label) : null].filter(Boolean));
  t.hidden = false;
  t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 8000 : 4500);
}

// ------------------------------------------------------------------ PayPal SDK (PayPal's own buttons are rendered untouched)
function loadPayPalSdk() {
  if (sdkReady) return sdkReady;
  sdkReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(cfg.paypalClientId)}&currency=${cfg.currency}&intent=capture&components=buttons`;
    const nonce = document.querySelector('meta[name=csp-nonce]')?.content; // PayPal's SDK applies this to the inline scripts it adds
    if (nonce) { s.nonce = nonce; s.setAttribute('data-csp-nonce', nonce); }
    s.onload = () => resolve(window.paypal);
    s.onerror = () => { sdkReady = null; reject(new Error('Could not load the PayPal JS SDK.')); };
    document.head.append(s);
  });
  return sdkReady;
}

async function renderPayPalButtons(p, slot) {
  if (cfg.paypalMode === 'mock') {
    slot.append(
      h('div', { class: 'actions' },
        h('button', { class: 'btn positive', onclick: () => mockApprove(p, 'ok') }, 'Approve with PayPal (simulated)'),
        h('button', { class: 'btn', onclick: () => mockApprove(p, 'decline') }, 'Simulate declined card'),
      ),
      h('p', { class: 'req-meta' }, 'Offline PayPal simulator (development only).'),
    );
    return;
  }
  if (!cfg.paypalConfigured) {
    slot.append(h('p', { class: 'req-meta' }, 'PayPal credentials are not configured on the server.'));
    return;
  }
  try {
    const paypal = await loadPayPalSdk();
    await paypal.Buttons({
      style: { layout: 'horizontal', color: 'gold', shape: 'pill', label: 'pay', height: 40, tagline: false },
      // The order already exists: the SERVER created it with server-side prices. The browser only hands back its id.
      createOrder: () => p.paypal_order_id,
      onApprove: () => capture(p.id),
      onCancel: () => toast('Approval cancelled. The order is still waiting: approve it again or dismiss it.'),
      onError: (err) => { console.error(err); toast('PayPal reported an error. You can try again or dismiss this order.', true); },
    }).render(slot);
  } catch (e) {
    slot.append(h('p', { class: 'req-meta' }, e.message));
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
    if (r.outcome === 'declined') toast('PayPal declined that payment method. The budget was released. Re-request to try again.', true);
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

const fact = (k, v, mono = false) => h('div', {}, h('dt', {}, k), h('dd', { class: mono ? 'mono' : null }, v));
const parseUsd = (str) => { const t = String(str).trim(); const n = Number(t.replace(/[$,\s]/g, '')); return t !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN; };

// ------------------------------------------------------------------ refund: two steps, with a cooling-off delay
const refundFlow = { id: null, token: null, timer: null };

function clearRefundTimer() { clearInterval(refundFlow.timer); refundFlow.timer = null; }

function openRefund(p) {
  Object.assign(refundFlow, { id: p.id, token: null });
  clearRefundTimer();
  $('refund-facts').replaceChildren(fact('Item', p.product_name), fact('Merchant', p.merchant), fact('Amount to refund', usd(p.amount_cents), true), fact('PayPal capture', p.paypal_capture_id ?? '-', true));
  $('refund-ack').checked = false;
  $('refund-ack').disabled = false;
  $('refund-count').hidden = true;
  $('refund-error').hidden = true;
  const go = $('refund-go');
  go.textContent = 'Start refund';
  go.dataset.step = 'start';
  go.disabled = true;
  $('dlg-refund').showModal();
}

async function cancelRefundRequest(quiet = false) {
  clearRefundTimer();
  if (!refundFlow.token) return;
  const id = refundFlow.id;
  refundFlow.token = null;
  try { await api(`/api/purchases/${id}/refund/request`, { method: 'DELETE' }); if (!quiet) toast('Refund request cancelled. Nothing was refunded.'); } catch { /* the request expires on its own */ }
}

async function refundGo() {
  const go = $('refund-go');
  const err = $('refund-error');
  err.hidden = true;
  if (go.dataset.step === 'start') {
    go.disabled = true;
    $('refund-ack').disabled = true;
    try {
      const r = await api(`/api/purchases/${refundFlow.id}/refund/request`, { method: 'POST' });
      refundFlow.token = r.token;
      const count = $('refund-count');
      count.hidden = false;
      const tick = () => {
        const left = Math.ceil((r.available_at - Date.now()) / 1000);
        if (left > 0) { count.textContent = `Safety delay: you can confirm in ${left}s. You can cancel any time.`; return; }
        clearRefundTimer();
        count.textContent = 'You can confirm now. The request expires in a few minutes.';
        go.textContent = 'Confirm refund';
        go.dataset.step = 'confirm';
        go.disabled = false;
        go.focus();
      };
      tick();
      if (go.dataset.step === 'start') refundFlow.timer = setInterval(tick, 250);
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
      $('refund-ack').disabled = false;
      go.disabled = !$('refund-ack').checked;
    }
    return;
  }
  go.disabled = true;
  try {
    const r = await api(`/api/purchases/${refundFlow.id}/refund/confirm`, { method: 'POST', body: { token: refundFlow.token } });
    refundFlow.token = null;
    $('dlg-refund').close();
    toast(`Refunded ${usd(r.purchase.amount_cents)} for ${r.purchase.product_name} through PayPal.`);
    await refresh();
  } catch (e) {
    err.textContent = e.message; err.hidden = false;
    if (e.code === 'TOO_EARLY') go.disabled = false;
  }
}

// ------------------------------------------------------------------ high-value purchases: type the amount first
let confirming = null;
function openConfirm(p) {
  confirming = p;
  $('confirm-facts').replaceChildren(fact('Item', p.product_name), fact('Merchant', p.merchant), fact('Amount', usd(p.amount_cents), true));
  $('confirm-amount').value = '';
  $('confirm-go').disabled = true;
  $('confirm-error').hidden = true;
  $('dlg-confirm').showModal();
  $('confirm-amount').focus();
}

async function submitConfirm(ev) {
  ev.preventDefault();
  if (!confirming || parseUsd($('confirm-amount').value) !== confirming.amount_cents) return;
  try {
    await api(`/api/purchases/${confirming.id}/confirm`, { method: 'POST', body: { amount_cents: confirming.amount_cents } });
    $('dlg-confirm').close();
    toast('Amount confirmed. You can now pay with PayPal.');
    await refresh();
  } catch (e) { $('confirm-error').textContent = e.message; $('confirm-error').hidden = false; }
}

// ------------------------------------------------------------------ rendering
let approvalsSig = '';
const seenApprovals = new Set();
let approvalsFirst = true;

const CHECKS = [['MANDATE_EXPIRED', 'Active'], ['CATEGORY_NOT_ALLOWED', 'Category'], ['DUPLICATE', 'Not a duplicate'], ['OVER_ITEM_CAP', 'Under cap'], ['OVER_BUDGET', 'Within budget'], ['OVER_PACE', 'Pace']];
const splitReason = (reason) => {
  const m = /^([A-Z_]+): (.*)$/.exec(reason ?? '');
  return m ? { code: m[1], text: m[2] } : { code: null, text: reason ?? '' };
};
/** Policy checklist: all passed for allowed purchases; the failing rule (and those after it, skipped) for blocked ones. */
function policyChecks(p) {
  const failCode = p.status === 'blocked' ? splitReason(p.reason).code : null;
  let failed = false;
  return h('div', { class: 'checks', 'aria-label': 'Policy checks' }, CHECKS.map(([code, label]) => {
    if (failed) return h('span', { class: 'check skip' }, `- ${label}`);
    if (code === failCode) { failed = true; return h('span', { class: 'check fail' }, `✗ ${label}`); }
    return h('span', { class: 'check' }, `✓ ${label}`);
  }));
}

// The statement is built once and updated in place, so the budget bar and the remaining amount animate smoothly.
const mv = {};
const term = (k, v) => h('div', { class: 'term' }, h('dt', {}, k), h('dd', {}, v));
function buildMandate() {
  mv.name = h('p', { class: 'st-name' });
  mv.remaining = h('span', { class: 'num' });
  mv.of = h('small');
  mv.spent = h('i', { class: 'spent' });
  mv.held = h('i', { class: 'held' });
  mv.bar = h('div', { class: 'bar', role: 'img' }, mv.spent, mv.held);
  mv.legendSpent = h('span', {}, h('b', { class: 'sw-spent' }), h('span'));
  mv.legendHeld = h('span', {}, h('b', { class: 'sw-held' }), h('span'));
  mv.cap = h('span'); mv.pace = h('span'); mv.exp = h('span');
  mv.cats = h('span', { class: 'cats' });
  $('mandate').replaceChildren(
    h('div', { class: 'st-main' },
      mv.name,
      h('p', { class: 'st-label' }, 'Available to spend'),
      h('p', { class: 'figure' }, mv.remaining, mv.of),
      mv.bar,
      h('div', { class: 'legend' }, mv.legendSpent, mv.legendHeld)),
    h('dl', { class: 'terms' },
      term('Per-purchase limit', mv.cap),
      term('Pace', mv.pace),
      term('Expires', mv.exp),
      term('Categories', mv.cats),
      term('Settlement', 'PayPal, human-approved')),
  );
}

function renderMandate(m) {
  if (!mv.name) buildMandate();
  const pct = (c) => `${Math.min(100, Math.max(0, (c / m.budget_cents) * 100))}%`;
  const held = m.committed_cents - m.captured_cents;
  mv.name.textContent = m.name;
  tweenText(mv.remaining, mv.last ?? m.remaining_cents, m.remaining_cents, usd);
  mv.last = m.remaining_cents;
  mv.of.textContent = `of ${usd(m.budget_cents)}`;
  mv.spent.style.width = pct(m.captured_cents);
  mv.held.style.width = pct(held);
  mv.bar.setAttribute('aria-label', `${usd(m.captured_cents)} spent, ${usd(held)} awaiting approval, ${usd(m.remaining_cents)} available`);
  mv.legendSpent.lastChild.textContent = `Spent ${usd(m.captured_cents)}`;
  mv.legendHeld.lastChild.textContent = `Awaiting approval ${usd(held)}`;
  mv.cap.textContent = usd(m.per_item_cap_cents);
  mv.pace.textContent = m.max_per_hour ? `${m.max_per_hour} requests / hour` : 'Unlimited';
  mv.exp.textContent = m.expired ? 'Expired' : (m.expires_at ? new Date(m.expires_at).toLocaleDateString() : 'Never');
  mv.exp.classList.toggle('bad-text', Boolean(m.expired));
  const catKey = m.categories.join('|');
  if (mv.catKey !== catKey) {
    mv.catKey = catKey;
    mv.cats.replaceChildren(...(m.categories.length ? m.categories.map((c) => h('span', { class: 'cat' }, c)) : [h('span', {}, 'none')]));
  }
}

let msgSig = '';
let msgCount = -1;
function renderMessages(msgs) {
  const box = $('messages');
  const sig = JSON.stringify(msgs) + getPrefs().traceOpen;
  if (sig === msgSig) return; // keep open <details> / scroll position stable across polling refreshes
  msgSig = sig;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const list = msgs.length ? msgs : [{ role: 'assistant', content: 'Tell me what you need and I will request each item. Anything outside your mandate is blocked before it reaches PayPal, and you approve every payment yourself.' }];
  const firstNew = msgCount < 0 ? Infinity : msgCount; // nothing animates on first paint; later only genuinely new replies do
  box.replaceChildren(...list.map((m, i) => {
    const enter = m.role === 'assistant' && i >= firstNew ? ' enter' : '';
    const bubble = h('div', { class: `msg ${m.role}${enter}` }, m.content);
    if (m.role !== 'assistant' || !m.trace?.length) return bubble;
    return h('div', { class: `msg-wrap${enter}` }, bubble,
      h('details', { class: 'trace', open: getPrefs().traceOpen },
        h('summary', {}, `Agent activity (${m.trace.length} step${m.trace.length === 1 ? '' : 's'})`),
        h('ol', {}, m.trace.map((t) => h('li', { class: t.ok ? '' : 'fail' }, t.text)))));
  }));
  msgCount = list.length;
  if (atBottom || msgs.length < 3) box.scrollTop = box.scrollHeight;
}

function payBlock(p, slot) {
  if (p.status !== 'pending') return h('p', { class: 'req-meta' }, p.reason || 'Processing payment...');
  if (p.needs_confirmation) {
    return h('div', { class: 'notice warn' },
      h('p', {}, h('strong', {}, `High-value purchase (${usd(p.amount_cents)}). `), 'Confirm the amount before you can pay.'),
      h('button', { class: 'btn small primary', type: 'button', onclick: () => openConfirm(p) }, 'Review and confirm'));
  }
  return h('div', { class: 'req-pay' }, slot);
}

function renderApprovals(purchases) {
  const pending = purchases.filter((p) => ['pending', 'capturing', 'reserving'].includes(p.status));
  const recent = purchases.filter((p) => !['pending', 'capturing', 'reserving'].includes(p.status)).slice(0, 6);
  $('approvals-count').textContent = pending.length ? `${pending.length} waiting` : '';
  setPendingApprovals(pending.length);
  const sig = JSON.stringify([...pending, ...recent].map((p) => [p.id, p.status, p.reason, p.needs_confirmation]));
  if (sig === approvalsSig) return;
  approvalsSig = sig;

  const root = $('approvals');
  const kids = [];
  if (!pending.length) kids.push(h('p', { class: 'empty' }, 'Nothing is waiting for you. Ask the assistant to find something, or search the web yourself. Allowed requests appear here for your approval.'));
  for (const p of pending) {
    const isNew = !approvalsFirst && !seenApprovals.has(p.id);
    const slot = h('div', { class: 'pp-slot' });
    const showButtons = p.status === 'pending' && !p.needs_confirmation;
    kids.push(h('article', { class: `req pending${isNew ? ' enter-fade' : ''}` },
      h('div', { class: 'req-head' }, h('h3', { class: 'req-title' }, `${p.product_name}${p.qty > 1 ? ` x${p.qty}` : ''}`), h('span', { class: 'req-amt' }, usd(p.amount_cents))),
      sourceLine(p),
      p.rationale ? h('p', { class: 'req-why' }, /^Requested by you/.test(p.rationale) ? p.rationale : `Assistant: ${p.rationale}`) : null,
      policyChecks(p),
      payBlock(p, slot),
      p.status === 'pending' ? h('div', { class: 'req-actions' }, h('button', { class: 'btn small danger', onclick: () => simple(`/api/purchases/${p.id}/cancel`, 'Dismissed. Budget released.') }, 'Dismiss')) : null,
    ));
    if (showButtons) queueMicrotask(() => renderPayPalButtons(p, slot));
  }
  if (recent.length) {
    kids.push(h('h2', { class: 'recent-title' }, 'Recent'));
    for (const p of recent) {
      const retry = ['declined', 'cancelled', 'expired', 'failed'].includes(p.status);
      const isNew = !approvalsFirst && !seenApprovals.has(p.id);
      kids.push(h('article', { class: `req${isNew ? ' enter' : ''}` },
        h('div', { class: 'req-head' }, h('h3', { class: 'req-title' }, p.product_name), h('span', { class: `status ${p.status}` }, p.status)),
        h('p', { class: 'req-meta' }, `${usd(p.amount_cents)}${p.paypal_capture_id ? ` · capture ${p.paypal_capture_id}` : ''}`),
        p.status === 'blocked' ? policyChecks(p) : null,
        p.reason ? h('p', { class: 'req-meta' }, splitReason(p.reason).text) : null,
        (retry || p.status === 'captured') ? h('div', { class: 'req-actions' },
          retry ? h('button', { class: 'btn small', onclick: () => simple(`/api/purchases/${p.id}/rerequest`, 'Re-requested. Approve it above.') }, 'Re-request') : null,
          p.status === 'captured' ? h('button', { class: 'btn small danger', onclick: () => openRefund(p) }, 'Refund…') : null,
        ) : null,
      ));
    }
  }
  for (const p of purchases) seenApprovals.add(p.id);
  approvalsFirst = false;
  root.replaceChildren(...kids);
}

// ------------------------------------------------------------------ ledger (AG Grid), created the first time the page opens
const statusRenderer = (params) => h('span', { class: `status ${params.value}` }, params.value);
const timeFmt = (p) => new Date(p.value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/** AG Grid theme built from the app's own CSS variables, so the grid follows the light/dark theme, accent and density. */
function gridTheme() {
  const dark = document.documentElement.dataset.scheme === 'dark';
  const compact = document.documentElement.dataset.density === 'compact';
  return window.agGrid.themeQuartz.withParams({
    browserColorScheme: dark ? 'dark' : 'light',
    backgroundColor: cssVar('--surface'),
    foregroundColor: cssVar('--ink'),
    headerBackgroundColor: cssVar('--surface-2'),
    headerTextColor: cssVar('--ink-2'),
    borderColor: cssVar('--line'),
    accentColor: cssVar('--accent-text'),
    oddRowBackgroundColor: cssVar('--surface-2'),
    rowHoverColor: cssVar('--accent-soft'),
    fontFamily: 'inherit',
    wrapperBorderRadius: 0,
    borderRadius: 2,
    spacing: compact ? 5 : 8,
  });
}

function ensureGrids() {
  if (gridP || !window.agGrid) return;
  try { window.agGrid.ModuleRegistry?.registerModules?.([window.agGrid.AllCommunityModule]); } catch { /* already registered */ }
  const common = { animateRows: motionOn(), defaultColDef: { sortable: true, filter: true, resizable: true }, theme: gridTheme() };
  gridP = window.agGrid.createGrid($('grid-purchases'), {
    ...common,
    getRowId: (p) => p.data.id,
    columnDefs: [
      { field: 'created_at', headerName: 'Time', valueFormatter: timeFmt, width: 125, sort: 'desc' },
      { field: 'product_name', headerName: 'Item', flex: 1.4, minWidth: 160 },
      { field: 'merchant', width: 130 },
      { field: 'product_url', headerName: 'Link', width: 90, sortable: false, filter: false,
        cellRenderer: (params) => (safeHref(params.value) ? h('a', { href: safeHref(params.value), target: '_blank', rel: 'noopener noreferrer' }, 'open') : '') },
      { field: 'qty', width: 80 },
      { field: 'amount_cents', headerName: 'Amount', valueFormatter: (p) => usd(p.value), width: 100, type: 'rightAligned', cellStyle: { fontFamily: 'var(--font-mono)' } },
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
      { field: 'created_at', headerName: 'Time', valueFormatter: timeFmt, width: 125 },
      { field: 'type', width: 190 },
      { field: 'product_name', headerName: 'Item', width: 200 },
      { field: 'detail', flex: 1, minWidth: 300, tooltipField: 'detail' },
    ],
    tooltipShowDelay: 300,
  });
  if (state) { gridP.setGridOption('rowData', state.purchases); gridA.setGridOption('rowData', state.audit); }
}

function render(s) {
  state = s;
  renderMandate(s.mandate);
  if (!chatBusy) renderMessages(s.messages); // keep the progress bubble while the assistant works
  renderApprovals(s.purchases);
  gridP?.setGridOption('rowData', s.purchases);
  gridA?.setGridOption('rowData', s.audit);
}

async function refresh() {
  try { render(await api('/api/state')); } catch (e) { console.error(e); }
}

// ------------------------------------------------------------------ chat
function thinkingBubble(who) {
  const label = h('span', { class: 'think-text' }, `${who} is searching the web and checking your mandate...`);
  return { label, el: h('div', { class: 'msg assistant thinking', id: 'thinking' }, h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), label) };
}

async function send(text) {
  const input = $('chat-input');
  const msg = (text ?? input.value).trim();
  if (!msg) return;
  input.value = '';
  $('chat-send').disabled = true;
  chatBusy = true;
  const box = $('messages');
  const who = { gemini: 'Gemini', claude: 'Claude' }[cfg.agentMode] ?? 'The assistant';
  const started = Date.now();
  const { el, label } = thinkingBubble(who);
  const live = setInterval(refresh, 2000); // requests appear as the assistant proposes them
  const tick = setInterval(() => { label.textContent = `${who} is searching the web and checking your mandate... ${Math.round((Date.now() - started) / 1000)}s`; }, 1000);
  box.append(h('div', { class: 'msg user enter' }, msg), el);
  box.scrollTop = box.scrollHeight;
  try {
    await api('/api/chat', { method: 'POST', body: { message: msg } });
  } catch (e) {
    toast(e.message, true);
  } finally {
    clearInterval(tick);
    clearInterval(live);
    chatBusy = false;
    $('chat-send').disabled = false;
    msgSig = ''; // force a repaint so the final reply replaces the progress bubble
    await refresh();
    input.focus();
  }
}

// ------------------------------------------------------------------ mandate editor (increases need an explicit confirmation)
let editNeedsConfirm = false;

function resetEditConfirm() {
  editNeedsConfirm = false;
  $('edit-confirm').hidden = true;
  $('edit-ack').checked = false;
  $('edit-save').disabled = false;
  $('edit-save').textContent = 'Save mandate';
}

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
  resetEditConfirm();
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
      confirm_increase: editNeedsConfirm && $('edit-ack').checked,
    } });
    $('dlg-edit').close();
    toast('Mandate updated.');
    await refresh();
  } catch (e) {
    if (e.code === 'CONFIRMATION_REQUIRED' && e.details?.changes) {
      editNeedsConfirm = true;
      $('edit-changes').replaceChildren(...e.details.changes.map((c) => h('li', {}, `${c.field}: ${c.from} → ${c.to}`)));
      $('edit-confirm').hidden = false;
      $('edit-ack').checked = false;
      $('edit-save').textContent = 'Confirm and apply';
      $('edit-save').disabled = true;
      $('edit-error').hidden = true;
      return;
    }
    $('edit-error').textContent = e.message;
    $('edit-error').hidden = false;
  }
}

// ------------------------------------------------------------------ manual web search
function renderResults(offers, skipped) {
  const box = $('search-results');
  if (!offers.length) {
    box.replaceChildren(h('p', { class: 'empty' }, 'No product pages with a readable price turned up for that. Try a more specific product name.'));
    return;
  }
  const rows = offers.map((o, i) => h('article', { class: `offer enter${o.fits_mandate ? '' : ' outside'}`, style: `--i:${i}` },
    h('div', { class: 'offer-body' },
      h('h3', { class: 'offer-title' }, o.title),
      h('p', { class: 'offer-meta' },
        `${o.merchant} · ${o.category}`,
        safeHref(o.url) ? [' · ', h('a', { href: safeHref(o.url), target: '_blank', rel: 'noopener noreferrer' }, 'product page')] : null,
        h('span', { class: `tag ${o.price_verified ? 'ok' : 'warn'}` }, o.price_verified ? 'price verified' : 'price unverified'),
        h('span', { class: `tag ${o.fits_mandate ? 'ok' : 'warn'}`, title: o.mandate_issue || 'Within your mandate' }, o.fits_mandate ? 'fits mandate' : 'outside mandate')),
      o.mandate_issue ? h('p', { class: 'offer-note' }, o.mandate_issue.replace(/^[A-Z_]+: /, '')) : null),
    h('div', { class: 'offer-side' },
      h('p', { class: 'offer-price' }, usd(Math.round(o.price_usd * 100))),
      h('button', { class: 'btn small positive', type: 'button', onclick: (e) => requestOffer(o, e.currentTarget) }, 'Request purchase')),
  ));
  if (skipped) rows.push(h('p', { class: 'muted' }, skipped));
  box.replaceChildren(...rows);
}

async function requestOffer(o, btn) {
  btn.disabled = true;
  try {
    const r = await api(`/api/offers/${encodeURIComponent(o.offer_id)}/request`, { method: 'POST', body: { qty: 1 } });
    toast(r.allowed ? `Requested "${o.title.slice(0, 40)}". Approve it under Account.` : (r.reason || 'Blocked by your mandate.'), !r.allowed,
      r.allowed ? { label: 'Go to Account', run: () => navigate('overview') } : null);
  } catch (e) { toast(e.message, true); }
  btn.disabled = false;
  await refresh();
}

const skeletons = () => [0, 1, 2].map((i) => h('div', { class: 'offer skeleton', style: `--i:${i}`, 'aria-hidden': 'true' }, h('div', {}, h('i', { class: 'sk w60' }), h('i', { class: 'sk w40' }), h('i', { class: 'sk w80' }))));

async function runSearch(e) {
  e.preventDefault();
  const query = $('search-input').value.trim();
  if (query.length < 2) return;
  const max = Number($('search-max').value);
  const btn = $('search-btn');
  btn.disabled = true;
  btn.textContent = 'Searching...';
  $('search-results').replaceChildren(h('p', { class: 'muted search-status' }, 'Searching the web and checking each price on the retailer page (about 10 seconds)...'), ...skeletons());
  try {
    const r = await api('/api/search', { method: 'POST', body: { query, ...(max > 0 ? { max_price_usd: max } : {}) } });
    renderResults(r.offers, r.skipped);
  } catch (err) {
    $('search-results').replaceChildren(h('p', { class: 'empty' }, err.message));
  }
  btn.disabled = false;
  btn.textContent = 'Search';
}

// ------------------------------------------------------------------ boot
function renderChips() {
  const on = getPrefs().showChips;
  $('chips').hidden = !on;
  $('chips').replaceChildren(...(on ? [h('span', { class: 'suggest-label' }, 'Try:'), ...SUGGESTIONS.map((s) => h('button', { type: 'button', onclick: () => send(s) }, s))] : []));
}
const syncHint = () => { const p = getPrefs(); $('how-hint').hidden = !(p.showHint && !p.hintDismissed); };

async function boot() {
  initShell();
  cfg = await api('/api/config');

  const brand = { gemini: 'Gemini', claude: 'Claude' }[cfg.agentMode];
  $('agent-note').textContent = brand ? `${brand} with web search` : 'no AI key configured';

  const notices = [];
  if (cfg.paypalMode !== 'mock' && !cfg.paypalConfigured) {
    notices.push('PayPal credentials are missing: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (see README). The assistant and policy engine still work, but orders cannot be created.');
  }
  if (!cfg.webSearch) {
    notices.push('Live product search is off: set TAVILY_API_KEY (free tier), SERPER_API_KEY or GEMINI_API_KEY. A search provider finds product pages; the server verifies each price itself.');
  }
  if (cfg.persistent === false) {
    notices.push('This deployment has no persistent database (set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN): your session and purchases can disappear between requests.');
  }
  if (notices.length) {
    const b = $('banner');
    b.hidden = false;
    b.textContent = notices.join(' ');
  }

  renderSettings($('settings-content'), { toast });
  renderInfo($('info-content'), cfg, { toast });
  $('search-card').hidden = !cfg.webSearch;
  $('search-off').hidden = Boolean(cfg.webSearch);

  renderChips();
  syncHint();
  onPrefs((p, key) => {
    if (key === 'showChips' || key === '*') renderChips();
    if (key === 'showHint' && p.showHint && p.hintDismissed) setPref('hintDismissed', false);
    if (key === 'traceOpen') renderMessages(state?.messages ?? []);
    if (['theme', 'accent', 'density', 'system', '*'].includes(key) && gridP) {
      const theme = gridTheme();
      gridP.setGridOption('theme', theme);
      gridA.setGridOption('theme', theme);
    }
    syncHint();
  });
  $('how-hint-dismiss').addEventListener('click', () => setPref('hintDismissed', true));

  $('chat-form').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  $('search-form').addEventListener('submit', runSearch);

  $('btn-edit').addEventListener('click', openEditor);
  $('edit-save').addEventListener('click', saveEditor);
  $('form-edit').addEventListener('input', (e) => { if (editNeedsConfirm && e.target.id !== 'edit-ack') resetEditConfirm(); });
  $('edit-ack').addEventListener('change', () => { $('edit-save').disabled = !$('edit-ack').checked; });

  $('refund-ack').addEventListener('change', () => { if ($('refund-go').dataset.step === 'start') $('refund-go').disabled = !$('refund-ack').checked; });
  $('refund-go').addEventListener('click', refundGo);
  $('refund-cancel').addEventListener('click', () => $('dlg-refund').close());
  $('dlg-refund').addEventListener('close', () => { cancelRefundRequest(); });

  $('confirm-amount').addEventListener('input', () => { $('confirm-go').disabled = !confirming || parseUsd($('confirm-amount').value) !== confirming.amount_cents; });
  $('form-confirm').addEventListener('submit', submitConfirm);
  $('confirm-cancel').addEventListener('click', () => $('dlg-confirm').close());

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => { x.classList.toggle('active', x === t); x.setAttribute('aria-selected', x === t); });
    $('grid-purchases').hidden = t.dataset.tab !== 'purchases';
    $('grid-audit').hidden = t.dataset.tab !== 'audit';
  }));
  onRoute((route) => { if (route === 'ledger') ensureGrids(); });
  if (document.querySelector('.page:not([hidden])')?.dataset.page === 'ledger') ensureGrids();

  await refresh();
  // Picks up webhook-driven changes (e.g. capture completed server-side) without a manual reload.
  setInterval(() => { if (!document.hidden && !chatBusy) refresh(); }, 5000);
}

boot().catch((e) => { console.error(e); toast('Failed to start the app.', true); });
