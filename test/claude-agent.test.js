// Verifies the Claude tool-use loop end to end against a local stub of the Messages API
// (no network, no key needed). It checks request shape, tool execution through the policy gate,
// and graceful fallback to the offline agent when the model API errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const requests = [];
let mode = 'tools';
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    requests.push(json);
    if (mode === 'error') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'boom' } })); }
    const last = json.messages[json.messages.length - 1];
    const reply = (content, stop_reason) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: json.model, content, stop_reason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
    };
    if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
      const outs = last.content.map((c) => JSON.parse(c.content));
      return reply([{ type: 'text', text: `Results: ${outs.map((o) => o.status ?? (o.products ? `found ${o.products.length}` : 'ok')).join(', ')}` }], 'end_turn');
    }
    return reply([
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 'tu_1', name: 'search_catalog', input: { query: 'lamp', max_price_usd: 40 } },
      { type: 'tool_use', id: 'tu_2', name: 'propose_purchase', input: { product_id: 'lamp-aurora', qty: 1, rationale: 'Cheapest lamp.' } },
      { type: 'tool_use', id: 'tu_3', name: 'propose_purchase', input: { product_id: 'mon-4k', qty: 1, rationale: 'Asked for 4K.' } },
    ], 'tool_use');
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));

process.env.LOG_REQUESTS = '0';
process.env.PAYPAL_MODE = 'mock';
process.env.DATABASE_PATH = ':memory:';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${stub.address().port}`;

const { start } = await import('../src/server.js');
const server = await start(0);
const base = `http://127.0.0.1:${server.address().port}`;

async function session() {
  const r = await fetch(`${base}/api/state`);
  return r.headers.get('set-cookie').split(';')[0];
}
const post = (cookie, path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const get = (cookie, path) => fetch(base + path, { headers: { cookie } }).then((r) => r.json());

test.after(() => { server.close(); stub.close(); });

test('Claude tool loop: proposals go through the policy gate; blocked ones never reach PayPal', async () => {
  mode = 'tools';
  const cookie = await session();
  const r = await post(cookie, '/api/chat', { message: 'a lamp and a 4K monitor' });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'claude');
  assert.match(r.body.reply, /awaiting_human_approval, blocked/);

  const s = await get(cookie, '/api/state');
  assert.equal(s.purchases.find((p) => p.product_id === 'lamp-aurora').status, 'pending');
  const mon = s.purchases.find((p) => p.product_id === 'mon-4k');
  assert.equal(mon.status, 'blocked');
  assert.equal(mon.paypal_order_id, null);

  // request shape: tools declared, system prompt present, every tool_use answered in ONE user message
  const first = requests[0];
  assert.deepEqual(first.tools.map((t) => t.name), ['search_catalog', 'propose_purchase', 'get_mandate']);
  assert.ok(first.system.includes('MANDATE'));
  const second = requests[1];
  const results = second.messages[second.messages.length - 1].content;
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((x) => x.tool_use_id), ['tu_1', 'tu_2', 'tu_3']);
});

test('model API failure falls back to the offline agent instead of erroring', async () => {
  mode = 'error';
  const cookie = await session();
  const r = await post(cookie, '/api/chat', { message: 'a pothos plant' });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'offline');
  assert.match(r.body.reply, /built-in agent handled this/);
  const s = await get(cookie, '/api/state');
  assert.equal(s.purchases[0].status, 'pending');
});
