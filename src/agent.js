// The shopping agent. Two interchangeable brains share the same tools and the same policy gate:
//   1. Claude (Anthropic SDK tool-use loop) when ANTHROPIC_API_KEY is set
//   2. A deterministic offline agent, so the app is always demoable (no key, no network, no cost)
// Neither can move money: both only call proposePurchase(), which the policy engine gates and which
// ends in a PayPal order that a human must approve.
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import {
  searchProducts, proposePurchase, getMandate, addMessage, listMessages,
} from './purchases.js';
import { money } from './policy.js';

const MAX_TURNS = 8;
let client;
const anthropic = () => (client ??= new Anthropic({ apiKey: config.anthropic.apiKey }));

export const agentMode = () => (config.anthropic.apiKey ? 'claude' : 'offline');

const SYSTEM = `You are the shopping agent inside Mandate. A human has given you a spending MANDATE (budget, per-purchase cap, allowed categories) and you shop on their behalf.

How you work:
- Use search_catalog to find products, then propose_purchase to request each purchase you decide on.
- You cannot spend money. Every proposal is checked by a policy engine; allowed ones become a PayPal order that the human approves with one tap. Blocked ones come back with a reason.
- If a proposal is blocked, say so plainly, explain why in one sentence, and suggest an in-policy alternative if one exists. NEVER try to get around a block (for example by splitting one item into several purchases, or by changing quantities to dodge a cap).
- Only propose items the user actually asked for or clearly implied. Prefer good value within the user's stated price limits. Quantity defaults to 1.
- Always include a one-sentence rationale when proposing (why this item for this user).
- Keep replies short and friendly: a few lines, plain text, no markdown tables. State what you proposed, what was blocked, and what the human needs to approve next.`;

const TOOLS = [
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
    description: 'Request a purchase. It is checked against the mandate; if allowed, a PayPal order is created for the human to approve.',
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
    description: 'Get the mandate limits and the remaining budget.',
    input_schema: { type: 'object', properties: {} },
  },
];

const productView = (p) => ({ id: p.id, name: p.name, merchant: p.merchant, category: p.category, price_usd: p.price_cents / 100, description: p.description });

async function runTool(sid, name, input) {
  try {
    if (name === 'search_catalog') {
      const max = Number.isFinite(input?.max_price_usd) ? Math.round(input.max_price_usd * 100) : undefined;
      return { products: searchProducts({ query: String(input?.query ?? ''), max_price_cents: max, category: input?.category }).map(productView) };
    }
    if (name === 'propose_purchase') {
      const res = await proposePurchase(sid, { product_id: input?.product_id, qty: input?.qty ?? 1, rationale: input?.rationale });
      return res.allowed
        ? { status: 'awaiting_human_approval', product: res.purchase.product_name, amount_usd: res.purchase.amount }
        : { status: 'blocked', code: res.code, reason: res.reason, product: res.purchase.product_name };
    }
    if (name === 'get_mandate') {
      const m = getMandate(sid);
      return { budget_usd: m.budget_cents / 100, per_purchase_cap_usd: m.per_item_cap_cents / 100, allowed_categories: m.categories, remaining_usd: m.remaining_cents / 100 };
    }
    return { error: `Unknown tool ${name}` };
  } catch (e) {
    return { error: e.message };
  }
}

// ------------------------------------------------------------------ Claude brain
async function runClaude(sid, userText) {
  const history = listMessages(sid, 12).map((m) => ({ role: m.role, content: m.content }));
  const messages = [...history, { role: 'user', content: userText }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await anthropic().messages.create({
      model: config.anthropic.model,
      max_tokens: 16000,
      system: SYSTEM,
      tools: TOOLS,
      output_config: { effort: 'low' },
      messages,
    });
    if (response.stop_reason === 'refusal') return 'I cannot help with that request.';
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (response.stop_reason !== 'tool_use') return text || 'Done.';

    // Replay the assistant turn unchanged (keeps any thinking blocks valid), then answer every tool call together.
    messages.push({ role: 'assistant', content: response.content });
    const results = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const out = await runTool(sid, block.name, block.input);
      results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out), ...(out.error ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
  return 'I hit my step limit - check the approvals queue for what I have requested so far.';
}

// ------------------------------------------------------------------ Offline brain
const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5 };
const STOP = new Set(['i', 'need', 'want', 'get', 'buy', 'me', 'please', 'a', 'an', 'the', 'some', 'for', 'my', 'to', 'and', 'of', 'new', 'under', 'below', 'less', 'than', 'max', 'up', 'about', 'around', 'set', 'up', 'with', 'also', 'order', 'purchase', 'find', 'pick', 'grab', 'that', 'is', 'cheap', 'good', 'nice', 'one', 'two', 'three']);

export function parseRequest(text) {
  const parts = String(text)
    .replace(/\b(please|thanks|thank you)\b/gi, ' ')
    .split(/,|;|\band\b|&|\bplus\b|\bthen\b|\balso\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
  const wants = [];
  for (const part of parts) {
    const priceMatch = part.match(/(?:under|below|less than|max(?:imum)?|up to|<)\s*\$?\s*(\d+(?:\.\d+)?)/i);
    const maxPrice = priceMatch ? Math.round(Number(priceMatch[1]) * 100) : undefined;
    let qty = 1;
    const qMatch = part.match(/\b(\d+)\s*(?:x|pcs|pieces)?\b(?!\s*k\b)(?!\s*in)/i);
    const wMatch = part.toLowerCase().match(/\b(two|three|four|five)\b/);
    if (wMatch) qty = NUM_WORDS[wMatch[1]];
    else if (qMatch && !priceMatch && Number(qMatch[1]) <= 5) qty = Number(qMatch[1]);
    const cleaned = part.replace(/\$\s*\d+(?:\.\d+)?/g, ' ').replace(/[^a-z0-9+" -]/gi, ' ');
    const words = cleaned.toLowerCase().split(/\s+/).filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w) || /^4k$/.test(w));
    if (words.length) wants.push({ query: words.join(' '), maxPrice, qty });
  }
  return wants;
}

async function runOffline(sid, userText) {
  const wants = parseRequest(userText);
  if (!wants.length) {
    return 'Tell me what to get, e.g. "a desk lamp under $40 and a mechanical keyboard". I will check each item against your mandate and queue the allowed ones for PayPal approval.';
  }
  const lines = [];
  let proposed = 0;
  let blocked = 0;
  let failed = 0;
  for (const w of wants) {
    const found = searchProducts({ query: w.query, max_price_cents: w.maxPrice });
    if (!found.length) {
      const anyPrice = searchProducts({ query: w.query });
      lines.push(anyPrice.length
        ? `• ${w.query}: nothing under ${money(w.maxPrice)} (cheapest is ${anyPrice[0].name} at ${money(anyPrice[0].price_cents)}).`
        : `• ${w.query}: I could not find that in the catalog.`);
      continue;
    }
    const pick = found[0];
    const res = await proposePurchase(sid, { product_id: pick.id, qty: w.qty, rationale: `Matches "${w.query}"${w.maxPrice ? ` under ${money(w.maxPrice)}` : ''}; best fit in the catalog.` });
    if (res.allowed) {
      proposed++;
      lines.push(`• ${pick.name} x${w.qty} - ${money(res.purchase.amount_cents)} - ready for your PayPal approval.`);
    } else if (res.code === 'PAYPAL_ERROR') {
      failed++;
      lines.push(`• ${pick.name} - allowed by the mandate, but I could not create the PayPal order: ${res.reason}`);
    } else {
      blocked++;
      let line = `• ${pick.name} - blocked: ${res.reason}`;
      const m = getMandate(sid);
      const room = Math.min(m.per_item_cap_cents, m.remaining_cents);
      const head = w.query.split(' ').pop(); // head noun, e.g. "lamp" in "premium architect lamp"
      const alt = searchProducts({ query: head, max_price_cents: room })
        .find((p) => p.id !== pick.id && p.category === pick.category && m.categories.includes(p.category));
      if (alt) line += ` Closest in-policy option: ${alt.name} at ${money(alt.price_cents)} (a different product - say the word and I will request it).`;
      lines.push(line);
    }
  }
  const head = proposed
    ? `I queued ${proposed} purchase${proposed > 1 ? 's' : ''} for approval${blocked ? ` and the mandate blocked ${blocked}` : ''}:`
    : `Nothing could be queued${blocked ? ' - the mandate blocked it' : failed ? ' - PayPal order creation failed' : ''}:`;
  return `${head}\n${lines.join('\n')}${proposed ? '\n\nApprove each with the PayPal button on the right.' : ''}`;
}

// ------------------------------------------------------------------ Entry point
export async function chat(sid, userText) {
  const text = String(userText ?? '').trim().slice(0, 600);
  if (!text) return { reply: 'Say what you would like me to buy.', mode: agentMode() };
  let reply;
  let mode = agentMode();
  if (mode === 'claude') {
    try {
      reply = await runClaude(sid, text);
    } catch (e) {
      console.error('[agent] Claude call failed, using offline agent:', e?.status ?? '', e?.message);
      mode = 'offline';
      reply = `${await runOffline(sid, text)}\n\n(The AI model was unavailable, so the built-in agent handled this.)`;
    }
  } else {
    reply = await runOffline(sid, text);
  }
  addMessage(sid, 'user', text);
  addMessage(sid, 'assistant', reply);
  return { reply, mode };
}
