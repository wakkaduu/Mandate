// Domain service: sessions, mandates, purchase lifecycle, PayPal reconciliation.
// Every state change is audited. Amounts come only from stored offers (server-verified web prices).
import { randomUUID, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { db, tx } from './db.js';
import { DEFAULT_MANDATE, CATEGORIES } from './categories.js';
import { getOffer } from './offers.js';
import { COMMITTED_STATUSES, evaluate, centsToValue, money, MAX_QTY } from './policy.js';
import * as paypal from './paypal.js';
import { config } from './config.js';

export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
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
export async function ensureSession(sid) {
  const d = await db();
  if (sid && await d.get('SELECT 1 AS ok FROM sessions WHERE id = ?', [sid])) return sid;
  const id = randomUUID();
  await tx(async (t) => {
    await t.run('INSERT INTO sessions (id, created_at) VALUES (?, ?)', [id, now()]);
    await t.run('INSERT INTO mandates (session_id,name,budget_cents,per_item_cap_cents,categories,max_per_hour,updated_at) VALUES (?,?,?,?,?,?,?)',
      [id, DEFAULT_MANDATE.name, DEFAULT_MANDATE.budget_cents, DEFAULT_MANDATE.per_item_cap_cents,
        JSON.stringify(DEFAULT_MANDATE.categories), DEFAULT_MANDATE.max_per_hour, now()]);
  });
  await audit(id, null, 'mandate.created', `Mandate "${DEFAULT_MANDATE.name}": ${money(DEFAULT_MANDATE.budget_cents)} budget, ${money(DEFAULT_MANDATE.per_item_cap_cents)} per-purchase cap`);
  return id;
}

export async function resetSession(sid) {
  await tx(async (t) => {
    await t.run('DELETE FROM purchases WHERE session_id = ?', [sid]);
    await t.run('DELETE FROM audit WHERE session_id = ?', [sid]);
    await t.run('DELETE FROM messages WHERE session_id = ?', [sid]);
    await t.run('UPDATE mandates SET name=?, budget_cents=?, per_item_cap_cents=?, categories=?, expires_at=NULL, max_per_hour=?, updated_at=? WHERE session_id=?',
      [DEFAULT_MANDATE.name, DEFAULT_MANDATE.budget_cents, DEFAULT_MANDATE.per_item_cap_cents,
        JSON.stringify(DEFAULT_MANDATE.categories), DEFAULT_MANDATE.max_per_hour, now(), sid]);
  });
  await audit(sid, null, 'session.reset', 'Demo reset');
  return getMandate(sid);
}

async function committedCents(d, sid) {
  const row = await d.get(`SELECT COALESCE(SUM(amount_cents),0) AS c FROM purchases WHERE session_id = ? AND status IN (${placeholders(COMMITTED)})`,
    [sid, ...COMMITTED]);
  return row.c;
}

/** `exec` may be the shared executor or a transaction executor (so reservations see a consistent view). */
export async function getMandate(sid, exec) {
  const d = exec ?? await db();
  if (!exec) await expireStale(sid);
  const m = await d.get('SELECT * FROM mandates WHERE session_id = ?', [sid]);
  if (!m) throw new AppError(404, 'NO_MANDATE', 'Mandate not found');
  const committed = await committedCents(d, sid);
  const captured = (await d.get("SELECT COALESCE(SUM(amount_cents),0) AS c FROM purchases WHERE session_id = ? AND status = 'captured'", [sid])).c;
  return {
    name: m.name,
    budget_cents: m.budget_cents,
    per_item_cap_cents: m.per_item_cap_cents,
    categories: JSON.parse(m.categories),
    expires_at: m.expires_at ?? null,
    max_per_hour: m.max_per_hour ?? null,
    expired: Boolean(m.expires_at && now() > m.expires_at),
    committed_cents: committed,
    captured_cents: captured,
    remaining_cents: Math.max(m.budget_cents - committed, 0),
  };
}

export async function updateMandate(sid, input) {
  const cur = await getMandate(sid);
  const name = input.name === undefined ? cur.name : String(input.name).trim().slice(0, 60);
  const budget = input.budget_cents === undefined ? cur.budget_cents : input.budget_cents;
  const cap = input.per_item_cap_cents === undefined ? cur.per_item_cap_cents : input.per_item_cap_cents;
  const cats = input.categories === undefined ? cur.categories : input.categories;
  const expires = input.expires_at === undefined ? cur.expires_at : input.expires_at;
  const pace = input.max_per_hour === undefined ? cur.max_per_hour : input.max_per_hour;
  if (expires !== null && (!Number.isInteger(expires) || expires < now() || expires > now() + 366 * 86400_000)) {
    throw new AppError(400, 'BAD_INPUT', 'Expiry must be a future date within the next year (or empty for no expiry).');
  }
  if (pace !== null && (!Number.isInteger(pace) || pace < 1 || pace > 100)) {
    throw new AppError(400, 'BAD_INPUT', 'Purchase pace must be between 1 and 100 requests per hour (or empty for unlimited).');
  }
  if (!name) throw new AppError(400, 'BAD_INPUT', 'Mandate name is required.');
  if (!Number.isInteger(budget) || budget < 100 || budget > 1_000_000) throw new AppError(400, 'BAD_INPUT', 'Budget must be between $1.00 and $10,000.00.');
  if (!Number.isInteger(cap) || cap < 100 || cap > budget) throw new AppError(400, 'BAD_INPUT', 'Per-purchase cap must be at least $1.00 and no more than the budget.');
  const known = new Set(listCategories());
  if (!Array.isArray(cats) || cats.some((c) => !known.has(c))) throw new AppError(400, 'BAD_INPUT', `Categories must be a subset of: ${[...known].join(', ')}.`);
  // Anything that gives the agent MORE spending power is a big decision: the caller must confirm it explicitly.
  const more = [];
  if (budget > cur.budget_cents) more.push({ field: 'budget', from: money(cur.budget_cents), to: money(budget) });
  if (cap > cur.per_item_cap_cents) more.push({ field: 'per-purchase cap', from: money(cur.per_item_cap_cents), to: money(cap) });
  const added = cats.filter((c) => !cur.categories.includes(c));
  if (added.length) more.push({ field: 'allowed categories', from: cur.categories.join(', ') || 'none', to: `${[...cur.categories, ...added].join(', ')}` });
  if (cur.max_per_hour !== null && (pace === null || pace > cur.max_per_hour)) more.push({ field: 'purchase pace', from: `${cur.max_per_hour} per hour`, to: pace === null ? 'unlimited' : `${pace} per hour` });
  if (cur.expires_at !== null && (expires === null || expires > cur.expires_at)) more.push({ field: 'expiry', from: new Date(cur.expires_at).toISOString().slice(0, 10), to: expires === null ? 'never' : new Date(expires).toISOString().slice(0, 10) });
  if (more.length && input.confirm_increase !== true) {
    throw new AppError(409, 'CONFIRMATION_REQUIRED', 'These changes give the agent more spending power. Confirm them to apply.', { changes: more });
  }
  await (await db()).run('UPDATE mandates SET name=?, budget_cents=?, per_item_cap_cents=?, categories=?, expires_at=?, max_per_hour=?, updated_at=? WHERE session_id=?',
    [name, budget, cap, JSON.stringify(cats), expires, pace, now(), sid]);
  await audit(sid, null, 'mandate.updated', `${more.length ? '[increase confirmed] ' : ''}Budget ${money(budget)}, cap ${money(cap)}, categories: ${cats.join(', ') || 'none'}, pace ${pace ?? 'unlimited'}/h, expires ${expires ? new Date(expires).toISOString().slice(0, 10) : 'never'}`);
  return getMandate(sid);
}

export function listCategories() {
  return [...CATEGORIES];
}

// ---------------------------------------------------------------- audit & chat
// `exec` = transaction executor when called inside tx(); never mix executors inside one transaction.
export async function audit(sid, purchaseId, type, detail, exec) {
  const d = exec ?? await db();
  await d.run('INSERT INTO audit (session_id, purchase_id, type, detail, created_at) VALUES (?,?,?,?,?)',
    [sid, purchaseId, type, detail ?? null, now()]);
}

export async function listAudit(sid, limit = 300) {
  return (await db()).all(`SELECT a.id, a.type, a.detail, a.purchase_id, a.created_at, p.product_name, p.amount_cents
    FROM audit a LEFT JOIN purchases p ON p.id = a.purchase_id
    WHERE a.session_id = ? ORDER BY a.id DESC LIMIT ?`, [sid, limit]);
}

export async function addMessage(sid, role, content, trace = null) {
  await (await db()).run('INSERT INTO messages (session_id, role, content, trace, created_at) VALUES (?,?,?,?,?)',
    [sid, role, content, trace?.length ? JSON.stringify(trace) : null, now()]);
}

export async function listMessages(sid, limit = 40) {
  const rows = await (await db()).all('SELECT role, content, trace, created_at FROM (SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC', [sid, limit]);
  return rows.map(({ trace, ...m }) => ({ ...m, trace: trace ? JSON.parse(trace) : [] }));
}

// ---------------------------------------------------------------- purchases
export const isHighValue = (cents) => cents >= config.safety.highValueCents;

function view(p) {
  if (!p) return p;
  const { session_id, ...rest } = p;
  const high = isHighValue(p.amount_cents);
  return { ...rest, amount: centsToValue(p.amount_cents), high_value: high, needs_confirmation: high && !p.confirmed_at && p.status === STATUS.PENDING };
}

async function getRow(sid, id, exec) {
  const row = await (exec ?? await db()).get('SELECT * FROM purchases WHERE id = ? AND session_id = ?', [String(id), sid]);
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Purchase not found.');
  return row;
}

export async function getPurchase(sid, id) {
  return view(await getRow(sid, id));
}

export async function listPurchases(sid) {
  await expireStale(sid);
  return (await (await db()).all('SELECT * FROM purchases WHERE session_id = ? ORDER BY created_at DESC, rowid DESC', [sid])).map(view);
}

async function setStatus(sid, id, status, fields = {}) {
  const cols = { status, updated_at: now(), ...fields };
  const sql = `UPDATE purchases SET ${Object.keys(cols).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  const d = await db();
  await d.run(sql, [...Object.values(cols), id]);
  return getRow(sid, id, d);
}

/** Lazily expire stale rows: unapproved PayPal orders (3h), hung captures and reservations orphaned by a crash. */
async function expireStale(sid, exec) {
  const d = exec ?? await db();
  const t = now();
  const exp = await d.all("SELECT id FROM purchases WHERE session_id = ? AND status = 'pending' AND created_at < ?", [sid, t - ORDER_LIFETIME_MS]);
  for (const { id } of exp) {
    const r = await d.run("UPDATE purchases SET status='expired', reason='PayPal order expired before it was approved.', updated_at=? WHERE id=? AND status='pending'", [t, id]);
    if (r.changes) await audit(sid, id, 'purchase.expired', 'Order not approved within 3 hours; budget released', d);
  }
  const stuck = await d.all("SELECT id FROM purchases WHERE session_id = ? AND status = 'capturing' AND paypal_capture_id IS NULL AND updated_at < ?", [sid, t - 5 * 60_000]);
  for (const { id } of stuck) {
    const r = await d.run("UPDATE purchases SET status='pending', reason='Capture did not complete; retry the approval.', updated_at=? WHERE id=? AND status='capturing'", [t, id]);
    if (r.changes) await audit(sid, id, 'purchase.capture_reset', 'Capture attempt timed out; returned to pending (idempotent retry is safe)', d);
  }
  const orphans = await d.all("SELECT id FROM purchases WHERE session_id = ? AND status = 'reserving' AND created_at < ?", [sid, t - 5 * 60_000]);
  for (const { id } of orphans) {
    const r = await d.run("UPDATE purchases SET status='failed', reason='Order creation did not complete.', updated_at=? WHERE id=? AND status='reserving'", [t, id]);
    if (r.changes) await audit(sid, id, 'purchase.failed', 'Reservation orphaned; budget released', d);
  }
}

/**
 * The single entry point an AI agent (or any client) uses to ask for a purchase.
 * The policy engine decides; only approved proposals ever reach PayPal.
 */
export async function proposePurchase(sid, { product_id, qty = 1, rationale = '' }) {
  qty = Number(qty);
  const product = await getOffer(product_id);
  const id = randomUUID();
  const rat = String(rationale || '').slice(0, 300);

  // One write transaction: the budget check and the reservation cannot interleave with another proposal.
  const row = await tx(async (t) => {
    await expireStale(sid, t);
    const m = await getMandate(sid, t);
    const open = product
      ? await t.get(`SELECT 1 AS x FROM purchases WHERE session_id=? AND product_id=? AND status IN (${placeholders(COMMITTED)})`, [sid, product.id, ...COMMITTED])
      : null;
    // Pace: purchase requests that passed policy in the last hour (blocked/failed ones don't count against the agent).
    const recent = (await t.get("SELECT COUNT(*) AS c FROM purchases WHERE session_id=? AND created_at > ? AND status NOT IN ('blocked','failed')", [sid, now() - 3600_000])).c;
    const verdict = evaluate(m, product, qty, { stale: product?.stale, committed_cents: m.committed_cents, open_same_product: Boolean(open), now: now(), recent_count: recent });
    const stamp = now();
    const base = {
      product_id: product?.id ?? String(product_id).slice(0, 64),
      product_name: product?.name ?? 'Unknown product',
      merchant: product?.merchant ?? '-',
      category: product?.category ?? '-',
      qty: Number.isInteger(qty) && qty > 0 ? Math.min(qty, MAX_QTY) : 1,
    };
    const amount = verdict.amount_cents ?? (product ? product.price_cents * base.qty : 0);
    await t.run(`INSERT INTO purchases (id,session_id,product_id,product_name,merchant,category,qty,amount_cents,product_url,price_verified,status,reason,rationale,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, sid, base.product_id, base.product_name, base.merchant, base.category, base.qty, amount, product?.url ?? null, product?.price_verified ? 1 : 0,
        verdict.ok ? STATUS.RESERVING : STATUS.BLOCKED, verdict.ok ? null : `${verdict.code}: ${verdict.reason}`, rat, stamp, stamp]);
    if (verdict.ok) await audit(sid, id, 'policy.approved', `${product.name} x${qty} = ${money(verdict.amount_cents)} within mandate`, t);
    else await audit(sid, id, 'policy.blocked', `${verdict.code} - ${verdict.reason}`, t);
    return { verdict, id };
  });

  if (!row.verdict.ok) {
    return { purchase: await getPurchase(sid, id), allowed: false, code: row.verdict.code, reason: row.verdict.reason };
  }

  try {
    const order = await paypal.createOrder(await getRow(sid, id));
    await setStatus(sid, id, STATUS.PENDING, { paypal_order_id: order.id });
    await audit(sid, id, 'paypal.order_created', `Order ${order.id} (${order.status}) - waiting for human approval`);
    return { purchase: await getPurchase(sid, id), allowed: true };
  } catch (e) {
    const msg = e instanceof paypal.PayPalError ? e.message : 'Unexpected error creating PayPal order.';
    await setStatus(sid, id, STATUS.FAILED, { reason: msg });
    await audit(sid, id, 'paypal.order_failed', `${msg}${e.debugId ? ` (debug_id ${e.debugId})` : ''}`);
    return { purchase: await getPurchase(sid, id), allowed: false, code: 'PAYPAL_ERROR', reason: msg };
  }
}

/** Capture after the human approved in PayPal. Idempotent and safe to call twice. */
export async function capturePurchase(sid, id) {
  const row = await getRow(sid, id);
  if (row.status === STATUS.CAPTURED) return { purchase: view(row), outcome: 'already_captured' };
  if (row.status !== STATUS.PENDING) {
    throw new AppError(409, 'BAD_STATE', `Purchase is ${row.status}; only pending purchases can be captured.`);
  }
  if (isHighValue(row.amount_cents) && !row.confirmed_at) {
    throw new AppError(409, 'CONFIRMATION_REQUIRED', `This is a high-value purchase (${money(row.amount_cents)}). Confirm the amount before paying.`);
  }
  const claim = await (await db()).run("UPDATE purchases SET status='capturing', updated_at=? WHERE id=? AND status='pending'", [now(), row.id]);
  if (!claim.changes) {
    const cur = await getRow(sid, id);
    return { purchase: view(cur), outcome: cur.status === STATUS.CAPTURED ? 'already_captured' : 'in_progress' };
  }

  try {
    const order = await paypal.captureOrder(row.paypal_order_id, row.id);
    return await finishCapture(sid, row, order);
  } catch (e) {
    if (e instanceof AppError) throw e;
    if (!(e instanceof paypal.PayPalError)) {
      // Network failure / timeout: the capture may or may not have happened. Return to pending so a retry
      // (same PayPal-Request-Id) either completes it or reports ORDER_ALREADY_CAPTURED.
      const reason = 'Could not reach PayPal to confirm the payment. Please retry.';
      await setStatus(sid, id, STATUS.PENDING, { reason });
      await audit(sid, id, 'paypal.capture_error', `Network error: ${e.message}`);
      throw new AppError(502, 'NETWORK', reason);
    }
    if (e.hasIssue('ORDER_ALREADY_CAPTURED')) {
      // Duplicate click / retry after a lost response: confirm with PayPal rather than assuming.
      const order = await paypal.getOrder(row.paypal_order_id);
      return finishCapture(sid, row, order, 'already_captured');
    }
    if (e.hasIssue('INSTRUMENT_DECLINED')) {
      const reason = 'PayPal declined this payment method. Try a different funding source or re-request the purchase.';
      await setStatus(sid, id, STATUS.DECLINED, { reason });
      await audit(sid, id, 'paypal.declined', `INSTRUMENT_DECLINED (debug_id ${e.debugId ?? 'n/a'}); budget released`);
      return { purchase: await getPurchase(sid, id), outcome: 'declined' };
    }
    // Not approved yet / transient error: return to pending so the human can retry; the idempotency key prevents double capture.
    const reason = e.hasIssue('ORDER_NOT_APPROVED')
      ? 'The PayPal approval has not completed yet.'
      : `PayPal could not capture this payment right now (${e.message}). Please retry.`;
    await setStatus(sid, id, STATUS.PENDING, { reason });
    await audit(sid, id, 'paypal.capture_error', `${e.issues.join(',') || e.status} ${e.debugId ? `(debug_id ${e.debugId})` : ''}`.trim());
    throw new AppError(e.hasIssue('ORDER_NOT_APPROVED') ? 409 : 502, e.issues[0] || 'PAYPAL_ERROR', reason);
  }
}

async function finishCapture(sid, row, order, outcome = 'captured') {
  const cap = paypal.firstCapture(order);
  const expected = centsToValue(row.amount_cents);
  if (!cap || cap.amount?.value !== expected || cap.amount?.currency_code !== config.paypal.currency) {
    await setStatus(sid, row.id, STATUS.FAILED, { reason: 'PayPal capture did not match the expected amount; flagged for review.' });
    await audit(sid, row.id, 'paypal.amount_mismatch', `expected ${expected}, got ${cap?.amount?.value}`);
    return { purchase: await getPurchase(sid, row.id), outcome: 'failed' };
  }
  const payer = order.payer?.email_address ?? null;
  if (cap.status === 'COMPLETED') {
    await setStatus(sid, row.id, STATUS.CAPTURED, { paypal_capture_id: cap.id, payer_email: payer, reason: null });
    await audit(sid, row.id, 'paypal.captured', `Capture ${cap.id} COMPLETED for ${money(row.amount_cents)}${payer ? ` from ${payer}` : ''}`);
    return { purchase: await getPurchase(sid, row.id), outcome };
  }
  // PENDING / other: keep funds reserved; the PAYMENT.CAPTURE.COMPLETED webhook finalises it.
  await setStatus(sid, row.id, STATUS.CAPTURING, { paypal_capture_id: cap.id, payer_email: payer, reason: `PayPal capture status: ${cap.status}` });
  await audit(sid, row.id, 'paypal.capture_pending', `Capture ${cap.id} is ${cap.status}; awaiting webhook`);
  return { purchase: await getPurchase(sid, row.id), outcome: 'pending_review' };
}

export async function cancelPurchase(sid, id, why = 'Cancelled by the human approver.') {
  const row = await getRow(sid, id);
  if (row.status !== STATUS.PENDING) {
    if ([STATUS.CANCELLED, STATUS.DECLINED, STATUS.EXPIRED, STATUS.BLOCKED].includes(row.status)) return view(row);
    throw new AppError(409, 'BAD_STATE', `Purchase is ${row.status} and cannot be cancelled.`);
  }
  const out = await setStatus(sid, id, STATUS.CANCELLED, { reason: why });
  await audit(sid, id, 'purchase.cancelled', `${why} Budget released.`);
  return view(out);
}

export async function refundPurchase(sid, id) {
  const row = await getRow(sid, id);
  if (row.status === STATUS.REFUNDED) return view(row);
  if (row.status !== STATUS.CAPTURED || !row.paypal_capture_id) {
    throw new AppError(409, 'BAD_STATE', 'Only captured purchases can be refunded.');
  }
  const claim = await (await db()).run("UPDATE purchases SET status='refunding', updated_at=? WHERE id=? AND status='captured'", [now(), row.id]);
  if (!claim.changes) return getPurchase(sid, id);
  try {
    const refund = await paypal.refundCapture(row.paypal_capture_id, row);
    await setStatus(sid, id, STATUS.REFUNDED, { paypal_refund_id: refund.id, reason: 'Refunded to the buyer.' });
    await audit(sid, id, 'paypal.refunded', `Refund ${refund.id} ${refund.status}; budget released`);
  } catch (e) {
    const already = e instanceof paypal.PayPalError && e.hasIssue('CAPTURE_FULLY_REFUNDED');
    await setStatus(sid, id, already ? STATUS.REFUNDED : STATUS.CAPTURED, { reason: already ? 'Already refunded at PayPal.' : `Refund failed: ${e.message}` });
    await audit(sid, id, already ? 'paypal.refunded' : 'paypal.refund_failed', e.message);
    if (!already) throw new AppError(502, 'REFUND_FAILED', `Refund failed: ${e.message}`);
  }
  return getPurchase(sid, id);
}

// ---------------------------------------------------------------- confirmations for big decisions

/** High-value purchases: the human must type the exact amount before the payment can be made (enforced again at capture). */
export async function confirmPurchase(sid, id, amountCents) {
  const row = await getRow(sid, id);
  if (row.status !== STATUS.PENDING) throw new AppError(409, 'BAD_STATE', `Purchase is ${row.status}; only pending purchases can be confirmed.`);
  if (!isHighValue(row.amount_cents)) return view(row);
  if (row.confirmed_at) return view(row);
  if (!Number.isInteger(amountCents) || amountCents !== row.amount_cents) {
    throw new AppError(400, 'AMOUNT_MISMATCH', `The amount you typed does not match ${money(row.amount_cents)}.`);
  }
  await (await db()).run('UPDATE purchases SET confirmed_at=?, updated_at=? WHERE id=? AND confirmed_at IS NULL', [now(), now(), row.id]);
  await audit(sid, id, 'purchase.confirmed', `Human confirmed the high-value amount ${money(row.amount_cents)} before payment`);
  return getPurchase(sid, id);
}

/**
 * Refund step 1. Nothing moves yet: this opens a one-time confirmation that cannot be used until the cooling-off delay has
 * passed, and that expires shortly after. The token is returned once and only its hash is stored.
 */
export async function requestRefund(sid, id) {
  const row = await getRow(sid, id);
  if (row.status === STATUS.REFUNDED) throw new AppError(409, 'BAD_STATE', 'This purchase was already refunded.');
  if (row.status !== STATUS.CAPTURED || !row.paypal_capture_id) throw new AppError(409, 'BAD_STATE', 'Only captured purchases can be refunded.');
  const token = randomBytes(24).toString('hex');
  const t = now();
  const availableAt = t + config.safety.refundCoolingSeconds * 1000;
  const expiresAt = availableAt + config.safety.refundWindowSeconds * 1000;
  const d = await db();
  await d.run("DELETE FROM confirmations WHERE purchase_id = ? AND kind = 'refund' AND consumed_at IS NULL", [row.id]);
  await d.run('INSERT INTO confirmations (id, session_id, purchase_id, kind, token_hash, available_at, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [randomUUID(), sid, row.id, 'refund', sha(token), availableAt, expiresAt, t]);
  await audit(sid, id, 'refund.requested', `Refund of ${money(row.amount_cents)} requested; it can be confirmed after ${config.safety.refundCoolingSeconds}s and the request expires after ${config.safety.refundWindowSeconds / 60} min`);
  return { token, available_at: availableAt, expires_at: expiresAt, cooling_seconds: config.safety.refundCoolingSeconds, purchase: view(row) };
}

/** Refund step 2: valid token + cooling-off over + not expired + not used twice. Only then PayPal is asked to refund. */
export async function confirmRefund(sid, id, token) {
  const row = await getRow(sid, id);
  const d = await db();
  const c = await d.get("SELECT * FROM confirmations WHERE purchase_id = ? AND session_id = ? AND kind = 'refund' AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1", [row.id, sid]);
  if (!c) throw new AppError(409, 'NO_REFUND_REQUEST', 'There is no open refund request for this purchase. Start one first.');
  const given = Buffer.from(sha(token ?? ''), 'hex');
  const want = Buffer.from(c.token_hash, 'hex');
  if (given.length !== want.length || !timingSafeEqual(given, want)) throw new AppError(403, 'BAD_CONFIRMATION', 'That confirmation is not valid.');
  const t = now();
  if (t > c.expires_at) throw new AppError(410, 'CONFIRMATION_EXPIRED', 'The refund request expired. Start a new one.');
  if (t < c.available_at) {
    const wait = Math.ceil((c.available_at - t) / 1000);
    throw new AppError(425, 'TOO_EARLY', `Refunds have a cooling-off delay. You can confirm in ${wait}s.`, { retry_after_seconds: wait, available_at: c.available_at });
  }
  const use = await d.run('UPDATE confirmations SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', [t, c.id]);
  if (!use.changes) throw new AppError(409, 'NO_REFUND_REQUEST', 'This confirmation was already used.');
  await audit(sid, id, 'refund.confirmed', `Human confirmed the refund of ${money(row.amount_cents)} after the cooling-off period`);
  return refundPurchase(sid, id);
}

export async function cancelRefundRequest(sid, id) {
  const row = await getRow(sid, id);
  const r = await (await db()).run("DELETE FROM confirmations WHERE purchase_id = ? AND session_id = ? AND kind = 'refund' AND consumed_at IS NULL", [row.id, sid]);
  if (r.changes) await audit(sid, id, 'refund.cancelled', 'Refund request cancelled by the human; nothing was refunded');
  return { cancelled: r.changes > 0 };
}

// ---------------------------------------------------------------- webhooks
/**
 * Apply a verified PayPal webhook event. Idempotent on event id, and tolerant of ordering:
 * a webhook may arrive before (or instead of) the browser's capture call.
 */
export async function applyWebhookEvent(event) {
  const d = await db();
  const seen = await d.run('INSERT OR IGNORE INTO webhook_events (event_id, event_type, received_at) VALUES (?,?,?)',
    [String(event.id), String(event.event_type), now()]);
  if (!seen.changes) return { duplicate: true };

  const r = event.resource || {};
  const purchaseId = r.custom_id;
  let row = purchaseId ? await d.get('SELECT * FROM purchases WHERE id = ?', [String(purchaseId)]) : null;
  if (!row && r.supplementary_data?.related_ids?.order_id) {
    row = await d.get('SELECT * FROM purchases WHERE paypal_order_id = ?', [r.supplementary_data.related_ids.order_id]);
  }
  if (!row && event.event_type === 'PAYMENT.CAPTURE.REFUNDED') {
    // Refund resource has no custom_id; the 'up' link points at the capture.
    const up = (r.links || []).find((l) => l.rel === 'up')?.href || '';
    const capId = up.split('/').pop();
    if (capId) row = await d.get('SELECT * FROM purchases WHERE paypal_capture_id = ?', [capId]);
  }
  if (!row) return { ignored: true };

  const sid = row.session_id;
  switch (event.event_type) {
    case 'PAYMENT.CAPTURE.COMPLETED':
      if ([STATUS.PENDING, STATUS.CAPTURING].includes(row.status) && r.amount?.value === centsToValue(row.amount_cents)) {
        await setStatus(sid, row.id, STATUS.CAPTURED, { paypal_capture_id: r.id, reason: null });
        await audit(sid, row.id, 'webhook.captured', `PAYMENT.CAPTURE.COMPLETED ${r.id} (event ${event.id})`);
      } else {
        await audit(sid, row.id, 'webhook.noop', `PAYMENT.CAPTURE.COMPLETED confirmed existing state "${row.status}"`);
      }
      break;
    case 'PAYMENT.CAPTURE.DENIED':
      if ([STATUS.PENDING, STATUS.CAPTURING].includes(row.status)) {
        await setStatus(sid, row.id, STATUS.DECLINED, { reason: 'PayPal denied the capture.' });
        await audit(sid, row.id, 'webhook.denied', `PAYMENT.CAPTURE.DENIED (event ${event.id}); budget released`);
      }
      break;
    case 'PAYMENT.CAPTURE.REFUNDED':
      if ([STATUS.CAPTURED, STATUS.REFUNDING].includes(row.status)) {
        await setStatus(sid, row.id, STATUS.REFUNDED, { paypal_refund_id: r.id, reason: 'Refunded to the buyer.' });
        await audit(sid, row.id, 'webhook.refunded', `PAYMENT.CAPTURE.REFUNDED (event ${event.id}); budget released`);
      }
      break;
    default:
      await audit(sid, row.id, 'webhook.ignored', event.event_type);
  }
  return { applied: true };
}

// ---------------------------------------------------------------- MCP connection tokens
// Lets an external agent (Claude Desktop/Code, any MCP client) spend through the SAME policy gate.
// Only the sha256 of the token is stored; the plaintext is shown once at creation.
const sha = (t) => createHash('sha256').update(String(t)).digest('hex');

export async function issueMcpToken(sid) {
  const token = `mnd_${randomBytes(24).toString('base64url')}`;
  await (await db()).run('UPDATE sessions SET mcp_token_hash = ? WHERE id = ?', [sha(token), sid]);
  await audit(sid, null, 'mcp.token_issued', 'A connection token for external agents (MCP) was generated; any previous token is revoked');
  return token;
}

export async function revokeMcpToken(sid) {
  await (await db()).run('UPDATE sessions SET mcp_token_hash = NULL WHERE id = ?', [sid]);
  await audit(sid, null, 'mcp.token_revoked', 'External agent connection token revoked');
}

export async function hasMcpToken(sid) {
  return Boolean((await (await db()).get('SELECT mcp_token_hash AS h FROM sessions WHERE id = ?', [sid]))?.h);
}

export async function sessionForMcpToken(token) {
  if (!/^mnd_[\w-]{20,64}$/.test(String(token))) return null;
  return (await (await db()).get('SELECT id FROM sessions WHERE mcp_token_hash = ?', [sha(token)]))?.id ?? null;
}
