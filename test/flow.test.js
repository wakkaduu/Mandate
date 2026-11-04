import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, client, approve, buy } from './helpers.js';

let app;
before(async () => { app = await boot(); });
after(async () => { await app.close(); });

const state = async (c) => (await c.get('/api/state')).body;
const byProduct = (s, id) => s.purchases.find((p) => p.product_id === id);

test('agent request -> policy gate -> PayPal order -> approve -> capture -> budget updates', async () => {
  const c = client(app.base);
  await buy(c, 'lamp-aurora', 'kb-tactile', 'mon-4k');

  let s = await state(c);
  const lamp = byProduct(s, 'lamp-aurora');
  const kb = byProduct(s, 'kb-tactile');
  const mon = byProduct(s, 'mon-4k');
  assert.equal(lamp.status, 'pending');
  assert.equal(kb.status, 'pending');
  assert.ok(lamp.paypal_order_id?.startsWith('MOCKORDER'));
  assert.equal(mon.status, 'blocked');
  assert.match(mon.reason, /OVER_ITEM_CAP/);
  assert.equal(mon.paypal_order_id, null, 'blocked purchases never reach PayPal');
  // 34.00 + 89.00 reserved
  assert.equal(s.mandate.committed_cents, 12300);
  assert.equal(s.mandate.remaining_cents, 30000 - 12300);
  assert.equal(s.mandate.captured_cents, 0);

  // capture before approval is refused and leaves it pending
  const early = await c.post(`/api/purchases/${lamp.id}/capture`);
  assert.equal(early.status, 409);
  assert.equal((await state(c)).purchases.find((p) => p.id === lamp.id).status, 'pending');

  await approve(app.base, lamp.paypal_order_id);
  const cap = await c.post(`/api/purchases/${lamp.id}/capture`);
  assert.equal(cap.status, 200);
  assert.equal(cap.body.purchase.status, 'captured');
  assert.ok(cap.body.purchase.paypal_capture_id);

  // double-click / retry is idempotent
  const again = await c.post(`/api/purchases/${lamp.id}/capture`);
  assert.equal(again.status, 200);
  assert.equal(again.body.outcome, 'already_captured');

  s = await state(c);
  assert.equal(s.mandate.captured_cents, 3400);
  const types = s.audit.map((a) => a.type);
  for (const t of ['policy.approved', 'policy.blocked', 'paypal.order_created', 'paypal.captured']) assert.ok(types.includes(t), t);
});

test('declined instrument releases budget and can be re-requested', async () => {
  const c = client(app.base);
  await buy(c, 'mouse-ergo');
  let s = await state(c);
  const p = byProduct(s, 'mouse-ergo');
  assert.equal(p.status, 'pending');
  await approve(app.base, p.paypal_order_id, 'decline');
  const cap = await c.post(`/api/purchases/${p.id}/capture`);
  assert.equal(cap.body.outcome, 'declined');
  s = await state(c);
  assert.equal(s.purchases.find((x) => x.id === p.id).status, 'declined');
  assert.equal(s.mandate.committed_cents, 0);

  const re = await c.post(`/api/purchases/${p.id}/rerequest`);
  assert.equal(re.body.allowed, true);
  assert.equal(re.body.purchase.status, 'pending');
  assert.notEqual(re.body.purchase.paypal_order_id, p.paypal_order_id);
});

test('cancelling releases budget; cancelled purchases cannot be captured', async () => {
  const c = client(app.base);
  await buy(c, 'mat-desk');
  let s = await state(c);
  const p = byProduct(s, 'mat-desk');
  assert.equal(s.mandate.committed_cents, 2400);
  const cancel = await c.post(`/api/purchases/${p.id}/cancel`);
  assert.equal(cancel.body.purchase.status, 'cancelled');
  assert.equal((await state(c)).mandate.committed_cents, 0);
  assert.equal((await c.post(`/api/purchases/${p.id}/capture`)).status, 409);
});

test('budget is enforced across purchases (reservations count) and duplicates are blocked', async () => {
  const c = client(app.base);
  await c.put('/api/mandate', { budget_cents: 10000, per_item_cap_cents: 9000, categories: ['electronics', 'office'] });
  await buy(c, 'kb-tactile');          // 89.00 reserved
  await buy(c, 'hub-usbc');            // 45.00 > 11.00 remaining
  await buy(c, 'kb-tactile');          // duplicate
  const s = await state(c);
  assert.equal(byProduct(s, 'kb-tactile').status === 'pending' || s.purchases.some((p) => p.product_id === 'kb-tactile' && p.status === 'pending'), true);
  assert.match(byProduct(s, 'hub-usbc').reason, /OVER_BUDGET/);
  assert.ok(s.purchases.some((p) => p.product_id === 'kb-tactile' && /DUPLICATE/.test(p.reason ?? '')));
  assert.equal(s.mandate.committed_cents, 8900);
});

test('category restrictions are enforced', async () => {
  const c = client(app.base);
  await buy(c, 'chair-ergo');
  const s = await state(c);
  const chair = byProduct(s, 'chair-ergo');
  assert.equal(chair.status, 'blocked');
  assert.match(chair.reason, /CATEGORY_NOT_ALLOWED|OVER_ITEM_CAP/);
});

test('refund releases budget', async () => {
  const c = client(app.base);
  await buy(c, 'plant-pothos');
  let s = await state(c);
  const p = byProduct(s, 'plant-pothos');
  await approve(app.base, p.paypal_order_id);
  await c.post(`/api/purchases/${p.id}/capture`);
  assert.equal((await state(c)).mandate.captured_cents, 1800);
  const refund = await c.post(`/api/purchases/${p.id}/refund`);
  assert.equal(refund.body.purchase.status, 'refunded');
  s = await state(c);
  assert.equal(s.mandate.committed_cents, 0);
  assert.equal((await c.post(`/api/purchases/${p.id}/refund`)).body.purchase.status, 'refunded'); // idempotent
});

test('sessions are isolated', async () => {
  const a = client(app.base);
  const b = client(app.base);
  await buy(a, 'plant-pothos');
  const sa = await state(a);
  const sb = await state(b);
  assert.equal(sa.purchases.length, 1);
  assert.equal(sb.purchases.length, 0);
  assert.equal((await b.post(`/api/purchases/${sa.purchases[0].id}/cancel`)).status, 404);
});

test('mandate update validation', async () => {
  const c = client(app.base);
  assert.equal((await c.put('/api/mandate', { budget_cents: -5 })).status, 400);
  assert.equal((await c.put('/api/mandate', { budget_cents: 5000, per_item_cap_cents: 9000 })).status, 400);
  assert.equal((await c.put('/api/mandate', { categories: ['weapons'] })).status, 400);
  assert.equal((await c.put('/api/mandate', { budget_cents: 20000 })).status, 200);
});

test('state-changing requests must be JSON (CSRF hardening)', async () => {
  const c = client(app.base);
  await c.get('/api/state');
  const res = await c.raw('POST', '/api/reset', undefined, { 'Content-Type': 'text/plain' });
  assert.equal(res.status, 415);
});

// ---------------------------------------------------------------- webhooks
const hookHeaders = (sig = 'valid-signature') => ({
  'content-type': 'application/json',
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
  'paypal-transmission-id': 'tid-1',
  'paypal-transmission-sig': sig,
  'paypal-transmission-time': new Date().toISOString(),
});
const sendHook = (event, sig) => fetch(`${app.base}/api/paypal/webhook`, { method: 'POST', headers: hookHeaders(sig), body: JSON.stringify(event) });

test('webhook: rejects bad signatures, applies verified events once, ignores duplicates', async () => {
  const c = client(app.base);
  await buy(c, 'plant-pothos');
  const p = byProduct(await state(c), 'plant-pothos');
  const event = {
    id: 'WH-EVT-1', event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: { id: 'CAPFROMHOOK1', status: 'COMPLETED', custom_id: p.id, amount: { currency_code: 'USD', value: '18.00' } },
  };
  assert.equal((await sendHook(event, 'forged')).status, 401);
  assert.equal((await state(c)).purchases[0].status, 'pending', 'forged event changes nothing');

  const ok = await sendHook(event);
  assert.equal(ok.status, 200);
  assert.equal((await state(c)).purchases[0].status, 'captured');

  const dup = await (await sendHook(event)).json();
  assert.equal(dup.duplicate, true);
  assert.equal((await state(c)).audit.filter((a) => a.type === 'webhook.captured').length, 1);
});

test('webhook: amount mismatch does not mark a purchase captured', async () => {
  const c = client(app.base);
  await buy(c, 'plant-pothos');
  const p = byProduct(await state(c), 'plant-pothos');
  const res = await sendHook({
    id: 'WH-EVT-2', event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: { id: 'CAPX', status: 'COMPLETED', custom_id: p.id, amount: { currency_code: 'USD', value: '0.01' } },
  });
  assert.equal(res.status, 200);
  assert.equal(byProduct(await state(c), 'plant-pothos').status, 'pending');
});

// ---------------------------------------------------------------- API contract
test('every error uses one envelope { error: { code, message, requestId } } and echoes X-Request-Id', async () => {
  const c = client(app.base);
  const bad = await c.post('/api/purchases/does-not-exist/capture');
  assert.equal(bad.status, 404);
  assert.equal(bad.body.error.code, 'NOT_FOUND');
  assert.equal(typeof bad.body.error.message, 'string');
  assert.ok(bad.body.error.requestId);
  const unknown = await c.get('/api/nope');
  assert.equal(unknown.body.error.code, 'NOT_FOUND');
  const invalid = await c.put('/api/mandate', { budget_cents: -1 });
  assert.equal(invalid.body.error.code, 'BAD_INPUT');
  const res = await fetch(`${app.base}/healthz`, { headers: { 'x-request-id': 'trace-abc-12345' } });
  assert.equal(res.headers.get('x-request-id'), 'trace-abc-12345');
  assert.deepEqual(await res.json(), { ok: true });
});

// ---------------------------------------------------------------- new mandate rules + agent trace
test('pace limit blocks a runaway agent; expiry blocks everything; both are editable', async () => {
  const c = client(app.base);
  assert.equal((await c.put('/api/mandate', { max_per_hour: 2 })).status, 200);
  await buy(c, 'mat-desk');
  await buy(c, 'plant-pothos');
  await buy(c, 'mouse-ergo');
  let s = await state(c);
  assert.equal(byProduct(s, 'mouse-ergo').status, 'blocked');
  assert.match(byProduct(s, 'mouse-ergo').reason, /OVER_PACE/);
  assert.equal(s.mandate.committed_cents, 2400 + 1800);

  assert.equal((await c.put('/api/mandate', { max_per_hour: null })).body.mandate.max_per_hour, null);
  assert.equal((await c.put('/api/mandate', { max_per_hour: 0 })).status, 400);
  assert.equal((await c.put('/api/mandate', { expires_at: Date.now() - 1000 })).status, 400);
  assert.equal((await c.put('/api/mandate', { expires_at: Date.now() + 86400_000 })).status, 200);
});

test('unknown, stale and over-quantity offers are refused by the policy gate, never sent to PayPal', async () => {
  const c = client(app.base);
  const [unknown, big] = await buy(c, 'o_doesnotexist', ['lamp-aurora', 99]);
  assert.equal(unknown.code, 'UNKNOWN_PRODUCT');
  assert.equal(big.code, 'BAD_QUANTITY');
  const { db } = await import('../src/db.js');
  await (await db()).run("UPDATE offers SET updated_at = ? WHERE id = 'mat-desk'", [Date.now() - 7 * 3600_000]);
  const [stale] = await buy(c, 'mat-desk');
  assert.equal(stale.code, 'STALE_PRICE');
  const s = await state(c);
  assert.ok(s.purchases.every((p) => p.status === 'blocked' && !p.paypal_order_id));
  await (await db()).run("UPDATE offers SET updated_at = ? WHERE id = 'mat-desk'", [Date.now()]);
});

test('purchases carry the retailer URL and the verified-price flag into the ledger', async () => {
  const c = client(app.base);
  await buy(c, 'lamp-aurora');
  const p = (await state(c)).purchases[0];
  assert.equal(p.product_url, 'https://shop.example/lamp-aurora');
  assert.equal(p.price_verified, 1);
});

// ---------------------------------------------------------------- manual search path
test('manual search + request: validated input, unavailable search is a clean 503, requests use the same policy gate', async () => {
  const c = client(app.base);
  assert.equal((await c.post('/api/search', { query: 'x' })).status, 400);
  assert.equal((await c.post('/api/search', { query: 'lamp', max_price_usd: -3 })).status, 400);
  const s = await c.post('/api/search', { query: 'lamp' });           // no search provider keys in tests
  assert.equal(s.status, 503);
  assert.equal(s.body.error.code, 'SEARCH_UNAVAILABLE');

  const ok = await c.post('/api/offers/lamp-aurora/request', { qty: 1 });
  assert.equal(ok.body.allowed, true);
  const blocked = await c.post('/api/offers/mon-4k/request', { qty: 1 });
  assert.equal(blocked.body.allowed, false);
  assert.equal(blocked.body.code, 'OVER_ITEM_CAP');
  assert.equal((await c.post('/api/offers/o_unknown/request', {})).body.code, 'UNKNOWN_PRODUCT');
  const st = await state(c);
  assert.match(st.purchases.find((p) => p.product_id === 'lamp-aurora').rationale, /Requested by you/);
});

// ---------------------------------------------------------------- Information page data
test('/api/config feeds the Information page and never exposes secrets', async () => {
  const cfg = (await client(app.base).get('/api/config')).body;
  for (const k of ['paypalMode', 'paypalConfigured', 'currency', 'agentMode', 'webSearch', 'searchProviders', 'models', 'strictPrices', 'searchCacheMinutes', 'searchesPerDay', 'persistent', 'host', 'version', 'mcpPath']) {
    assert.ok(k in cfg, `config.${k}`);
  }
  assert.equal(cfg.strictPrices, true);
  assert.match(cfg.version, /^\d+\.\d+\.\d+/);
  const text = JSON.stringify(cfg);
  assert.ok(!/secret|token|api[_-]?key|password/i.test(Object.keys(cfg).join(' ')), 'no secret-looking keys');
  assert.ok(!text.includes(process.env.PAYPAL_CLIENT_SECRET ?? '\u0000never'), 'secret value not present');
});
