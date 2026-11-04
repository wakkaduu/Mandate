// Two finance-facing features built on the purchase service:
//   1. Export of the ledger / audit trail as CSV or JSON (for finance, compliance, expense reports).
//   2. Mandate PROPOSALS: the assistant may suggest a change to the limits, but only a human can apply it.
import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { AppError, getMandate, requireConfigured, updateMandate, listCategories, listPurchases, listAudit, audit } from './purchases.js';
import { money, centsToValue } from './policy.js';
import { normalizeSellerList } from './sellers.js';

const now = () => Date.now();

// ------------------------------------------------------------------ export
const iso = (ms) => (ms ? new Date(ms).toISOString() : '');
const PURCHASE_COLUMNS = [
  ['time', (r) => iso(r.created_at)], ['purchase_id', (r) => r.id], ['item', (r) => r.product_name], ['seller', (r) => r.merchant], ['category', (r) => r.category],
  ['quantity', (r) => r.qty], ['amount_usd', (r) => centsToValue(r.amount_cents)], ['status', (r) => r.status], ['policy_note', (r) => r.reason], ['assistant_reason', (r) => r.rationale],
  ['product_url', (r) => r.product_url], ['price_verified', (r) => (r.price_verified ? 'yes' : 'no')],
  ['paypal_order_id', (r) => r.paypal_order_id], ['paypal_capture_id', (r) => r.paypal_capture_id], ['paypal_refund_id', (r) => r.paypal_refund_id],
];
const AUDIT_COLUMNS = [['id', (r) => r.id], ['time', (r) => iso(r.created_at)], ['event', (r) => r.type], ['purchase_id', (r) => r.purchase_id], ['item', (r) => r.product_name], ['detail', (r) => r.detail]];

/** Spreadsheet-safe: a cell starting with = + - @ (or tab/CR) would be executed as a formula by Excel/Sheets, so it is prefixed. */
const guard = (v) => { const s = v == null ? '' : String(v); return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; };
const cell = (v) => { const s = guard(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function toCsv(rows, columns) {
  const head = columns.map(([label]) => cell(label)).join(',');
  const body = rows.map((r) => columns.map(([, get]) => cell(get(r))).join(','));
  return `﻿${[head, ...body].join('\r\n')}\r\n`; // BOM so Excel reads UTF-8
}

/** @returns {{filename:string, type:string, body:string}} */
export async function exportLedger(sid, { kind = 'purchases', format = 'csv' } = {}) {
  if (!['purchases', 'audit'].includes(kind) || !['csv', 'json'].includes(format)) throw new AppError(400, 'BAD_INPUT', 'kind must be purchases or audit; format must be csv or json.');
  const rows = kind === 'purchases' ? await listPurchases(sid) : await listAudit(sid, 10_000);
  const cols = kind === 'purchases' ? PURCHASE_COLUMNS : AUDIT_COLUMNS;
  const day = new Date().toISOString().slice(0, 10);
  await audit(sid, null, 'ledger.exported', `Exported ${rows.length} ${kind} row(s) as ${format.toUpperCase()}`);
  if (format === 'csv') return { filename: `mandate-${kind}-${day}.csv`, type: 'text/csv; charset=utf-8', body: toCsv(rows, cols) };
  return { filename: `mandate-${kind}-${day}.json`, type: 'application/json; charset=utf-8', body: JSON.stringify(rows.map((r) => Object.fromEntries(cols.map(([label, get]) => [label, get(r) ?? null]))), null, 2) };
}

// ------------------------------------------------------------------ mandate proposals (the assistant suggests, the human decides)
const MAX_OPEN_PER_HOUR = 5;

function usdToCents(v, label) {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1 || n > 10_000) throw new AppError(400, 'BAD_INPUT', `${label} must be between $1 and $10,000.`);
  return Math.round(n * 100);
}

export async function createProposal(sid, input = {}) {
  await requireConfigured(sid); // there is nothing to adjust until the owner has set the mandate up
  const reason = String(input.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!reason) throw new AppError(400, 'BAD_INPUT', 'Say why you are suggesting the change.');
  const known = new Set(listCategories());
  const cats = (v, label) => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((c) => !known.has(c))) throw new AppError(400, 'BAD_INPUT', `${label} must be a subset of: ${[...known].join(', ')}.`);
    return [...new Set(v)];
  };
  const changes = {};
  const set = (k, v) => { if (v !== undefined && !(Array.isArray(v) && !v.length)) changes[k] = v; };
  set('budget_cents', usdToCents(input.budget_usd, 'Budget'));
  set('per_item_cap_cents', usdToCents(input.per_purchase_cap_usd, 'Per-purchase cap'));
  set('max_per_day_cents', usdToCents(input.max_per_day_usd, 'Daily limit'));
  set('add_categories', cats(input.add_categories, 'add_categories'));
  set('remove_categories', cats(input.remove_categories, 'remove_categories'));
  if (input.block_sellers !== undefined) {
    const r = normalizeSellerList(input.block_sellers);
    if (r.bad) throw new AppError(400, 'BAD_INPUT', `block_sellers must be domain names like example.com (problem: ${r.bad}).`);
    set('block_sellers', r.list);
  }
  if (!Object.keys(changes).length) throw new AppError(400, 'BAD_INPUT', 'Nothing to change: give at least one limit.');

  const cur = await getMandate(sid);
  const lines = [];
  if (changes.budget_cents !== undefined) lines.push(`Budget ${money(cur.budget_cents)} → ${money(changes.budget_cents)}`);
  if (changes.per_item_cap_cents !== undefined) lines.push(`Per-purchase cap ${money(cur.per_item_cap_cents)} → ${money(changes.per_item_cap_cents)}`);
  if (changes.max_per_day_cents !== undefined) lines.push(`Daily limit ${cur.max_per_day_cents === null ? 'none' : money(cur.max_per_day_cents)} → ${money(changes.max_per_day_cents)}`);
  if (changes.add_categories) lines.push(`Allow categories: ${changes.add_categories.join(', ')}`);
  if (changes.remove_categories) lines.push(`Stop allowing: ${changes.remove_categories.join(', ')}`);
  if (changes.block_sellers) lines.push(`Block sellers: ${changes.block_sellers.join(', ')}`);

  const d = await db();
  const recent = (await d.get('SELECT COUNT(*) AS c FROM mandate_proposals WHERE session_id = ? AND created_at > ?', [sid, now() - 3600_000])).c;
  if (recent >= MAX_OPEN_PER_HOUR) throw new AppError(429, 'RATE_LIMITED', 'Too many suggested changes in the last hour.');
  await d.run("UPDATE mandate_proposals SET status = 'superseded', decided_at = ? WHERE session_id = ? AND status = 'open'", [now(), sid]);
  const id = randomUUID();
  await d.run('INSERT INTO mandate_proposals (id, session_id, changes, summary, reason, status, created_at) VALUES (?,?,?,?,?,?,?)',
    [id, sid, JSON.stringify(changes), JSON.stringify(lines), reason, 'open', now()]);
  await audit(sid, null, 'mandate.proposed', `Suggested (not applied): ${lines.join('; ')}. Reason: ${reason}`);
  return { id, summary: lines, reason };
}

export async function listOpenProposals(sid) {
  const rows = await (await db()).all("SELECT id, summary, reason, created_at FROM mandate_proposals WHERE session_id = ? AND status = 'open' ORDER BY created_at DESC", [sid]);
  return rows.map((r) => ({ id: r.id, reason: r.reason, summary: JSON.parse(r.summary), created_at: r.created_at }));
}

async function getOpen(sid, id) {
  const row = await (await db()).get('SELECT * FROM mandate_proposals WHERE id = ? AND session_id = ?', [String(id), sid]);
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Suggestion not found.');
  if (row.status !== 'open') throw new AppError(409, 'BAD_STATE', `That suggestion was already ${row.status}.`);
  return row;
}

/** Applying is a human act: the caller must acknowledge. Every increase of spending power is then covered by that acknowledgement. */
export async function applyProposal(sid, id, acknowledged) {
  const row = await getOpen(sid, id);
  const summary = JSON.parse(row.summary);
  if (acknowledged !== true) {
    throw new AppError(409, 'CONFIRMATION_REQUIRED', 'Review the suggested change and confirm to apply it.', { changes: summary.map((line) => ({ field: 'suggestion', from: '', to: line })) });
  }
  const ch = JSON.parse(row.changes);
  const cur = await getMandate(sid);
  const categories = cur.categories.filter((c) => !(ch.remove_categories ?? []).includes(c));
  for (const c of ch.add_categories ?? []) if (!categories.includes(c)) categories.push(c);
  const mandate = await updateMandate(sid, {
    budget_cents: ch.budget_cents ?? cur.budget_cents,
    per_item_cap_cents: ch.per_item_cap_cents ?? cur.per_item_cap_cents,
    max_per_day_cents: ch.max_per_day_cents ?? cur.max_per_day_cents,
    categories,
    blocked_sellers: [...new Set([...cur.blocked_sellers, ...(ch.block_sellers ?? [])])],
    confirm_increase: true,
  });
  await (await db()).run("UPDATE mandate_proposals SET status = 'applied', decided_at = ? WHERE id = ?", [now(), row.id]);
  await audit(sid, null, 'mandate.proposal_applied', `Human applied the assistant's suggestion: ${summary.join('; ')}`);
  return { mandate };
}

export async function dismissProposal(sid, id) {
  const row = await getOpen(sid, id);
  await (await db()).run("UPDATE mandate_proposals SET status = 'dismissed', decided_at = ? WHERE id = ?", [now(), row.id]);
  await audit(sid, null, 'mandate.proposal_dismissed', 'Human dismissed the assistant\'s suggested change');
  return { dismissed: true };
}
