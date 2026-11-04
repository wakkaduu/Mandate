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
ok('config', Boolean(cfg.paypalMode), `paypal=${cfg.paypalMode} configured=${cfg.paypalConfigured} agent=${cfg.agentMode} webhooks=${cfg.webhooks}`);
if (cfg.paypalMode === 'sandbox') ok('PayPal sandbox credentials configured', cfg.paypalConfigured === true);

const chat = await call('POST', '/api/chat', { message: 'a desk lamp under $40 and a 4K monitor' });
ok('agent replies', chat.status === 200 && typeof chat.json?.reply === 'string', `mode=${chat.json?.mode} model=${chat.json?.model}`);
if (cfg.paypalMode === 'sandbox') ok('a real AI model answered (not the rule-based fallback)', chat.json?.mode && chat.json.mode !== 'offline', 'if this fails: missing/exhausted AI key or quota');

const state = (await call('GET', '/api/state')).json ?? { purchases: [] };
const lamp = state.purchases.find((p) => p.product_id === 'lamp-aurora');
const monitor = state.purchases.find((p) => p.product_id === 'mon-4k');
ok('policy blocks the 4K monitor before PayPal', monitor?.status === 'blocked' && !monitor?.paypal_order_id);
ok('lamp became a PayPal order', lamp?.status === 'pending' && Boolean(lamp?.paypal_order_id), lamp?.paypal_order_id);

if (lamp) {
  const early = await call('POST', `/api/purchases/${lamp.id}/capture`);
  ok('capture before approval is refused (409)', early.status === 409, early.json?.error?.code);
  const cancel = await call('POST', `/api/purchases/${lamp.id}/cancel`);
  ok('cancel releases the budget', cancel.json?.purchase?.status === 'cancelled');
}

const hook = await call('POST', '/api/paypal/webhook', { id: 'WH-SMOKE', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} }, { 'paypal-transmission-id': 'x' });
ok('webhook rejects unsigned requests', [401, 503].includes(hook.status), `status ${hook.status} (503 = PAYPAL_WEBHOOK_ID not set)`);

const mcp = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
ok('MCP requires a bearer token', mcp.status === 401);

await call('POST', '/api/reset');
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
