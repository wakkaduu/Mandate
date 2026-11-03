// The shopping agent. Two interchangeable brains share the same tools (src/tools.js) and the same policy gate:
//   1. Claude (Anthropic SDK tool-use loop) when ANTHROPIC_API_KEY is set
//   2. A deterministic offline agent, so the app is always demoable (no key, no network, no cost)
// Neither can move money: both only call propose_purchase, which the policy engine gates and which
// ends in a PayPal order that a human must approve.
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { searchProducts, getMandate, addMessage, listMessages } from './purchases.js';
import { money } from './policy.js';
import { TOOLS, runTool } from './tools.js';

const MAX_TURNS = 8;
let client;
const anthropic = () => (client ??= new Anthropic({ apiKey: config.anthropic.apiKey }));

export const agentMode = () => (config.anthropic.apiKey ? 'claude' : 'offline');

const SYSTEM = `You are the shopping agent inside Mandate. A human has given you a spending MANDATE (budget, per-purchase cap, allowed categories, pace limit, optional expiry) and you shop on their behalf.

How you work:
- Use search_catalog to find products, then propose_purchase to request each purchase you decide on.
- You cannot spend money. Every proposal is checked by a policy engine; allowed ones become a PayPal order that the human approves with one tap. Blocked ones come back with a reason.
- If a proposal is blocked, say so plainly, explain why in one sentence, and suggest an in-policy alternative if one exists. NEVER try to get around a block (for example by splitting one item into several purchases, or by changing quantities to dodge a cap).
- Only propose items the user actually asked for or clearly implied. Prefer good value within the user's stated price limits. Quantity defaults to 1.
- Always include a one-sentence rationale when proposing (why this item for this user).
- Keep replies short and friendly: a few lines, plain text, no markdown tables. State what you proposed, what was blocked, and what the human needs to approve next.`;

// ------------------------------------------------------------------ Claude brain
async function runClaude(sid, userText, steps) {
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
      const { result, step } = await runTool(sid, block.name, block.input);
      steps.push(step);
      results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result), ...(result.error ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
  return 'I hit my step limit - check the approvals queue for what I have requested so far.';
}

// ------------------------------------------------------------------ Offline brain
const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5 };
const STOP = new Set(['i', 'need', 'want', 'get', 'buy', 'me', 'please', 'a', 'an', 'the', 'some', 'for', 'my', 'to', 'and', 'of', 'new', 'under', 'below', 'less', 'than', 'max', 'up', 'about', 'around', 'set', 'with', 'also', 'order', 'purchase', 'find', 'pick', 'grab', 'that', 'is', 'cheap', 'good', 'nice', 'one', 'two', 'three']);

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

async function runOffline(sid, userText, steps) {
  const wants = parseRequest(userText);
  if (!wants.length) {
    return 'Tell me what to get, e.g. "a desk lamp under $40 and a mechanical keyboard". I will check each item against your mandate and queue the allowed ones for PayPal approval.';
  }
  const call = async (name, input) => { const r = await runTool(sid, name, input); steps.push(r.step); return r; };
  const lines = [];
  let proposed = 0;
  let blocked = 0;
  let failed = 0;
  for (const w of wants) {
    const found = (await call('search_catalog', { query: w.query, max_price_usd: w.maxPrice ? w.maxPrice / 100 : undefined })).result.products;
    if (!found.length) {
      const any = (await call('search_catalog', { query: w.query })).result.products;
      lines.push(any.length
        ? `• ${w.query}: nothing under ${money(w.maxPrice)} (cheapest is ${any[0].name} at ${money(Math.round(any[0].price_usd * 100))}).`
        : `• ${w.query}: I could not find that in the catalog.`);
      continue;
    }
    const pick = found[0];
    const r = await call('propose_purchase', { product_id: pick.id, qty: w.qty, rationale: `Matches "${w.query}"${w.maxPrice ? ` under ${money(w.maxPrice)}` : ''}; best fit in the catalog.` });
    if (r.result.status === 'awaiting_human_approval') {
      proposed++;
      lines.push(`• ${pick.name} x${w.qty} - ${money(r.purchase.amount_cents)} - ready for your PayPal approval.`);
    } else if (r.blocked?.code === 'PAYPAL_ERROR') {
      failed++;
      lines.push(`• ${pick.name} - allowed by the mandate, but I could not create the PayPal order: ${r.blocked.reason}`);
    } else {
      blocked++;
      let line = `• ${pick.name} - blocked: ${r.blocked?.reason ?? r.result.error}`;
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
  if (!text) return { reply: 'Say what you would like me to buy.', mode: agentMode(), steps: [] };
  const steps = [];
  let reply;
  let mode = agentMode();
  if (mode === 'claude') {
    try {
      reply = await runClaude(sid, text, steps);
    } catch (e) {
      console.error('[agent] Claude call failed, using offline agent:', e?.status ?? '', e?.message);
      mode = 'offline';
      reply = `${await runOffline(sid, text, steps)}\n\n(The AI model was unavailable, so the built-in agent handled this.)`;
    }
  } else {
    reply = await runOffline(sid, text, steps);
  }
  addMessage(sid, 'user', text);
  addMessage(sid, 'assistant', reply, steps);
  return { reply, mode, steps };
}
