// The mandate policy engine. Pure functions: easy to test, impossible for an LLM to talk its way around.

export const MAX_QTY = 5;

/**
 * Budget committed against a mandate = captured purchases + purchases that are reserved/awaiting approval.
 * Declined / cancelled / expired / failed / blocked / refunded purchases release their funds.
 */
export const COMMITTED_STATUSES = ['reserving', 'pending', 'capturing', 'captured'];

/**
 * @param {{budget_cents:number, per_item_cap_cents:number, categories:string[], expires_at?:number|null, max_per_hour?:number|null}} mandate
 * @param {{id:string, category:string, price_cents:number, name:string}|undefined} product
 * @param {number} qty
 * @param {{committed_cents:number, open_same_product:boolean, now?:number, recent_count?:number}} ctx
 * @returns {{ok:true, amount_cents:number} | {ok:false, code:string, reason:string, amount_cents?:number}}
 */
export function evaluate(mandate, product, qty, ctx) {
  if (!product) return { ok: false, code: 'UNKNOWN_PRODUCT', reason: 'That product is not in the catalog.' };
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
    return { ok: false, code: 'BAD_QUANTITY', reason: `Quantity must be a whole number between 1 and ${MAX_QTY}.` };
  }
  const amount = product.price_cents * qty;
  const fail = (code, reason) => ({ ok: false, code, reason, amount_cents: amount });

  if (mandate.expires_at && (ctx.now ?? Date.now()) > mandate.expires_at) {
    return fail('MANDATE_EXPIRED', 'This mandate has expired; the agent no longer has spending authority.');
  }
  if (!mandate.categories.includes(product.category)) {
    return fail('CATEGORY_NOT_ALLOWED',
      `Category "${product.category}" is outside this mandate (allowed: ${mandate.categories.join(', ') || 'none'}).`);
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
