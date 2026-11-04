import os from 'node:os';
import path from 'node:path';
// Gemini tool loop against a local stub of generateContent: request shape, tool execution through the policy gate,
// echoing the model turn unchanged (thought signatures), functionResponse ids, and model fallback on 503.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const seen = [];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    const model = decodeURIComponent(/models\/([^:]+):/.exec(req.url)[1]);
    seen.push({ model, json, key: req.headers['x-goog-api-key'] });
    if (model === 'busy-model') { res.writeHead(503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { code: 503, message: 'high demand', status: 'UNAVAILABLE' } })); }
    const last = json.contents.at(-1);
    const reply = (parts) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] })); };
    if (last.parts[0].functionResponse) {
      const statuses = last.parts.map((p) => p.functionResponse.response.status ?? 'search');
      return reply([{ text: `Done: ${statuses.join(', ')}` }]);
    }
    return reply([
      { functionCall: { name: 'search_catalog', args: { query: 'lamp', max_price_usd: 40 }, id: 'c1' }, thoughtSignature: 'SIG123' },
      { functionCall: { name: 'propose_purchase', args: { product_id: 'lamp-aurora', rationale: 'Cheapest lamp.' }, id: 'c2' } },
      { functionCall: { name: 'propose_purchase', args: { product_id: 'mon-4k', rationale: 'Asked for 4K.' }, id: 'c3' } },
    ]);
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));

process.env.LOG_REQUESTS = '0';
process.env.PAYPAL_MODE = 'mock';
process.env.DATABASE_PATH = path.join(os.tmpdir(), `mandate-test-${process.pid}-${Date.now()}.db`);
delete process.env.ANTHROPIC_API_KEY;
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GEMINI_MODEL = 'busy-model,good-model';
process.env.GEMINI_BASE_URL = `http://127.0.0.1:${stub.address().port}`;

const { start } = await import('../src/server.js');
const server = await start(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); stub.close(); });

test('Gemini loop: falls back past an overloaded model, runs tools through the policy gate, echoes turns unchanged', async () => {
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.agentMode, 'gemini');
  const cookie = (await fetch(`${base}/api/state`)).headers.get('set-cookie').split(';')[0];
  const r = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ message: 'a lamp and a 4K monitor' }) }).then((x) => x.json());
  assert.equal(r.mode, 'gemini');
  assert.equal(r.model, 'good-model');
  assert.match(r.reply, /awaiting_human_approval, blocked/);
  assert.equal(r.steps.length, 3);

  const state = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json();
  assert.equal(state.purchases.find((p) => p.product_id === 'lamp-aurora').status, 'pending');
  assert.equal(state.purchases.find((p) => p.product_id === 'mon-4k').status, 'blocked');

  assert.equal(seen[0].model, 'busy-model');            // tried first, 503 (retried once), then fell back
  const good = seen.filter((s) => s.model === 'good-model');
  assert.equal(good.length, 2);                          // one tool-call turn + one final turn
  assert.equal(good[0].key, 'test-gemini-key');
  assert.deepEqual(good[0].json.tools[0].functionDeclarations.map((d) => d.name), ['search_catalog', 'propose_purchase', 'get_mandate']);
  assert.equal(good[0].json.tools[0].functionDeclarations.find((d) => d.name === 'get_mandate').parameters, undefined);
  const second = good[1].json.contents;
  assert.equal(second.at(-2).role, 'model');
  assert.equal(second.at(-2).parts[0].thoughtSignature, 'SIG123');   // model turn echoed unchanged
  assert.deepEqual(second.at(-1).parts.map((p) => p.functionResponse.id), ['c1', 'c2', 'c3']);
});
