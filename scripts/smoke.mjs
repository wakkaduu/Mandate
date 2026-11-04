#!/usr/bin/env node
// Post-deploy smoke test: node scripts/smoke.mjs https://<your-service>.onrender.com
// Exercises health, config, the agent, order creation (a REAL PayPal sandbox order when the server runs in
// sandbox mode), cancel/release, webhook hardening and MCP auth. Creates no charges; cancels what it creates.
const base = (process.argv[2] || process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
let cookie = '';
let failures = 0;
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failures++; };

async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { cookie } : {}), ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(90_000), // free instances can take ~30-60s to wake up
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  let json = null; try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
}

console.log(`Smoke testing ${base} (first request may take up to a minute if the instance is asleep)\n`);
const health = await call('GET', '/healthz');
ok('healthz', health.status === 200 && health.json?.ok);

const cfg = (await call('GET', '/api/config')).json ?? {};
ok('web search provider configured', cfg.webSearch === true, (cfg.searchProviders ?? []).join(',') || 'none: set TAVILY_API_KEY / SERPER_API_KEY / GEMINI_API_KEY');
ok('config', Boolean(cfg.paypalMode), `paypal=${cfg.paypalMode} configured=${cfg.paypalConfigured} agent=${cfg.agentMode} webhooks=${cfg.webhooks}`);
if (cfg.paypalMode === 'sandbox') ok('PayPal sandbox credentials configured', cfg.paypalConfigured === true);

const chat = await call('POST', '/api/chat', { message: 'an LED desk lamp under $60' });
ok('agent replies', chat.status === 200 && typeof chat.json?.reply === 'string', `mode=${chat.json?.mode} model=${chat.json?.model}`);
if (cfg.paypalMode === 'sandbox') ok('a real AI model answered (not the "AI unavailable" reply)', chat.json?.mode && chat.json.mode !== 'offline', 'if this fails: missing/exhausted AI key or quota');
const search = (chat.json?.steps ?? []).find((x) => x.tool === 'search_products');
ok('the agent searched the live web', Boolean(search?.ok), search?.text);

const state = (await call('GET', '/api/state')).json ?? { purchases: [] };
const item = state.purchases.find((p) => p.status === 'pending');
// Live results vary, so we only assert on what must hold for whatever the web returned.
ok('every purchase has a retailer URL and a server-read price', state.purchases.every((p) => /^https?:\/\//.test(p.product_url ?? '') && p.price_verified === 1), `${state.purchases.length} purchase(s)`);
ok('a proposed item became a PayPal order (or was blocked by policy before PayPal)', state.purchases.length > 0 && state.purchases.every((p) => (p.status === 'pending' && p.paypal_order_id) || (p.status === 'blocked' && !p.paypal_order_id)), state.purchases.map((p) => p.status).join(','));

if (item) {
  const early = await call('POST', `/api/purchases/${item.id}/capture`);
  ok('capture before approval is refused (409)', early.status === 409, early.json?.error?.code);
  const cancel = await call('POST', `/api/purchases/${item.id}/cancel`);
  ok('cancel releases the budget', cancel.json?.purchase?.status === 'cancelled');
}

const hook = await call('POST', '/api/paypal/webhook', { id: 'WH-SMOKE', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} }, { 'paypal-transmission-id': 'x' });
ok('webhook rejects unsigned requests', [401, 503].includes(hook.status), `status ${hook.status} (503 = PAYPAL_WEBHOOK_ID not set)`);

const mcp = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
ok('MCP requires a bearer token', mcp.status === 401);

await call('POST', '/api/reset');
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
