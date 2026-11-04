// The agent tool surface, shared by every "brain": the Claude loop, the offline agent and the MCP server.
// Nothing here can move money: propose_purchase goes through the policy gate and ends in a PayPal order
// that a human must approve.
import { searchProducts, proposePurchase, getMandate } from './purchases.js';
import { money } from './policy.js';

export const TOOLS = [
  {
    name: 'search_catalog',
    description: 'Search the product catalog. Returns up to 8 products with id, name, merchant, category, price in USD.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, e.g. "mechanical keyboard"' },
        max_price_usd: { type: 'number', description: 'Optional maximum unit price in USD' },
        category: { type: 'string', description: 'Optional category filter (office, electronics, furniture, home)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'propose_purchase',
    description: 'Request a purchase on behalf of the user. It is checked against their spending mandate; if allowed, a PayPal order is created for the human to approve. You cannot spend money directly.',
    input_schema: {
      type: 'object',
      properties: {
        product_id: { type: 'string' },
        qty: { type: 'integer', description: 'Quantity, default 1' },
        rationale: { type: 'string', description: 'One sentence: why this item' },
      },
      required: ['product_id', 'rationale'],
    },
  },
  {
    name: 'get_mandate',
    description: 'Get the spending mandate limits and the remaining budget.',
    input_schema: { type: 'object', properties: {} },
  },
];

const productView = (p) => ({ id: p.id, name: p.name, merchant: p.merchant, category: p.category, price_usd: p.price_cents / 100, description: p.description });

/**
 * Execute a tool. Returns { result, step } where `result` is the JSON handed back to the model/MCP client
 * and `step` is a short human-readable trace line for the UI's "agent activity" view.
 */
export async function runTool(sid, name, input = {}) {
  try {
    if (name === 'search_catalog') {
      const max = Number.isFinite(input?.max_price_usd) ? Math.round(input.max_price_usd * 100) : undefined;
      const products = searchProducts({ query: String(input?.query ?? ''), max_price_cents: max, category: input?.category }).map(productView);
      return {
        result: { products },
        step: { tool: name, ok: true, text: `Searched "${String(input?.query ?? '').slice(0, 60)}"${max ? ` (up to ${money(max)})` : ''}: ${products.length} result${products.length === 1 ? '' : 's'}` },
      };
    }
    if (name === 'propose_purchase') {
      const res = await proposePurchase(sid, { product_id: input?.product_id, qty: input?.qty ?? 1, rationale: input?.rationale });
      const p = res.purchase;
      if (res.allowed) {
        return {
          result: { status: 'awaiting_human_approval', product: p.product_name, amount_usd: p.amount, note: 'A PayPal order was created; the human must approve it.' },
          step: { tool: name, ok: true, text: `Proposed ${p.product_name}${p.qty > 1 ? ` x${p.qty}` : ''} (${money(p.amount_cents)}): policy passed, PayPal order created` },
          purchase: p,
        };
      }
      return {
        result: { status: 'blocked', code: res.code, reason: res.reason, product: p.product_name },
        step: { tool: name, ok: false, text: `Proposed ${p.product_name} (${money(p.amount_cents)}): ${res.code === 'PAYPAL_ERROR' ? 'PayPal order failed' : 'blocked'} (${res.code})` },
        purchase: p,
        blocked: res,
      };
    }
    if (name === 'get_mandate') {
      const m = await getMandate(sid);
      return {
        result: {
          budget_usd: m.budget_cents / 100, per_purchase_cap_usd: m.per_item_cap_cents / 100, allowed_categories: m.categories,
          remaining_usd: m.remaining_cents / 100, max_requests_per_hour: m.max_per_hour, expired: m.expired,
        },
        step: { tool: name, ok: true, text: `Checked the mandate: ${money(m.remaining_cents)} remaining` },
      };
    }
    return { result: { error: `Unknown tool ${name}` }, step: { tool: name, ok: false, text: `Unknown tool ${name}` } };
  } catch (e) {
    return { result: { error: e.message }, step: { tool: name, ok: false, text: `${name} failed: ${e.message}` } };
  }
}
