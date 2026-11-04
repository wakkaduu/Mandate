import os from 'node:os';
import path from 'node:path';
// The whole live-web shopping loop against local stubs: Gemini function calling (+ model fallback on 503), the
// grounded Google Search call, and a stub retailer. Checks that the price the human pays is the one the SERVER read
// from the page (not what the model quoted), that blocked proposals never reach PayPal, and that turns are echoed unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const seen = [];
let lastOffers;
let origin;
const product = (name, price) => `<html><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name, offers: { '@type': 'Offer', price, priceCurrency: 'USD' } })}</script></html>`;
const pages = { '/lamp': product('Halo LED Desk Lamp', '34.00'), '/monitor': product('Acme 27" 4K Monitor', '429.00') };

const stub = http.createServer((req, res) => {
  if (req.method === 'GET') {
    const html = pages[req.url];
    res.writeHead(html ? 200 : 404, { 'content-type': 'text/html' });
    return res.end(html ?? 'nope');
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    const model = decodeURIComponent(/models\/([^:]+):/.exec(req.url)[1]);
    seen.push({ model, json, key: req.headers['x-goog-api-key'] });
    const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (model === 'busy-model') return send(503, { error: { code: 503, message: 'high demand', status: 'UNAVAILABLE' } });
    const reply = (parts) => send(200, { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] });

    if (json.tools?.[0]?.google_search) {         // the grounded web search the search_products tool performs
      return reply([{ text: JSON.stringify([
        { title: 'Lamp', merchant: 'Lumen', url: `${origin}/lamp`, price_usd: 9.99, category: 'office' },        // model under-quotes
        { title: 'Monitor', merchant: 'Pixel', url: `${origin}/monitor`, price_usd: 99, category: 'electronics' },
        { title: 'Ghost', merchant: 'Nowhere', url: `${origin}/missing`, price_usd: 5, category: 'home' },        // dead link
      ]) }]);
    }
    const last = json.contents.at(-1);
    const fr = last.parts[0].functionResponse;
    if (!fr) {
      return reply([
        { functionCall: { name: 'search_products', args: { query: 'lamp and 4k monitor' }, id: 'c1' }, thoughtSignature: 'SIG123' },
      ]);
    }
    if (fr.name === 'search_products') {
      const offers = fr.response.offers;
      lastOffers = offers;
      const lamp = offers.find((o) => /Lamp/.test(o.title));
      const mon = offers.find((o) => /Monitor/.test(o.title));
      return reply([
        { functionCall: { name: 'propose_purchase', args: { offer_id: lamp.offer_id, rationale: 'Cheap lamp.' }, id: 'c2' } },
        { functionCall: { name: 'propose_purchase', args: { offer_id: mon.offer_id, rationale: 'Asked for 4K.' }, id: 'c3' } },
        { functionCall: { name: 'propose_purchase', args: { offer_id: 'o_invented0000000000', rationale: 'Made up.' }, id: 'c4' } },
      ]);
    }
    return reply([{ text: `Done: ${last.parts.map((p) => p.functionResponse.response.status ?? p.functionResponse.response.code).join(', ')}` }]);
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
origin = `http://127.0.0.1:${stub.address().port}`;

process.env.LOG_REQUESTS = '0';
process.env.PAYPAL_MODE = 'mock';
process.env.DATABASE_PATH = path.join(os.tmpdir(), `mandate-test-${process.pid}-${Date.now()}.db`);
process.env.WEB_ALLOW_PRIVATE_HOSTS = '1';
delete process.env.ANTHROPIC_API_KEY;
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GEMINI_MODEL = 'busy-model,good-model';
process.env.GEMINI_BASE_URL = origin;

const { start } = await import('../src/server.js');
const server = await start(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); stub.close(); });

test('live-web loop: search -> server-verified offers -> propose through the policy gate (model fallback, unchanged turns)', async () => {
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.agentMode, 'gemini');
  assert.equal(cfg.webSearch, true);
  const cookie = (await fetch(`${base}/api/state`)).headers.get('set-cookie').split(';')[0];
  const r = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ message: 'a lamp and a 4K monitor' }) }).then((x) => x.json());
  assert.equal(r.mode, 'gemini');
  assert.equal(r.model, 'good-model');
  assert.match(r.reply, /awaiting_human_approval, blocked, blocked/);
  assert.equal(r.steps.length, 4);
  // the model is told, before proposing, which offers the mandate would accept
  assert.equal(lastOffers.find((o) => /Lamp/.test(o.title)).fits_mandate, true);
  assert.equal(lastOffers.find((o) => /Lamp/.test(o.title)).category, 'office');
  const monOffer = lastOffers.find((o) => /Monitor/.test(o.title));
  assert.equal(monOffer.fits_mandate, false);
  assert.match(monOffer.mandate_issue, /OVER_ITEM_CAP/);
  assert.equal(lastOffers[0].fits_mandate, true, 'in-policy offers are listed first');
  assert.match(r.steps[0].text, /Searched the web for "lamp and 4k monitor": 2 verified offers \(1 fit the mandate\), 1 skipped/);

  const state = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json();
  const lamp = state.purchases.find((p) => p.product_name === 'Halo LED Desk Lamp');
  assert.equal(lamp.status, 'pending');
  assert.equal(lamp.amount_cents, 3400, 'the page price, not the $9.99 the model quoted');
  assert.equal(lamp.price_verified, 1);
  assert.equal(lamp.product_url, `${origin}/lamp`);
  const mon = state.purchases.find((p) => p.product_name === 'Acme 27" 4K Monitor');
  assert.equal(mon.status, 'blocked');
  assert.match(mon.reason, /OVER_ITEM_CAP/);
  assert.equal(mon.paypal_order_id, null, 'blocked purchases never reach PayPal');
  assert.ok(state.purchases.some((p) => p.status === 'blocked' && /UNKNOWN_PRODUCT/.test(p.reason)));
  assert.equal(state.messages.filter((m) => m.role === 'assistant').at(-1).trace.length, 4, 'agent activity trace is persisted');

  const agentCalls = seen.filter((s) => !s.json.tools?.[0]?.google_search);
  assert.equal(seen[0].model, 'busy-model');                       // tried first, 503, then fell back
  assert.deepEqual(agentCalls.filter((s) => s.model === 'good-model')[0].json.tools[0].functionDeclarations.map((d) => d.name), ['search_products', 'propose_purchase', 'get_mandate']);
  const searchCalls = seen.filter((s) => s.json.tools?.[0]?.google_search);
  assert.equal(searchCalls.at(-1).model, 'good-model');            // grounded search has its own cooldown scope: it retried busy-model, then fell back
  const third = agentCalls.filter((s) => s.model === 'good-model')[1].json.contents;
  assert.equal(third.at(-2).role, 'model');
  assert.equal(third.at(-2).parts[0].thoughtSignature, 'SIG123');  // model turn echoed unchanged
  assert.deepEqual(third.at(-1).parts.map((p) => p.functionResponse.id), ['c1']);
  assert.ok(!JSON.stringify(agentCalls[0].json).includes('lamp-aurora'), 'no hard-coded catalog in the prompt');
});

test('when the AI is unavailable the app says so and does not pretend to shop', async () => {
  const { config } = await import('../src/config.js');
  const saved = config.gemini.baseUrl;
  config.gemini.baseUrl = 'http://127.0.0.1:1';                    // connection refused
  try {
    const cookie = (await fetch(`${base}/api/state`)).headers.get('set-cookie').split(';')[0];
    const r = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ message: 'an airplane' }) }).then((x) => x.json());
    assert.equal(r.mode, 'offline');
    assert.match(r.reply, /unavailable/);
    assert.match(r.reply, /Nothing was bought/);
    const state = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json();
    assert.equal(state.purchases.length, 0);
  } finally { config.gemini.baseUrl = saved; }
});
