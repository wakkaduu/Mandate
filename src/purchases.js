// Domain service: sessions, mandates, purchase lifecycle, PayPal reconciliation.
// Every state change is audited. Amounts come only from the catalog (server-side).
import { randomUUID } from 'node:crypto';
import { getDb, tx } from './db.js';
import { DEFAULT_MANDATE } from './catalog.js';
import { COMMITTED_STATUSES, evaluate, centsToValue, money, MAX_QTY } from './policy.js';
import * as paypal from './paypal.js';
import { config } from './config.js';

export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const STATUS = {
  RESERVING: 'reserving',   // budget reserved, PayPal order being created
  PENDING: 'pending',       // PayPal order created, waiting for the human to approve in PayPal
  CAPTURING: 'capturing',   // capture in flight (or PayPal reported PENDING)
  CAPTURED: 'captured',     // money moved
  BLOCKED: 'blocked',       // refused by the mandate policy; no PayPal order was ever created
  DECLINED: 'declined',     // PayPal declined the funding instrument
  CANCELLED: 'cancelled',   // human cancelled / closed the PayPal window
  EXPIRED: 'expired',       // order sat unapproved past PayPal's 3h order lifetime
  FAILED: 'failed',         // technical failure creating the order
  REFUNDING: 'refunding',
  REFUNDED: 'refunded',
};
const COMMITTED = [...COMMITTED_STATUSES, STATUS.REFUNDING];
const placeholders = (arr) => arr.map(() => '?').join(',');

const ORDER_LIFETIME_MS = 3 * 3600 * 1000; // PayPal keeps a CREATED order capturable for 3 hours
const now = () => Date.now();

// ---------------------------------------------------------------- sessions & mandate
export function ensureSession(sid) {
  const d = getDb();
  if (sid && d.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sid)) return sid;
  const id = randomUUID();
  tx((t) => {
    t.prepare('INSERT INTO sessions (id, created_at) VALUES (?, ?)').run(id, now());
    t.prepare('INSERT INTO mandates (session_id,name,budget_cents,per_item_cap_cents,categories,updated_at) VALUES (?,?,?,?,?,?)')
      .run(id, DEFAULT_MANDATE.name, DEFAULT_MANDATE.budget_cents, DEFAULT_MANDATE.per_item_cap_cents,
        JSON.stringify(DEFAULT_MANDATE.categories), now());
  });
  audit(id, null, 'mandate.created', `Mandate "${DEFAULT_MANDATE.name}": ${money(DEFAULT_MANDATE.budget_cents)} budget, ${money(DEFAULT_MANDATE.per_item_cap_cents)} per-purchase cap`);
  return id;
}

export function resetSession(sid) {
  const d = getDb();
  tx((t) => {
    t.prepare('DELETE FROM purchases WHERE session_id = ?').run(sid);
    t.prepare('DELETE FROM audit WHERE session_id = ?').run(sid);
    t.prepare('DELETE FROM messages WHERE session_id = ?').run(sid);
    t.prepare('UPDATE mandates SET name=?, budget_cents=?, per_item_cap_cents=?, categories=?, updated_at=? WHERE session_id=?')
      .run(DEFAULT_MANDATE.name, DEFAULT_MANDATE.budget_cents, DEFAULT_MANDATE.per_item_cap_cents,
        JSON.stringify(DEFAULT_MANDATE.categories), now(), sid);
  });
  audit(sid, null, 'session.reset', 'Demo reset');
  return d && getMandate(sid);
}

function committedCents(d, sid) {
  const row = d.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS c FROM purchases WHERE session_id = ? AND status IN (${placeholders(COMMITTED)})`)
    .get(sid, ...COMMITTED);
  return row.c;
}

export function getMandate(sid) {
  const d = getDb();
  expireStale(sid);
  const m = d.prepare('SELECT * FROM mandates WHERE session_id = ?').get(sid);
  if (!m) throw new AppError(404, 'NO_MANDATE', 'Mandate not found');
  const committed = committedCents(d, sid);
  const captured = d.prepare("SELECT COALESCE(SUM(amount_cents),0) AS c FROM purchases WHERE session_id = ? AND status = 'captured'").get(sid).c;
  return {
    name: m.name,
    budget_cents: m.budget_cents,
    per_item_cap_cents: m.per_item_cap_cents,
    categories: JSON.parse(m.categories),
    committed_cents: committed,
    captured_cents: captured,
    remaining_cents: Math.max(m.budget_cents - committed, 0),
  };
}

export function updateMandate(sid, input) {
  const cur = getMandate(sid);
  const name = input.name === undefined ? cur.name : String(input.name).trim().slice(0, 60);
  const budget = input.budget_cents === undefined ? cur.budget_cents : input.budget_cents;
  const cap = input.per_item_cap_cents === undefined ? cur.per_item_cap_cents : input.per_item_cap_cents;
  const cats = input.categories === undefined ? cur.categories : input.categories;
  if (!name) throw new AppError(400, 'BAD_INPUT', 'Mandate name is required.');
  if (!Number.isInteger(budget) || budget < 100 || budget > 1_000_000) throw new AppError(400, 'BAD_INPUT', 'Budget must be between $1.00 and $10,000.00.');
  if (!Number.isInteger(cap) || cap < 100 || cap > budget) throw new AppError(400, 'BAD_INPUT', 'Per-purchase cap must be at least $1.00 and no more than the budget.');
  const known = new Set(listCategories());
  if (!Array.isArray(cats) || cats.some((c) => !known.has(c))) throw new AppError(400, 'BAD_INPUT', `Categories must be a subset of: ${[...known].join(', ')}.`);
  getDb().prepare('UPDATE mandates SET name=?, budget_cents=?, per_item_cap_cents=?, categories=?, updated_at=? WHERE session_id=?')
    .run(name, budget, cap, JSON.stringify(cats), now(), sid);
  audit(sid, null, 'mandate.updated', `Budget ${money(budget)}, cap ${money(cap)}, categories: ${cats.join(', ') || 'none'}`);
  return getMandate(sid);
}

export function listCategories() {
  return getDb().prepare('SELECT DISTINCT category FROM products ORDER BY category').all().map((r) => r.category);
}

// ---------------------------------------------------------------- catalog
export function searchProducts({ query = '', max_price_cents, category } = {}) {
  const rows = getDb().prepare('SELECT * FROM products ORDER BY price_cents ASC').all();
  const words = String(query).toLowerCase().split(/[^a-z0-9"+-]+/).filter((w) => w.length > 1);
  const scored = rows
    .filter((p) => (!category || p.category === category) && (!max_price_cents || p.price_cents <= max_price_cents))
    .map((p) => {
      const hay = `${p.name} ${p.tags} ${p.category} ${p.merchant} ${p.description}`.toLowerCase();
      const score = words.length ? words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0) : 1;
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.price_cents - b.p.price_cents);
  return scored.slice(0, 8).map((x) => x.p);
}

export function allProducts() {
  return getDb().prepare('SELECT * FROM products ORDER BY category, price_cents').all();
}

export function getProduct(id) {
  return getDb().prepare('SELECT * FROM products WHERE id = ?').get(String(id));
}

// ---------------------------------------------------------------- audit & chat
export function audit(sid, purchaseId, type, detail) {
  getDb().prepare('INSERT INTO audit (session_id, purchase_id, type, detail, created_at) VALUES (?,?,?,?,?)')
    .run(sid, purchaseId, type, detail ?? null, now());
}

export function listAudit(sid, limit = 300) {
  return getDb().prepare(`SELECT a.id, a.type, a.detail, a.purchase_id, a.created_at, p.product_name, p.amount_cents
    FROM audit a LEFT JOIN purchases p ON p.id = a.purchase_id
    WHERE a.session_id = ? ORDER BY a.id DESC LIMIT ?`).all(sid, limit);
}

export function addMessage(sid, role, content) {
  getDb().prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?,?,?,?)').run(sid, role, content, now());
}

export function listMessages(sid, limit = 40) {
  return getDb().prepare('SELECT role, content, created_at FROM (SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC')
    .all(sid, limit);
}

// ---------------------------------------------------------------- purchases
function view(p) {
  if (!p) return p;
  const { session_id, ...rest } = p;
  return { ...rest, amount: centsToValue(p.amount_cents) };
}

function getRow(sid, id) {
  const row = getDb().prepare('SELECT * FROM purchases WHERE id = ? AND session_id = ?').get(String(id), sid);
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Purchase not found.');
  return row;
}

export function getPurchase(sid, id) {
  return view(getRow(sid, id));
}

export function listPurchases(sid) {
  expireStale(sid);
  return getDb().prepare('SELECT * FROM purchases WHERE session_id = ? ORDER BY created_at DESC, rowid DESC').all(sid).map(view);
}

function setStatus(sid, id, status, fields = {}) {
  const cols = { status, updated_at: now(), ...fields };
  const sql = `UPDATE purchases SET ${Object.keys(cols).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  getDb().prepare(sql).run(...Object.values(cols), id);
  return getRow(sid, id);
}

/** Lazily expire stale rows: unapproved PayPal orders (3h) and reservations orphaned by a crash. */
function expireStale(sid) {
  const d = getDb();
  const t = now();
  const exp = d.prepare("SELECT id FROM purchases WHERE session_id = ? AND status = 'pending' AND created_at < ?").all(sid, t - ORDER_LIFETIME_MS);
  for (const { id } of exp) {
    d.prepare("UPDATE purchases SET status='expired', reason='PayPal order expired before it was approved.', updated_at=? WHERE id=? AND status='pending'").run(t, id);
    audit(sid, id, 'purchase.expired', 'Order not approved within 3 hours; budget released');
  }
  const stuck = d.prepare("SELECT id FROM purchases WHERE session_id = ? AND status = 'capturing' AND paypal_capture_id IS NULL AND updated_at < ?").all(sid, t - 5 * 60_000);
  for (const { id } of stuck) {
    d.prepare("UPDATE purchases SET status='pending', reason='Capture did not complete; retry the approval.', updated_at=? WHERE id=? AND status='capturing'").run(t, id);
    audit(sid, id, 'purchase.capture_reset', 'Capture attempt timed out; returned to pending (idempotent retry is safe)');
  }
  const orphans = d.prepare("SELECT id FROM purchases WHERE session_id = ? AND status = 'reserving' AND created_at < ?").all(sid, t - 5 * 60_000);
  for (const { id } of orphans) {
    d.prepare("UPDATE purchases SET status='failed', reason='Order creation did not complete.', updated_at=? WHERE id=? AND status='reserving'").run(t, id);
    audit(sid, id, 'purchase.failed', 'Reservation orphaned; budget released');
  }
}

/**
 * The single entry point an AI agent (or any client) uses to ask for a purchase.
 * The policy engine decides; only approved proposals ever reach PayPal.
 */
export async function proposePurchase(sid, { product_id, qty = 1, rationale = '' }) {
  qty = Number(qty);
  const product = getProduct(product_id);
  const id = randomUUID();
  const rat = String(rationale || '').slice(0, 300);

  const row = tx((t) => {
    expireStale(sid);
    const m = getMandate(sid);
    const open = product
      ? t.prepare(`SELECT 1 FROM purchases WHERE session_id=? AND product_id=? AND status IN (${placeholders(COMMITTED)})`).get(sid, product.id, ...COMMITTED)
      : null;
    const verdict = evaluate(m, product, qty, { committed_cents: m.committed_cents, open_same_product: Boolean(open) });
    const stamp = now();
    const base = {
      product_id: product?.id ?? String(product_id).slice(0, 64),
      product_name: product?.name ?? 'Unknown product',
      merchant: product?.merchant ?? '-',
      category: product?.category ?? '-',
      qty: Number.isInteger(qty) && qty > 0 ? Math.min(qty, MAX_QTY) : 1,
    };
    const amount = verdict.amount_cents ?? (product ? product.price_cents * base.qty : 0);
    t.prepare(`INSERT INTO purchases (id,session_id,product_id,product_name,merchant,category,qty,amount_cents,status,reason,rationale,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, sid, base.product_id, base.product_name, base.merchant, base.category, base.qty, amount,
        verdict.ok ? STATUS.RESERVING : STATUS.BLOCKED, verdict.ok ? null : `${verdict.code}: ${verdict.reason}`, rat, stamp, stamp);
    return { verdict, id };
  });

  if (!row.verdict.ok) {
    audit(sid, id, 'policy.blocked', `${row.verdict.code} - ${row.verdict.reason}`);
    return { purchase: getPurchase(sid, id), allowed: false, code: row.verdict.code, reason: row.verdict.reason };
  }
  audit(sid, id, 'policy.approved', `${product.name} x${qty} = ${money(row.verdict.amount_cents)} within mandate`);

  try {
    const order = await paypal.createOrder(getRow(sid, id));
    setStatus(sid, id, STATUS.PENDING, { paypal_order_id: order.id });
    audit(sid, id, 'paypal.order_created', `Order ${order.id} (${order.status}) - waiting for human approval`);
    return { purchase: getPurchase(sid, id), allowed: true };
  } catch (e) {
    const msg = e instanceof paypal.PayPalError ? e.message : 'Unexpected error creating PayPal order.';
    setStatus(sid, id, STATUS.FAILED, { reason: msg });
    audit(sid, id, 'paypal.order_failed', `${msg}${e.debugId ? ` (debug_id ${e.debugId})` : ''}`);
    return { purchase: getPurchase(sid, id), allowed: false, code: 'PAYPAL_ERROR', reason: msg };
  }
}

/** Capture after the human approved in PayPal. Idempotent and safe to call twice. */
export async function capturePurchase(sid, id) {
  const row = getRow(sid, id);
  if (row.status === STATUS.CAPTURED) return { purchase: view(row), outcome: 'already_captured' };
  if (row.status !== STATUS.PENDING) {
    throw new AppError(409, 'BAD_STATE', `Purchase is ${row.status}; only pending purchases can be captured.`);
  }
  const claim = getDb().prepare("UPDATE purchases SET status='capturing', updated_at=? WHERE id=? AND status='pending'").run(now(), row.id);
  if (!claim.changes) {
    const cur = getRow(sid, id);
    return { purchase: view(cur), outcome: cur.status === STATUS.CAPTURED ? 'already_captured' : 'in_progress' };
  }

  try {
    const order = await paypal.captureOrder(row.paypal_order_id, row.id);
    return finishCapture(sid, row, order);
  } catch (e) {
    if (!(e instanceof paypal.PayPalError)) {
      // Network failure / timeout: the capture may or may not have happened. Return to pending so a retry
      // (same PayPal-Request-Id) either completes it or reports ORDER_ALREADY_CAPTURED.
      const reason = 'Could not reach PayPal to confirm the payment. Please retry.';
      setStatus(sid, id, STATUS.PENDING, { reason });
      audit(sid, id, 'paypal.capture_error', `Network error: ${e.message}`);
      throw new AppError(502, 'NETWORK', reason);
    }
    if (e.hasIssue('ORDER_ALREADY_CAPTURED')) {
      // Duplicate click / retry after a lost response: confirm with PayPal rather than assuming.
      const order = await paypal.getOrder(row.paypal_order_id);
      return finishCapture(sid, row, order, 'already_captured');
    }
    if (e.hasIssue('INSTRUMENT_DECLINED')) {
      const reason = 'PayPal declined this payment method. Try a different funding source or re-request the purchase.';
      setStatus(sid, id, STATUS.DECLINED, { reason });
      audit(sid, id, 'paypal.declined', `INSTRUMENT_DECLINED (debug_id ${e.debugId ?? 'n/a'}); budget released`);
      return { purchase: getPurchase(sid, id), outcome: 'declined' };
    }
    // Not approved yet / transient error: return to pending so the human can retry; the idempotency key prevents double capture.
    const reason = e.hasIssue('ORDER_NOT_APPROVED')
      ? 'The PayPal approval has not completed yet.'
      : `PayPal could not capture this payment right now (${e.message}). Please retry.`;
    setStatus(sid, id, STATUS.PENDING, { reason });
    audit(sid, id, 'paypal.capture_error', `${e.issues.join(',') || e.status} ${e.debugId ? `(debug_id ${e.debugId})` : ''}`.trim());
    throw new AppError(e.hasIssue('ORDER_NOT_APPROVED') ? 409 : 502, e.issues[0] || 'PAYPAL_ERROR', reason);
  }
}

function finishCapture(sid, row, order, outcome = 'captured') {
  const cap = paypal.firstCapture(order);
  const expected = centsToValue(row.amount_cents);
  if (!cap || cap.amount?.value !== expected || cap.amount?.currency_code !== config.paypal.currency) {
    setStatus(sid, row.id, STATUS.FAILED, { reason: 'PayPal capture did not match the expected amount; flagged for review.' });
    audit(sid, row.id, 'paypal.amount_mismatch', `expected ${expected}, got ${cap?.amount?.value}`);
    return { purchase: getPurchase(sid, row.id), outcome: 'failed' };
  }
  const payer = order.payer?.email_address ?? null;
  if (cap.status === 'COMPLETED') {
    setStatus(sid, row.id, STATUS.CAPTURED, { paypal_capture_id: cap.id, payer_email: payer, reason: null });
    audit(sid, row.id, 'paypal.captured', `Capture ${cap.id} COMPLETED for ${money(row.amount_cents)}${payer ? ` from ${payer}` : ''}`);
    return { purchase: getPurchase(sid, row.id), outcome };
  }
  // PENDING / other: keep funds reserved; the PAYMENT.CAPTURE.COMPLETED webhook finalises it.
  setStatus(sid, row.id, STATUS.CAPTURING, { paypal_capture_id: cap.id, payer_email: payer, reason: `PayPal capture status: ${cap.status}` });
  audit(sid, row.id, 'paypal.capture_pending', `Capture ${cap.id} is ${cap.status}; awaiting webhook`);
  return { purchase: getPurchase(sid, row.id), outcome: 'pending_review' };
}

export function cancelPurchase(sid, id, why = 'Cancelled by the human approver.') {
  const row = getRow(sid, id);
  if (row.status !== STATUS.PENDING) {
    if ([STATUS.CANCELLED, STATUS.DECLINED, STATUS.EXPIRED, STATUS.BLOCKED].includes(row.status)) return view(row);
    throw new AppError(409, 'BAD_STATE', `Purchase is ${row.status} and cannot be cancelled.`);
  }
  const out = setStatus(sid, id, STATUS.CANCELLED, { reason: why });
  audit(sid, id, 'purchase.cancelled', `${why} Budget released.`);
  return view(out);
}

export async function refundPurchase(sid, id) {
  const row = getRow(sid, id);
  if (row.status === STATUS.REFUNDED) return view(row);
  if (row.status !== STATUS.CAPTURED || !row.paypal_capture_id) {
    throw new AppError(409, 'BAD_STATE', 'Only captured purchases can be refunded.');
  }
  const claim = getDb().prepare("UPDATE purchases SET status='refunding', updated_at=? WHERE id=? AND status='captured'").run(now(), row.id);
  if (!claim.changes) return getPurchase(sid, id);
  try {
    const refund = await paypal.refundCapture(row.paypal_capture_id, row);
    setStatus(sid, id, STATUS.REFUNDED, { paypal_refund_id: refund.id, reason: 'Refunded to the buyer.' });
    audit(sid, id, 'paypal.refunded', `Refund ${refund.id} ${refund.status}; budget released`);
  } catch (e) {
    const already = e instanceof paypal.PayPalError && e.hasIssue('CAPTURE_FULLY_REFUNDED');
    setStatus(sid, id, already ? STATUS.REFUNDED : STATUS.CAPTURED, { reason: already ? 'Already refunded at PayPal.' : `Refund failed: ${e.message}` });
    audit(sid, id, already ? 'paypal.refunded' : 'paypal.refund_failed', e.message);
    if (!already) throw new AppError(502, 'REFUND_FAILED', `Refund failed: ${e.message}`);
  }
  return getPurchase(sid, id);
}

// ---------------------------------------------------------------- webhooks
/**
 * Apply a verified PayPal webhook event. Idempotent on event id, and tolerant of ordering:
 * a webhook may arrive before (or instead of) the browser's capture call.
 */
export function applyWebhookEvent(event) {
  const d = getDb();
  const seen = d.prepare('INSERT OR IGNORE INTO webhook_events (event_id, event_type, received_at) VALUES (?,?,?)')
    .run(String(event.id), String(event.event_type), now());
  if (!seen.changes) return { duplicate: true };

  const r = event.resource || {};
  const purchaseId = r.custom_id;
  let row = purchaseId ? d.prepare('SELECT * FROM purchases WHERE id = ?').get(String(purchaseId)) : null;
  if (!row && r.supplementary_data?.related_ids?.order_id) {
    row = d.prepare('SELECT * FROM purchases WHERE paypal_order_id = ?').get(r.supplementary_data.related_ids.order_id);
  }
  if (!row && event.event_type === 'PAYMENT.CAPTURE.REFUNDED') {
    // Refund resource has no custom_id; the 'up' link points at the capture.
    const up = (r.links || []).find((l) => l.rel === 'up')?.href || '';
    const capId = up.split('/').pop();
    if (capId) row = d.prepare('SELECT * FROM purchases WHERE paypal_capture_id = ?').get(capId);
  }
  if (!row) return { ignored: true };

  const sid = row.session_id;
  switch (event.event_type) {
    case 'PAYMENT.CAPTURE.COMPLETED':
      if ([STATUS.PENDING, STATUS.CAPTURING].includes(row.status) && r.amount?.value === centsToValue(row.amount_cents)) {
        setStatus(sid, row.id, STATUS.CAPTURED, { paypal_capture_id: r.id, reason: null });
        audit(sid, row.id, 'webhook.captured', `PAYMENT.CAPTURE.COMPLETED ${r.id} (event ${event.id})`);
      } else {
        audit(sid, row.id, 'webhook.noop', `PAYMENT.CAPTURE.COMPLETED confirmed existing state "${row.status}"`);
      }
      break;
    case 'PAYMENT.CAPTURE.DENIED':
      if ([STATUS.PENDING, STATUS.CAPTURING].includes(row.status)) {
        setStatus(sid, row.id, STATUS.DECLINED, { reason: 'PayPal denied the capture.' });
        audit(sid, row.id, 'webhook.denied', `PAYMENT.CAPTURE.DENIED (event ${event.id}); budget released`);
      }
      break;
    case 'PAYMENT.CAPTURE.REFUNDED':
      if ([STATUS.CAPTURED, STATUS.REFUNDING].includes(row.status)) {
        setStatus(sid, row.id, STATUS.REFUNDED, { paypal_refund_id: r.id, reason: 'Refunded to the buyer.' });
        audit(sid, row.id, 'webhook.refunded', `PAYMENT.CAPTURE.REFUNDED (event ${event.id}); budget released`);
      }
      break;
    default:
      audit(sid, row.id, 'webhook.ignored', event.event_type);
  }
  return { applied: true };
}
