// A new session has NO budget. The owner must choose every figure first; until then nothing can be searched, requested,
// suggested or bought, on any path (UI endpoints, the assistant, the external-agent tools).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, client } from './helpers.js';

let app;
before(async () => { app = await boot(); });
after(async () => { await app.close(); });

const raw = () => client(app.base, { setup: false });
const state = async (c) => (await c.get('/api/state')).body;
const TERMS = { name: 'Team lunch', budget_cents: 5000, per_item_cap_cents: 2000, categories: ['kitchen', 'home'] };

test('a new session has no amount at all: not configured, zero budget, nothing allowed', async () => {
  const c = raw();
  const s = await state(c);
  assert.equal(s.mandate.configured, false);
  for (const k of ['budget_cents', 'per_item_cap_cents', 'remaining_cents', 'committed_cents', 'captured_cents']) assert.equal(s.mandate[k], 0, k);
  assert.deepEqual(s.mandate.categories, []);
  assert.equal(s.mandate.name, '');
  assert.ok(s.audit.some((a) => a.type === 'session.started'));
});

test('before setup nothing can be searched, requested, chatted about, suggested or edited', async () => {
  const c = raw();
  await state(c);
  const refused = [
    await c.post('/api/chat', { message: 'a desk lamp' }),
    await c.post('/api/search', { query: 'desk lamp' }),
    await c.post('/api/offers/lamp-aurora/request', { qty: 1 }),
    await c.put('/api/mandate', { budget_cents: 5000 }),
  ];
  for (const r of refused) { assert.equal(r.status, 409); assert.equal(r.body.error.code, 'MANDATE_NOT_SET_UP'); }
  assert.match(refused[0].body.error.message, /not set a spending mandate/i);
  const s = await state(c);
  assert.equal(s.purchases.length, 0, 'no ledger row, no PayPal order');
  assert.equal(s.messages.length, 0, 'the assistant was never called');
});

test('the policy engine and the service refuse a mandate that was never set up (defence in depth)', async () => {
  const { evaluate } = await import('../src/policy.js');
  const lamp = { id: 'l', name: 'Lamp', category: 'office', price_cents: 100, url: 'https://shop.example/l' };
  assert.equal(evaluate({ configured: false, budget_cents: 9999999, per_item_cap_cents: 9999999, categories: ['office'] }, lamp, 1, { committed_cents: 0, open_same_product: false }).code, 'MANDATE_NOT_SET_UP');
  const c = raw();
  await state(c);
  const svc = await import('../src/purchases.js');
  await assert.rejects(() => svc.proposePurchase(c.sid(), { product_id: 'lamp-aurora', qty: 1 }), (e) => e.code === 'MANDATE_NOT_SET_UP');
  const { createProposal } = await import('../src/ledger-tools.js');
  await assert.rejects(() => createProposal(c.sid(), { budget_usd: 500, reason: 'more' }), (e) => e.code === 'MANDATE_NOT_SET_UP');
});

test('external-agent tools: get_mandate says "not set up", search and propose are refused', async () => {
  const c = raw();
  await state(c);
  const { runTool } = await import('../src/tools.js');
  const m = await runTool(c.sid(), 'get_mandate', {});
  assert.equal(m.result.set_up, false);
  const found = await runTool(c.sid(), 'search_products', { query: 'lamp' });
  assert.match(found.result.error, /not set a spending mandate/i);
  const bought = await runTool(c.sid(), 'propose_purchase', { offer_id: 'lamp-aurora', rationale: 'x' });
  assert.match(bought.result.error, /not set a spending mandate/i);
  assert.equal((await state(c)).purchases.length, 0);
});

test('setup validates: budget, cap and at least one category are required, and nothing is invented', async () => {
  const c = raw();
  await state(c);
  const bad = async (body, re) => { const r = await c.post('/api/mandate/setup', body); assert.equal(r.status, 400, JSON.stringify(body)); assert.match(r.body.error.message, re); };
  await bad({}, /Budget must be/);
  await bad({ per_item_cap_cents: 2000, categories: ['home'] }, /Budget must be/);
  await bad({ budget_cents: 5000, categories: ['home'] }, /Per-purchase cap/);
  await bad({ budget_cents: 5000, per_item_cap_cents: 6000, categories: ['home'] }, /no more than the budget/);
  await bad({ budget_cents: 5000, per_item_cap_cents: 2000 }, /at least one category/);
  await bad({ budget_cents: 5000, per_item_cap_cents: 2000, categories: [] }, /at least one category/);
  await bad({ budget_cents: 5000, per_item_cap_cents: 2000, categories: ['weapons'] }, /Categories must be/);
  await bad({ budget_cents: 5000.5, per_item_cap_cents: 2000, categories: ['home'] }, /Budget must be/);
  await bad({ budget_cents: 99999999, per_item_cap_cents: 2000, categories: ['home'] }, /Budget must be/);
  await bad({ ...TERMS, max_per_day_cents: 100 }, /daily limit/);
  await bad({ ...TERMS, allowed_sellers: ['not a domain'] }, /domain names/);
  assert.equal((await state(c)).mandate.configured, false, 'still not set up after every refusal');
});

test('setting up activates the mandate with exactly the owner\'s figures, audits it, and cannot be repeated', async () => {
  const c = raw();
  await state(c);
  const r = await c.post('/api/mandate/setup', { ...TERMS, max_per_day_cents: 4000, blocked_sellers: ['https://www.bad.example/x'] });
  assert.equal(r.status, 200);
  const m = r.body.mandate;
  assert.equal(m.configured, true);
  assert.equal(m.name, 'Team lunch');
  assert.equal(m.budget_cents, 5000);
  assert.equal(m.remaining_cents, 5000);
  assert.equal(m.per_item_cap_cents, 2000);
  assert.deepEqual(m.categories, ['kitchen', 'home']);
  assert.equal(m.max_per_hour, 6, 'pace falls back to the safe default when the owner does not choose one');
  assert.equal(m.max_per_day_cents, 4000);
  assert.deepEqual(m.blocked_sellers, ['bad.example']);
  const audit = (await state(c)).audit.find((a) => a.type === 'mandate.activated');
  assert.match(audit.detail, /Team lunch/);
  assert.match(audit.detail, /\$50\.00/);

  const again = await c.post('/api/mandate/setup', TERMS);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'ALREADY_SET_UP');
  assert.equal((await state(c)).mandate.budget_cents, 5000, 'the second attempt changed nothing');
});

test('optional fields: blank name gets a neutral title; pace null means unlimited; duplicates in categories collapse', async () => {
  const c = raw();
  await state(c);
  const r = await c.post('/api/mandate/setup', { name: '   ', budget_cents: 1000, per_item_cap_cents: 1000, categories: ['home', 'home'], max_per_hour: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.mandate.name, 'My mandate');
  assert.equal(r.body.mandate.max_per_hour, null);
  assert.deepEqual(r.body.mandate.categories, ['home']);
});

test('after setup the normal flow works, and the owner\'s own limits are what the policy enforces', async () => {
  const c = raw();
  await state(c);
  await c.post('/api/mandate/setup', { name: 'Small', budget_cents: 5000, per_item_cap_cents: 2500, categories: ['office'] });
  const ok = await c.post('/api/offers/lamp-aurora/request', { qty: 1 });        // $34.00 lamp: over the $25.00 cap the owner chose
  assert.equal(ok.status, 200);
  assert.equal(ok.body.allowed, false);
  assert.match(ok.body.reason, /per-purchase cap of \$25\.00/);
  const mat = await c.post('/api/offers/mat-desk/request', { qty: 1 });         // $24.00 desk mat (office): fits
  assert.equal(mat.body.allowed, true);
  assert.equal((await state(c)).mandate.committed_cents, 2400);
});

test('two sessions are set up independently; one owner\'s setup does not configure another', async () => {
  const a = raw(); const b = raw();
  await state(a); await state(b);
  await a.post('/api/mandate/setup', TERMS);
  assert.equal((await state(a)).mandate.configured, true);
  assert.equal((await state(b)).mandate.configured, false);
});

test('reset (development only) returns the session to "not set up"', async () => {
  const c = raw();
  await state(c);
  await c.post('/api/mandate/setup', TERMS);
  const r = await c.post('/api/reset');
  assert.equal(r.status, 200);
  assert.equal(r.body.mandate.configured, false);
  assert.equal((await c.post('/api/search', { query: 'lamp' })).status, 409);
});
