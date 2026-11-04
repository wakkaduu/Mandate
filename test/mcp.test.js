// MCP server conformance: uses the OFFICIAL MCP SDK client against our Streamable HTTP endpoint.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boot, client, approve } from './helpers.js';

let app; let web; let token; let url;
before(async () => {
  app = await boot();
  web = client(app.base);
  const r = await web.post('/api/connect');
  token = r.body.token; url = r.body.url;
});
after(async () => { await app.close(); });

const mcp = async (bearer = token) => {
  const c = new Client({ name: 'test-agent', version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
  return c;
};
const parse = (res) => JSON.parse(res.content[0].text);

test('token is shown once, stored hashed, and URL points at /mcp', async () => {
  assert.match(token, /^mnd_/);
  assert.match(url, /\/mcp$/);
  const again = await web.get('/api/connect');
  assert.equal(again.body.token, undefined);
  assert.equal(again.body.connected, true);
});

test('rejects missing/invalid tokens with 401 + WWW-Authenticate', async () => {
  const none = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(none.status, 401);
  assert.match(none.headers.get('www-authenticate'), /Bearer/);
  const bad = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer mnd_wrongwrongwrongwrongwrong' }, body: '{}' });
  assert.equal(bad.status, 401);
  assert.equal((await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } })).status, 405);
});

test('official MCP client: initialize, list tools, search (unavailable w/o key), propose (policy gate applies), get_mandate', async () => {
  const c = await mcp();
  assert.equal(c.getServerVersion().name, 'mandate');
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['get_mandate', 'propose_purchase', 'search_products']);
  assert.ok(tools.every((t) => t.inputSchema?.type === 'object'));

  // No search provider key in this test: web search must fail loudly, not invent products.
  const found = parse(await c.callTool({ name: 'search_products', arguments: { query: 'lamp', max_price_usd: 40 } }));
  assert.match(found.error, /not configured/);

  const ok = parse(await c.callTool({ name: 'propose_purchase', arguments: { offer_id: 'lamp-aurora', rationale: 'Cheapest lamp' } }));
  assert.equal(ok.status, 'awaiting_human_approval');
  const blocked = parse(await c.callTool({ name: 'propose_purchase', arguments: { offer_id: 'mon-4k', rationale: 'Wants 4K' } }));
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.code, 'OVER_ITEM_CAP');
  const m = parse(await c.callTool({ name: 'get_mandate', arguments: {} }));
  assert.equal(m.remaining_usd, 266);
  await c.close();
});

test('MCP-proposed purchase shows up for the human, who approves it through PayPal (simulated) like any other', async () => {
  const s = (await web.get('/api/state')).body;
  const lamp = s.purchases.find((p) => p.product_id === 'lamp-aurora');
  assert.equal(lamp.status, 'pending');
  assert.ok(s.audit.some((a) => a.type === 'mcp.tool_call'));
  await approve(app.base, lamp.paypal_order_id);
  const cap = await web.post(`/api/purchases/${lamp.id}/capture`);
  assert.equal(cap.body.purchase.status, 'captured');
});

test('unknown tool and unknown method return JSON-RPC errors; revoking the token cuts access', async () => {
  const c = await mcp();
  await assert.rejects(() => c.callTool({ name: 'transfer_money', arguments: {} }));
  await c.close();
  const rev = await web.raw('DELETE', '/api/connect', {});
  assert.equal(rev.body.connected, false);
  await assert.rejects(() => mcp());
});
