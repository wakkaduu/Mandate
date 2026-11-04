// Mandate front-end. Plain ES modules, no build step. All dynamic text goes through text nodes (no HTML strings).
// Layout: masthead + pages (ui/shell.js), preferences (ui/prefs.js), Settings/Information pages (ui/pages.js).
import { $, h, usd, safeHref, tweenText, motionOn } from './ui/dom.js';
import { initShell, onRoute, setPendingApprovals, navigate, currentRoute } from './ui/shell.js';
import { getPrefs, setPref, onPrefs } from './ui/prefs.js';
import { icon } from './ui/icons.js';
import { renderSettings, renderInfo } from './ui/pages.js';
import { initMotion, progress, celebrate, flashRow } from './ui/motion.js';
import { initTour, openTour, tourSeen } from './ui/tour.js';

let cfg = {};
let state = null;
let sdkReady = null;
let chatBusy = false; // pause background polling while the assistant works so the progress bubble is not replaced
let searching = false;
let lockSig = null;     // last applied "mandate is set up" state, so the locked/unlocked UI only re-renders when it changes
let gridP; let gridA;

const tick = () => { const s = icon('check', { size: 18, cls: 'tick' }); s.setAttribute('stroke-width', '2.4'); return s; };

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

let onNeedsSetup = () => {};
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
    if (err.code === 'MANDATE_NOT_SET_UP') onNeedsSetup();
    throw Object.assign(new Error(err.message || `Request failed (${res.status})`), { status: res.status, code: err.code, details: err.details, requestId: err.requestId });
  }
  return data;
}

// ------------------------------------------------------------------ toast (optional action, e.g. Undo; `ok` draws a check mark)
let toastTimer;
function toast(msg, bad = false, action = null, ok = false) {
  const t = $('toast');
  t.className = `toast${bad ? ' bad' : ''}`;
  t.replaceChildren(...[ok && !bad ? tick() : null, h('span', {}, msg), action ? h('button', { class: 'toast-action', type: 'button', onclick: () => { t.hidden = true; action.run(); } }, action.label) : null].filter(Boolean));
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
let celebrateAfterRefresh = false;
async function capture(id) {
  try {
    const r = await api(`/api/purchases/${id}/capture`, { method: 'POST' });
    if (r.outcome === 'declined') toast('PayPal declined that payment method. The budget was released. Re-request to try again.', true);
    else if (r.outcome === 'pending_review') toast('Payment is under PayPal review; it will finalise automatically.');
    else { toast(`Paid ${usd(r.purchase.amount_cents)} for ${r.purchase.product_name} via PayPal.`, false, null, true); celebrateAfterRefresh = true; }
  } catch (e) {
    toast(e.message, true);
  }
  await refresh();
  if (celebrateAfterRefresh) { celebrateAfterRefresh = false; celebrate(); }
}

/** Slide the row out first, then release the budget. */
async function dismiss(id, row) {
  if (row && motionOn()) { row.classList.add('leaving'); await new Promise((r) => setTimeout(r, 280)); }
  await simple(`/api/purchases/${id}/cancel`, 'Dismissed. Budget released.');
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
    toast(`Refunded ${usd(r.purchase.amount_cents)} for ${r.purchase.product_name} through PayPal.`, false, null, true);
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
    toast('Amount confirmed. You can now pay with PayPal.', false, null, true);
    await refresh();
  } catch (e) { $('confirm-error').textContent = e.message; $('confirm-error').hidden = false; }
}

// ------------------------------------------------------------------ rendering
let approvalsSig = '';
const seenApprovals = new Set();
let approvalsFirst = true;

const CHECKS = [[['MANDATE_EXPIRED'], 'Active'], [['CATEGORY_NOT_ALLOWED'], 'Category'], [['SELLER_BLOCKED', 'SELLER_NOT_ALLOWED'], 'Seller'], [['DUPLICATE'], 'Not a duplicate'], [['OVER_ITEM_CAP'], 'Under cap'], [['OVER_BUDGET'], 'Within budget'], [['OVER_DAILY'], 'Daily limit'], [['OVER_PACE'], 'Pace']];
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
    if (code.includes(failCode)) { failed = true; return h('span', { class: 'check fail' }, `✗ ${label}`); }
    return h('span', { class: 'check' }, `✓ ${label}`);
  }));
}

// The statement is built once and updated in place, so the budget bar and the remaining amount animate smoothly.
// Before the owner has set a mandate up it shows an empty statement with a clear next step instead.
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
  mv.cap = h('span'); mv.day = h('span'); mv.pace = h('span'); mv.exp = h('span'); mv.sellers = h('span');
  mv.cats = h('span', { class: 'cats' });
  mv.last = undefined; mv.painted = false; mv.catKey = undefined; // the first paint of a new statement counts up from $0.00
  $('mandate').replaceChildren(
    h('div', { class: 'st-main' },
      mv.name,
      h('p', { class: 'st-label' }, 'Available to spend'),
      h('p', { class: 'figure' }, mv.remaining, mv.of),
      mv.bar,
      h('div', { class: 'legend' }, mv.legendSpent, mv.legendHeld)),
    h('dl', { class: 'terms' },
      term('Per-purchase limit', mv.cap),
      term('Daily limit', mv.day),
      term('Pace', mv.pace),
      term('Expires', mv.exp),
      term('Categories', mv.cats),
      term('Sellers', mv.sellers),
      term('Settlement', 'PayPal, human-approved')),
  );
}

function buildEmptyMandate() {
  const todo = (k, v = 'You choose') => h('div', { class: 'term todo' }, h('dt', {}, k), h('dd', {}, v));
  $('mandate').replaceChildren(
    h('div', { class: 'st-main st-empty' },
      h('p', { class: 'st-name' }, 'No mandate yet'),
      h('p', { class: 'st-label' }, 'Available to spend'),
      h('p', { class: 'figure' }, h('span', { class: 'num' }, usd(0))),
      h('p', { class: 'st-empty-text' }, 'You decide how much the assistant may spend and what it may buy. Nothing is pre-set, and nothing can be searched or bought until you choose.'),
      h('div', { class: 'st-cta' }, h('button', { class: 'btn primary', type: 'button', onclick: () => openSetup() }, 'Set up my mandate'))),
    h('dl', { class: 'terms' },
      todo('Total budget'), todo('Per-purchase limit'), todo('Categories'), todo('Daily limit', 'Optional'), todo('Sellers', 'Optional'),
      term('Settlement', 'PayPal, human-approved')),
  );
}

function renderMandate(m) {
  $('mandate').removeAttribute('aria-busy');
  if (!m.configured) {
    if (mv.shown !== 'empty') { buildEmptyMandate(); mv.shown = 'empty'; }
    return;
  }
  if (mv.shown !== 'live') { buildMandate(); mv.shown = 'live'; }
  const pct = (c) => `${Math.min(100, Math.max(0, (c / m.budget_cents) * 100))}%`;
  const held = m.committed_cents - m.captured_cents;
  mv.name.textContent = m.name;
  tweenText(mv.remaining, mv.last ?? 0, m.remaining_cents, usd, mv.last === undefined ? 1200 : 480); // first paint counts up from $0.00
  mv.last = m.remaining_cents;
  mv.of.textContent = `of ${usd(m.budget_cents)}`;
  const fill = () => { mv.spent.style.width = pct(m.captured_cents); mv.held.style.width = pct(held); };
  if (!mv.painted && motionOn()) { mv.painted = true; mv.spent.style.width = '0%'; mv.held.style.width = '0%'; setTimeout(fill, 450); } else { mv.painted = true; fill(); }
  mv.bar.setAttribute('aria-label', `${usd(m.captured_cents)} spent, ${usd(held)} awaiting approval, ${usd(m.remaining_cents)} available`);
  mv.legendSpent.lastChild.textContent = `Spent ${usd(m.captured_cents)}`;
  mv.legendHeld.lastChild.textContent = `Awaiting approval ${usd(held)}`;
  mv.cap.textContent = usd(m.per_item_cap_cents);
  mv.day.textContent = m.max_per_day_cents ? `${usd(m.max_per_day_cents)} (${usd(m.spent_today_cents)} used)` : 'None';
  mv.sellers.textContent = m.allowed_sellers.length ? `Only ${m.allowed_sellers.length} allowed${m.blocked_sellers.length ? `, ${m.blocked_sellers.length} blocked` : ''}` : (m.blocked_sellers.length ? `${m.blocked_sellers.length} blocked` : 'Any');
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
  const ready = Boolean(state?.mandate.configured);
  const sig = JSON.stringify(msgs) + getPrefs().traceOpen + ready;
  if (sig === msgSig) return; // keep open <details> / scroll position stable across polling refreshes
  msgSig = sig;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const list = msgs.length ? msgs : [{ role: 'assistant', content: ready
    ? 'Tell me what you need and I will request each item. Anything outside your mandate is blocked before it reaches PayPal, and you approve every payment yourself.'
    : 'Hello. Before I can help, set up your mandate so I know how much I may spend and what I may buy. Then tell me what you need and I will request each item for your approval.' }];
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
  const ready = Boolean(state?.mandate.configured);
  const sig = JSON.stringify([ready, ...[...pending, ...recent].map((p) => [p.id, p.status, p.reason, p.needs_confirmation])]);
  if (sig === approvalsSig) return;
  approvalsSig = sig;

  const root = $('approvals');
  root.removeAttribute('aria-busy');
  const kids = [];
  if (!pending.length) kids.push(h('p', { class: 'empty' }, ready
    ? 'Nothing is waiting for you. Ask the assistant to find something, or search the web yourself. Allowed requests appear here for your approval.'
    : 'Nothing yet. Once your mandate is set up, requests from the assistant or your own searches wait here for your approval.'));
  for (const p of pending) {
    const isNew = !seenApprovals.has(p.id);
    const slot = h('div', { class: 'pp-slot' });
    const showButtons = p.status === 'pending' && !p.needs_confirmation;
    kids.push(h('article', { class: `req pending${isNew ? ' enter-fade' : ''}`, style: `--i:${kids.length}` },
      h('div', { class: 'req-head' }, h('h3', { class: 'req-title' }, `${p.product_name}${p.qty > 1 ? ` x${p.qty}` : ''}`), h('span', { class: 'req-amt' }, usd(p.amount_cents))),
      sourceLine(p),
      p.rationale ? h('p', { class: 'req-why' }, /^Requested by you/.test(p.rationale) ? p.rationale : `Assistant: ${p.rationale}`) : null,
      policyChecks(p),
      payBlock(p, slot),
      p.status === 'pending' ? h('div', { class: 'req-actions' }, h('button', { class: 'btn small danger', onclick: (e) => dismiss(p.id, e.currentTarget.closest('.req')) }, 'Dismiss')) : null,
    ));
    if (showButtons) queueMicrotask(() => renderPayPalButtons(p, slot));
  }
  if (recent.length) {
    kids.push(h('h2', { class: 'recent-title' }, 'Recent'));
    for (const p of recent) {
      const retry = ['declined', 'cancelled', 'expired', 'failed'].includes(p.status);
      const isNew = !seenApprovals.has(p.id);
      kids.push(h('article', { class: `req${isNew ? ' enter' : ''}${isNew && p.status === 'captured' ? ' flash' : ''}`, style: `--i:${kids.length}` },
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

// ------------------------------------------------------------------ limits the assistant suggested (a human applies them)
let proposalSig = '';
let reviewing = null;

function renderProposals(list) {
  const sig = JSON.stringify(list.map((p) => [p.id, p.summary]));
  if (sig === proposalSig) return;
  proposalSig = sig;
  const box = $('proposals');
  box.hidden = list.length === 0;
  box.replaceChildren(...list.map((p) => h('article', { class: 'suggestion' },
    h('p', { class: 'eyebrow' }, 'Suggested by the assistant'),
    h('p', {}, p.reason),
    h('ul', { class: 'change-list' }, p.summary.map((line) => h('li', {}, line))),
    h('div', { class: 'req-actions' },
      h('button', { class: 'btn small primary', type: 'button', onclick: () => openProposal(p) }, 'Review and apply'),
      h('button', { class: 'btn small', type: 'button', onclick: () => simple(`/api/proposals/${p.id}/dismiss`, 'Suggestion dismissed. Your limits are unchanged.') }, 'Dismiss')))));
}

function openProposal(p) {
  reviewing = p;
  $('proposal-reason').textContent = p.reason;
  $('proposal-changes').replaceChildren(...p.summary.map((line) => h('li', {}, line)));
  $('proposal-ack').checked = false;
  $('proposal-go').disabled = true;
  $('proposal-error').hidden = true;
  $('dlg-proposal').showModal();
}

async function applyReviewed() {
  if (!reviewing) return;
  $('proposal-go').disabled = true;
  try {
    await api(`/api/proposals/${reviewing.id}/apply`, { method: 'POST', body: { acknowledged: $('proposal-ack').checked } });
    $('dlg-proposal').close();
    toast('Your limits were updated.', false, null, true);
    await refresh();
  } catch (e) { $('proposal-error').textContent = e.message; $('proposal-error').hidden = false; $('proposal-go').disabled = !$('proposal-ack').checked; }
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
  syncLock();
  renderProposals(s.proposals ?? []);
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
  const who = 'The assistant';
  const started = Date.now();
  const { el, label } = thinkingBubble(who);
  progress.start();
  const live = setInterval(refresh, 2000); // requests appear as the assistant proposes them
  const tick = setInterval(() => { label.textContent = `${who} is searching the web and checking your mandate... ${Math.round((Date.now() - started) / 1000)}s`; }, 1000);
  box.append(h('div', { class: 'msg user enter' }, msg), el);
  box.scrollTop = box.scrollHeight;
  try {
    await api('/api/chat', { method: 'POST', body: { message: msg } });
  } catch (e) {
    toast(e.message, true);
  } finally {
    progress.stop();
    clearInterval(tick);
    clearInterval(live);
    chatBusy = false;
    msgSig = ''; // force a repaint so the final reply replaces the progress bubble
    await refresh();
    syncLock();
    if (!input.disabled) input.focus();
  }
}

// ------------------------------------------------------------------ mandate: first-time setup and the editor
// The same dialog does both. Setup starts EMPTY (the owner picks every figure; nothing is pre-filled) and activates the
// mandate; editing an existing mandate asks for confirmation when a change gives the assistant more spending power.
let setupMode = false;
let editNeedsConfirm = false;
const domainLines = (text) => String(text).split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
const pickedCats = () => [...$('edit-cats').querySelectorAll('input:checked')].map((i) => i.value);
const saveLabel = () => (setupMode ? 'Activate mandate' : 'Save mandate');

function resetEditConfirm() {
  editNeedsConfirm = false;
  $('edit-confirm').hidden = true;
  $('edit-ack').checked = false;
  $('edit-save').disabled = false;
  $('edit-save').textContent = saveLabel();
}

/** Plain-language read-back of what the owner is about to allow, and the cap-vs-budget rule, while they type. */
function updateSummary() {
  if (!setupMode) return;
  const f = $('form-edit');
  const budget = Number(f.elements.budget.value);
  const cap = Number(f.elements.cap.value);
  const tooHigh = budget > 0 && cap > budget;
  f.elements.cap.setCustomValidity(tooHigh ? 'The per-purchase cap cannot be more than the total budget.' : '');
  const cats = pickedCats();
  const out = $('edit-summary');
  if (!(budget >= 1) || !(cap >= 1)) out.textContent = 'Enter your total budget and the most you are happy to spend on a single item.';
  else if (tooHigh) out.textContent = 'The per-purchase cap cannot be more than the total budget.';
  else out.textContent = `The assistant may ask to spend up to ${usd(Math.round(budget * 100))} in total, never more than ${usd(Math.round(cap * 100))} on one item${cats.length ? `, from: ${cats.join(', ')}` : ''}. You still approve every payment in PayPal.`;
  out.classList.toggle('warn', tooHigh);
}

function openMandateDialog() {
  if (!state || $('dlg-edit').open) return;
  const m = state.mandate;
  setupMode = !m.configured;
  const f = $('form-edit');
  $('edit-title').textContent = setupMode ? 'Set up your mandate' : 'Edit mandate';
  $('edit-intro').hidden = !setupMode;
  $('edit-summary').hidden = !setupMode;
  f.elements.name.value = m.name;
  f.elements.budget.value = setupMode ? '' : m.budget_cents / 100;
  f.elements.cap.value = setupMode ? '' : m.per_item_cap_cents / 100;
  f.elements.pace.value = setupMode ? (cfg.defaultPace ?? '') : (m.max_per_hour ?? '');
  f.elements.expires.value = m.expires_at ? new Date(m.expires_at).toISOString().slice(0, 10) : '';
  f.elements.daily.value = m.max_per_day_cents ? m.max_per_day_cents / 100 : '';
  f.elements.blocked.value = m.blocked_sellers.join('\n');
  f.elements.allowed.value = m.allowed_sellers.join('\n');
  $('edit-more').open = !setupMode;
  $('edit-cats').replaceChildren(...state.categories.map((c) => h('label', {}, h('input', { type: 'checkbox', value: c, checked: m.categories.includes(c) }), c)));
  $('edit-error').hidden = true;
  resetEditConfirm();
  updateSummary();
  $('dlg-edit').showModal();
  (setupMode ? f.elements.budget : f.elements.name).focus();
}
const openEditor = openMandateDialog;
/** Offer the setup dialog when (and only when) the mandate has not been set up. */
const openSetup = () => { if (state && !state.mandate.configured) openMandateDialog(); };

async function saveEditor(ev) {
  ev.preventDefault();
  const f = $('form-edit');
  const err = $('edit-error');
  const fail = (msg) => { err.textContent = msg; err.hidden = false; };
  err.hidden = true;
  if (!f.reportValidity()) return;
  if (setupMode && !pickedCats().length) return fail('Choose at least one category the assistant may buy from.');
  const wasSetup = setupMode;
  try {
    await api(wasSetup ? '/api/mandate/setup' : '/api/mandate', { method: wasSetup ? 'POST' : 'PUT', body: {
      name: f.elements.name.value,
      budget_cents: Math.round(Number(f.elements.budget.value) * 100),
      per_item_cap_cents: Math.round(Number(f.elements.cap.value) * 100),
      categories: pickedCats(),
      max_per_hour: f.elements.pace.value === '' ? null : Number(f.elements.pace.value),
      // end of the chosen day, local time
      expires_at: f.elements.expires.value === '' ? null : new Date(`${f.elements.expires.value}T23:59:59`).getTime(),
      max_per_day_cents: f.elements.daily.value === '' ? null : Math.round(Number(f.elements.daily.value) * 100),
      blocked_sellers: domainLines(f.elements.blocked.value),
      allowed_sellers: domainLines(f.elements.allowed.value),
      confirm_increase: !wasSetup && editNeedsConfirm && $('edit-ack').checked,
    } });
    $('dlg-edit').close();
    if (wasSetup) {
      toast('Your mandate is active. The assistant can now search and request purchases inside it.', false,
        { label: 'Start shopping', run: () => { navigate('overview'); setTimeout(() => $('chat-input').focus(), 60); } }, true);
      celebrateAfterRefresh = true;
    } else toast('Mandate updated.', false, null, true);
    await refresh();
    if (celebrateAfterRefresh) { celebrateAfterRefresh = false; celebrate(); }
  } catch (e) {
    if (e.code === 'CONFIRMATION_REQUIRED' && e.details?.changes) {
      editNeedsConfirm = true;
      $('edit-changes').replaceChildren(...e.details.changes.map((c) => h('li', {}, `${c.field}: ${c.from} → ${c.to}`)));
      $('edit-confirm').hidden = false;
      $('edit-ack').checked = false;
      $('edit-save').textContent = 'Confirm and apply';
      $('edit-save').disabled = true;
      err.hidden = true;
      return;
    }
    fail(e.message);
  }
}

/** Setup is the first thing a new owner has to do, so until it is done the rest of the UI says so and stays quiet. */
// The bar is the way back to setup from every page except Account, where the statement already carries the button.
const syncSetupBar = () => { $('setup-bar').hidden = !state || state.mandate.configured || currentRoute() === 'overview'; };

function syncLock() {
  const ready = Boolean(state?.mandate.configured);
  syncSetupBar();
  $('chat-send').disabled = !ready || chatBusy;
  $('chat-input').disabled = !ready;
  for (const id of ['search-input', 'search-max']) $(id).disabled = !ready;
  $('search-btn').disabled = !ready || searching;
  if (lockSig === ready) return;
  lockSig = ready;
  document.body.classList.toggle('needs-setup', !ready);
  $('btn-edit').hidden = !ready;
  $('search-locked').hidden = ready;
  $('chat-input').placeholder = ready ? 'e.g. a desk lamp under $40' : 'Set up your mandate to start';
  renderChips();
  renderSearchExamples();
}

// ------------------------------------------------------------------ manual web search
function renderResults(offers, skipped) {
  const box = $('search-results');
  if (!offers.length) {
    box.replaceChildren(h('p', { class: 'empty' }, 'No product page with a readable price turned up for that. Large marketplaces often hide prices from automated checks, so try a more specific product name (for example "wireless vertical mouse") or one of the examples above.'));
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
  searching = true;
  btn.disabled = true;
  btn.textContent = 'Searching...';
  progress.start();
  $('search-results').replaceChildren(h('p', { class: 'muted search-status' }, 'Searching the web and checking each price on the retailer page (about 10 seconds)...'), ...skeletons());
  try {
    const r = await api('/api/search', { method: 'POST', body: { query, ...(max > 0 ? { max_price_usd: max } : {}) } });
    renderResults(r.offers, r.skipped);
  } catch (err) {
    $('search-results').replaceChildren(h('p', { class: 'empty' }, err.message));
  }
  progress.stop();
  searching = false;
  syncLock();
  btn.textContent = 'Search';
}

// ------------------------------------------------------------------ boot
function renderChips() {
  const on = getPrefs().showChips && Boolean(state?.mandate.configured);
  $('chips').hidden = !on;
  $('chips').replaceChildren(...(on ? [h('span', { class: 'suggest-label' }, 'Try:'), ...SUGGESTIONS.map((s) => h('button', { type: 'button', onclick: () => send(s) }, s))] : []));
}
const SEARCH_EXAMPLES = ['ergonomic office chair', 'felt desk mat', 'ergonomic vertical mouse', 'stainless steel water bottle', 'ceramic coffee mug'];
function renderSearchExamples() {
  $('search-examples').replaceChildren(h('span', { class: 'suggest-label' }, 'Examples that usually work:'),
    ...SEARCH_EXAMPLES.map((q) => h('button', { type: 'button', disabled: !state?.mandate.configured, onclick: () => { $('search-input').value = q; $('search-form').requestSubmit(); } }, q)));
}
const syncHint = () => { const p = getPrefs(); $('how-hint').hidden = !(p.showHint && !p.hintDismissed); };

async function boot() {
  initShell();
  initMotion();
  cfg = await api('/api/config');

  $('agent-note').textContent = cfg.aiEnabled ? 'AI assistant with web search' : 'AI assistant not set up';

  const notices = [];
  if (cfg.paypalMode !== 'mock' && !cfg.paypalConfigured) {
    notices.push('PayPal credentials are missing: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (see README). The assistant and policy engine still work, but orders cannot be created.');
  }
  if (!cfg.webSearch) {
    notices.push('Live product search is off: no search source is configured on the server (see the README). Sources find product pages; the server verifies each price itself.');
  }
  if (cfg.persistent === false) {
    notices.push('This deployment has no persistent database configured (see the README): your session and purchases can disappear between requests.');
  }
  if (notices.length) {
    const b = $('banner');
    b.hidden = false;
    b.textContent = notices.join(' ');
  }

  renderSettings($('settings-content'), { toast, startTour: () => openTour() });
  renderInfo($('info-content'), cfg, { toast });
  $('search-card').hidden = !cfg.webSearch;
  $('search-off').hidden = Boolean(cfg.webSearch);

  renderChips();
  renderSearchExamples();
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
  $('btn-setup-bar').addEventListener('click', openSetup);
  $('edit-save').addEventListener('click', saveEditor);
  $('form-edit').addEventListener('input', (e) => { if (editNeedsConfirm && e.target.id !== 'edit-ack') resetEditConfirm(); updateSummary(); });
  const setAllCats = (on) => { $('edit-cats').querySelectorAll('input').forEach((i) => { i.checked = on; }); updateSummary(); };
  $('edit-cats-all').addEventListener('click', () => setAllCats(true));
  $('edit-cats-none').addEventListener('click', () => setAllCats(false));

  // Welcome tour: automatic once per device (remembered in this browser), replayable from Settings and How it works.
  initTour({
    context: () => ({ configured: Boolean(state?.mandate.configured), highValueCents: cfg.highValueCents }),
    finished: ({ wantsSetup }) => { if (wantsSetup) setTimeout(openSetup, 120); },
  });
  $('how-tour').addEventListener('click', () => openTour());
  onNeedsSetup = () => { refresh().then(() => { if (!$('dlg-tour').open) openSetup(); }); };
  $('edit-ack').addEventListener('change', () => { $('edit-save').disabled = !$('edit-ack').checked; });

  $('proposal-ack').addEventListener('change', () => { $('proposal-go').disabled = !$('proposal-ack').checked; });
  $('proposal-go').addEventListener('click', applyReviewed);
  $('proposal-cancel').addEventListener('click', () => $('dlg-proposal').close());

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
  onRoute((route) => { if (route === 'ledger') ensureGrids(); syncSetupBar(); });
  if (document.querySelector('.page:not([hidden])')?.dataset.page === 'ledger') ensureGrids();

  await refresh();
  // First thing a new visitor sees: the tour (once per device), then the mandate setup. A returning visitor whose
  // mandate is still not set up goes straight to the setup.
  if (state) { if (!tourSeen()) openTour({ first: true }); else openSetup(); }
  // Picks up webhook-driven changes (e.g. capture completed server-side) without a manual reload: faster while something is in flight.
  const poll = async () => {
    if (!document.hidden && !chatBusy) await refresh();
    const inFlight = state?.purchases.some((p) => ['pending', 'capturing', 'reserving'].includes(p.status));
    setTimeout(poll, inFlight ? 2000 : 5000);
  };
  setTimeout(poll, 4000);
}

boot().catch((e) => { console.error(e); toast('Failed to start the app.', true); });
