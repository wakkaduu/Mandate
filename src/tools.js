// The agent tool surface, shared by every "brain" (Gemini loop, Claude loop) and the external-agent endpoint.
// Nothing here can move money: propose_purchase goes through the policy gate and ends in a PayPal order
// that a human must approve.
import { proposePurchase, getMandate } from './purchases.js';
import { evaluate } from './policy.js';
import { createProposal } from './ledger-tools.js';
import { searchWeb, SearchUnavailable } from './web/search.js';
import { config } from './config.js';
import { CATEGORIES } from './categories.js';
import { money } from './policy.js';

export const TOOLS = [
  {
    name: 'search_products',
    description: 'Search the live web for products to buy. Returns up to 6 offers; each has an offer_id, title, merchant, category, unit price in USD, the retailer URL and fits_mandate (a server pre-check against the user\'s mandate: category, per-purchase cap, remaining budget). The server opened every product page and read the price and category itself, so these are authoritative. Call it once per item the user wants, with a short specific query.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to find, e.g. "mechanical keyboard hot-swappable"' },
        max_price_usd: { type: 'number', description: 'Optional maximum unit price in USD' },
        category: { type: 'string', description: `Optional category hint: ${CATEGORIES.join(', ')}` },
      },
      required: ['query'],
    },
  },
  {
    name: 'propose_purchase',
    description: 'Request a purchase of one offer returned by search_products. It is checked against the user\'s spending mandate; if allowed, a PayPal order is created for the human to approve. You cannot spend money directly and you cannot set the price.',
    input_schema: {
      type: 'object',
      properties: {
        offer_id: { type: 'string', description: 'The offer_id from search_products' },
        qty: { type: 'integer', description: 'Quantity, default 1' },
        rationale: { type: 'string', description: 'One sentence: why this item' },
      },
      required: ['offer_id', 'rationale'],
    },
  },
  {
    name: 'suggest_mandate_change',
    description: 'Suggest a change to the user\'s spending limits (budget, per-purchase cap, daily limit, allowed categories, blocked sellers). You CANNOT change limits: the human reviews your suggestion and decides. Use it only when the user asks to change their limits, or when something they insisted on was blocked by a limit. Always give a short reason.',
    input_schema: {
      type: 'object',
      properties: {
        budget_usd: { type: 'number', description: 'New total budget in USD' },
        per_purchase_cap_usd: { type: 'number', description: 'New per-purchase cap in USD' },
        max_per_day_usd: { type: 'number', description: 'New rolling 24-hour limit in USD' },
        add_categories: { type: 'array', items: { type: 'string' }, description: `Categories to allow: ${CATEGORIES.join(', ')}` },
        remove_categories: { type: 'array', items: { type: 'string' }, description: 'Categories to stop allowing' },
        block_sellers: { type: 'array', items: { type: 'string' }, description: 'Seller domains to block, e.g. example.com' },
        reason: { type: 'string', description: 'One sentence: why you suggest this' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'get_mandate',
    description: 'Get the spending mandate limits and the remaining budget.',
    input_schema: { type: 'object', properties: {} },
  },
];

const offerView = (o, m) => {
  // Same policy engine the purchase gate uses, run for qty 1 so the model can pick in-policy options up front.
  const v = evaluate(m, o, 1, { committed_cents: m.committed_cents, day_committed_cents: m.spent_today_cents, open_same_product: false });
  return {
    offer_id: o.id, title: o.name, merchant: o.merchant, category: o.category, price_usd: o.price_cents / 100, url: o.url, price_verified: o.price_verified,
    fits_mandate: v.ok, ...(v.ok ? {} : { mandate_issue: `${v.code}: ${v.reason}` }),
  };
};

// Each web search costs a model call plus up to 6 page fetches: cap it per session (best effort, per instance).
const searchLog = new Map();
function searchAllowed(sid) {
  const t = Date.now();
  const recent = (searchLog.get(sid) ?? []).filter((x) => x > t - 3600_000);
  if (recent.length >= config.web.searchPerHour) return false;
  recent.push(t);
  searchLog.set(sid, recent);
  if (searchLog.size > 5000) searchLog.clear();
  return true;
}

/**
 * Execute a tool. Returns { result, step } where `result` is the JSON handed back to the model/MCP client
 * and `step` is a short human-readable trace line for the UI's "agent activity" view.
 */
export async function runTool(sid, name, input = {}) {
  try {
    if (name === 'search_products') {
      const q = String(input?.query ?? '').slice(0, 120);
      if (!searchAllowed(sid)) return { result: { error: 'Search limit reached for this hour.' }, step: { tool: name, ok: false, text: 'Search limit reached for this hour' } };
      const max = Number.isFinite(input?.max_price_usd) && input.max_price_usd > 0 ? input.max_price_usd : undefined;
      try {
        const { offers, dropped } = await searchWeb({ query: q, max_price_usd: max, category: input?.category });
        const m = await getMandate(sid);
        const views = offers.map((o) => offerView(o, m)).sort((a, b) => Number(b.fits_mandate) - Number(a.fits_mandate) || a.price_usd - b.price_usd);
        return {
          result: { offers: views, ...(dropped.length ? { skipped: `${dropped.length} result(s) skipped because their price could not be verified` } : {}) },
          step: { tool: name, ok: true, text: `Searched the web for "${q.slice(0, 60)}"${max ? ` (up to ${money(Math.round(max * 100))})` : ''}: ${offers.length} verified offer${offers.length === 1 ? '' : 's'} (${views.filter((v) => v.fits_mandate).length} fit the mandate)${dropped.length ? `, ${dropped.length} skipped` : ''}` },
        };
      } catch (e) {
        if (!(e instanceof SearchUnavailable)) throw e;
        console.warn(`[search] ${e.detail}`);
        return { result: { error: e.message }, step: { tool: name, ok: false, text: `Web search failed: ${e.message}` } };
      }
    }
    if (name === 'propose_purchase') {
      const res = await proposePurchase(sid, { product_id: input?.offer_id, qty: input?.qty ?? 1, rationale: input?.rationale });
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
    if (name === 'suggest_mandate_change') {
      const p = await createProposal(sid, input);
      return {
        result: { status: 'suggested', summary: p.summary, note: 'Nothing changed. The human must review and apply this suggestion; you cannot change the mandate.' },
        step: { tool: name, ok: true, text: `Suggested a change to the limits (you decide): ${p.summary.join('; ')}` },
      };
    }
    if (name === 'get_mandate') {
      const m = await getMandate(sid);
      return {
        result: {
          budget_usd: m.budget_cents / 100, per_purchase_cap_usd: m.per_item_cap_cents / 100, allowed_categories: m.categories,
          remaining_usd: m.remaining_cents / 100, max_requests_per_hour: m.max_per_hour, expired: m.expired,
          max_per_day_usd: m.max_per_day_cents === null ? null : m.max_per_day_cents / 100, spent_last_24h_usd: m.spent_today_cents / 100,
          blocked_sellers: m.blocked_sellers, allowed_sellers: m.allowed_sellers,
        },
        step: { tool: name, ok: true, text: `Checked the mandate: ${money(m.remaining_cents)} remaining` },
      };
    }
    return { result: { error: `Unknown tool ${name}` }, step: { tool: name, ok: false, text: `Unknown tool ${name}` } };
  } catch (e) {
    return { result: { error: e.message }, step: { tool: name, ok: false, text: `${name} failed: ${e.message}` } };
  }
}

/**
 * Run the tool calls of one model turn. Web searches are slow (a provider call plus up to 14 page fetches), so
 * several of them run concurrently; everything else (proposals, mandate reads) runs afterwards in the model's order,
 * so budget reservations stay deterministic. Results come back in the original call order.
 */
export async function runToolBatch(sid, calls) {
  const out = new Array(calls.length);
  await Promise.all(calls.map(async (c, i) => { if (c.name === 'search_products') out[i] = await runTool(sid, c.name, c.input); }));
  for (let i = 0; i < calls.length; i++) if (!out[i]) out[i] = await runTool(sid, calls[i].name, calls[i].input);
  return out;
}
