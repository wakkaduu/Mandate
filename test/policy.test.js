import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/policy.js';

const mandate = { budget_cents: 30000, per_item_cap_cents: 12000, categories: ['office', 'electronics'] };
const lamp = { id: 'l', name: 'Lamp', category: 'office', price_cents: 3400 };
const ctx = (over = {}) => ({ committed_cents: 0, open_same_product: false, ...over });

test('allows an in-policy purchase and prices it server-side', () => {
  const v = evaluate(mandate, lamp, 2, ctx());
  assert.deepEqual(v, { ok: true, amount_cents: 6800 });
});
test('blocks unknown product', () => assert.equal(evaluate(mandate, undefined, 1, ctx()).code, 'UNKNOWN_PRODUCT'));
test('blocks bad quantities', () => {
  for (const q of [0, -1, 1.5, 6, NaN]) assert.equal(evaluate(mandate, lamp, q, ctx()).code, 'BAD_QUANTITY');
});
test('blocks disallowed category', () => {
  assert.equal(evaluate(mandate, { ...lamp, category: 'furniture' }, 1, ctx()).code, 'CATEGORY_NOT_ALLOWED');
});
test('blocks over per-purchase cap (including via quantity)', () => {
  assert.equal(evaluate(mandate, { ...lamp, price_cents: 13000 }, 1, ctx()).code, 'OVER_ITEM_CAP');
  assert.equal(evaluate(mandate, { ...lamp, price_cents: 5000 }, 3, ctx()).code, 'OVER_ITEM_CAP');
});
test('blocks over remaining budget', () => {
  assert.equal(evaluate(mandate, lamp, 1, ctx({ committed_cents: 28000 })).code, 'OVER_BUDGET');
});
test('allows exactly the remaining budget', () => {
  assert.equal(evaluate(mandate, lamp, 1, ctx({ committed_cents: 26600 })).ok, true);
});
test('blocks duplicates', () => assert.equal(evaluate(mandate, lamp, 1, ctx({ open_same_product: true })).code, 'DUPLICATE'));

test('blocks an expired mandate before anything else', () => {
  const m = { ...mandate, expires_at: 1000 };
  assert.equal(evaluate(m, lamp, 1, ctx({ now: 2000 })).code, 'MANDATE_EXPIRED');
  assert.equal(evaluate(m, lamp, 1, ctx({ now: 500 })).ok, true);
});
test('enforces the hourly pace limit; null means unlimited', () => {
  const m = { ...mandate, max_per_hour: 3 };
  assert.equal(evaluate(m, lamp, 1, ctx({ recent_count: 2 })).ok, true);
  assert.equal(evaluate(m, lamp, 1, ctx({ recent_count: 3 })).code, 'OVER_PACE');
  assert.equal(evaluate({ ...mandate, max_per_hour: null }, lamp, 1, ctx({ recent_count: 99 })).ok, true);
});

// ---------------------------------------------------------------- seller controls + daily limit
const lampAt = (url) => ({ ...lamp, url });
test('blocked sellers: exact domain and subdomains are refused, www is ignored', () => {
  const m = { ...mandate, blocked_sellers: ['badshop.com'] };
  for (const url of ['https://badshop.com/p/1', 'https://www.badshop.com/p/1', 'https://store.badshop.com/p/1']) assert.equal(evaluate(m, lampAt(url), 1, ctx()).code, 'SELLER_BLOCKED', url);
  assert.equal(evaluate(m, lampAt('https://notbadshop.com/p/1'), 1, ctx()).ok, true, 'a different domain that merely ends with the same letters is fine');
});
test('allowed sellers: when set, only those domains (and subdomains) may be bought from', () => {
  const m = { ...mandate, allowed_sellers: ['staples.com', 'ikea.com'] };
  assert.equal(evaluate(m, lampAt('https://www.staples.com/x'), 1, ctx()).ok, true);
  assert.equal(evaluate(m, lampAt('https://shop.ikea.com/x'), 1, ctx()).ok, true);
  assert.equal(evaluate(m, lampAt('https://random.example/x'), 1, ctx()).code, 'SELLER_NOT_ALLOWED');
  assert.equal(evaluate(m, lampAt('not a url'), 1, ctx()).code, 'SELLER_NOT_ALLOWED', 'unknown seller is refused when an allow-list exists');
  assert.equal(evaluate({ ...mandate, blocked_sellers: ['x.com'] }, lamp, 1, ctx()).ok, true, 'no url and no allow-list: nothing to check');
});
test('blocked beats allowed; the seller check runs before the money checks', () => {
  const m = { ...mandate, allowed_sellers: ['a.com'], blocked_sellers: ['a.com'] };
  assert.equal(evaluate(m, lampAt('https://a.com/p'), 1, ctx()).code, 'SELLER_BLOCKED');
  assert.equal(evaluate({ ...mandate, blocked_sellers: ['a.com'] }, { ...lampAt('https://a.com/p'), price_cents: 999999 }, 1, ctx()).code, 'SELLER_BLOCKED');
});
test('daily limit counts everything committed in the last 24h', () => {
  const m = { ...mandate, max_per_day_cents: 10000 };
  assert.equal(evaluate(m, lamp, 1, ctx({ day_committed_cents: 6000 })).ok, true);                 // 60 + 34 <= 100
  const v = evaluate(m, lamp, 1, ctx({ day_committed_cents: 7000 }));                               // 70 + 34 > 100
  assert.equal(v.code, 'OVER_DAILY');
  assert.match(v.reason, /\$30\.00 left/);
  assert.equal(evaluate({ ...mandate, max_per_day_cents: null }, lamp, 1, ctx({ day_committed_cents: 99999 })).ok, true);
});
