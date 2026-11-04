// The mandate policy engine. Pure functions: easy to test, impossible for an LLM to talk its way around.
import { sellerOf, sellerMatches } from './sellers.js';

export const MAX_QTY = 5;

/**
 * Budget committed against a mandate = captured purchases + purchases that are reserved/awaiting approval.
 * Declined / cancelled / expired / failed / blocked / refunded purchases release their funds.
 */
export const COMMITTED_STATUSES = ['reserving', 'pending', 'capturing', 'captured'];

/**
 * @param {{budget_cents:number, per_item_cap_cents:number, categories:string[], expires_at?:number|null, max_per_hour?:number|null, max_per_day_cents?:number|null, blocked_sellers?:string[], allowed_sellers?:string[]}} mandate
 * @param {{id:string, category:string, price_cents:number, name:string, url?:string}|undefined} product
 * @param {number} qty
 * @param {{committed_cents:number, day_committed_cents?:number, open_same_product:boolean, now?:number, recent_count?:number, stale?:boolean}} ctx
 * @returns {{ok:true, amount_cents:number} | {ok:false, code:string, reason:string, amount_cents?:number}}
 */
export function evaluate(mandate, product, qty, ctx) {
  if (!product) return { ok: false, code: 'UNKNOWN_PRODUCT', reason: 'That offer does not exist. Search for the product first and use the offer_id from the results.' };
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
    return { ok: false, code: 'BAD_QUANTITY', reason: `Quantity must be a whole number between 1 and ${MAX_QTY}.` };
  }
  if (ctx.stale) return { ok: false, code: 'STALE_PRICE', reason: 'That price was checked too long ago and may have changed. Search for the product again.', amount_cents: product.price_cents * qty };
  const amount = product.price_cents * qty;
  const fail = (code, reason) => ({ ok: false, code, reason, amount_cents: amount });

  if (mandate.expires_at && (ctx.now ?? Date.now()) > mandate.expires_at) {
    return fail('MANDATE_EXPIRED', 'This mandate has expired; the agent no longer has spending authority.');
  }
  if (!mandate.categories.includes(product.category)) {
    return fail('CATEGORY_NOT_ALLOWED',
      `Category "${product.category}" is outside this mandate (allowed: ${mandate.categories.join(', ') || 'none'}).`);
  }
  // Seller controls: a blocked domain is never allowed; if an allow-list exists, only those domains are.
  const host = sellerOf(product.url ?? '');
  const blocked = (mandate.blocked_sellers ?? []).find((b) => host && sellerMatches(host, b));
  if (blocked) return fail('SELLER_BLOCKED', `${blocked} is on this mandate's blocked sellers list.`);
  const allowed = mandate.allowed_sellers ?? [];
  if (allowed.length && !(host && allowed.some((a) => sellerMatches(host, a)))) {
    return fail('SELLER_NOT_ALLOWED', `${host || 'This seller'} is not on this mandate's list of allowed sellers (${allowed.join(', ')}).`);
  }
  if (ctx.open_same_product) {
    return fail('DUPLICATE', `"${product.name}" is already awaiting approval or purchased under this mandate.`);
  }
  if (amount > mandate.per_item_cap_cents) {
    return fail('OVER_ITEM_CAP',
      `${money(amount)} exceeds the per-purchase cap of ${money(mandate.per_item_cap_cents)}.`);
  }
  const remaining = mandate.budget_cents - ctx.committed_cents;
  if (amount > remaining) {
    return fail('OVER_BUDGET',
      `${money(amount)} exceeds the remaining budget of ${money(Math.max(remaining, 0))}.`);
  }
  if (mandate.max_per_day_cents && (ctx.day_committed_cents ?? 0) + amount > mandate.max_per_day_cents) {
    const left = Math.max(mandate.max_per_day_cents - (ctx.day_committed_cents ?? 0), 0);
    return fail('OVER_DAILY', `${money(amount)} would exceed the daily limit of ${money(mandate.max_per_day_cents)} (${money(left)} left in the last 24 hours).`);
  }
  if (mandate.max_per_hour && (ctx.recent_count ?? 0) >= mandate.max_per_hour) {
    return fail('OVER_PACE', `The agent already made ${ctx.recent_count} purchase requests in the last hour (limit ${mandate.max_per_hour}/hour).`);
  }
  return { ok: true, amount_cents: amount };
}

export function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

export function centsToValue(cents) {
  return (cents / 100).toFixed(2);
}
