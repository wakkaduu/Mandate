import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';
import { searchProducts } from '../src/purchases.js';

const top = (q, opts) => searchProducts({ query: q, ...opts })[0]?.id;
let app;
test.before(async () => { app = await boot(); });
test.after(async () => { await app.close(); });

test('catalog search understands plurals, synonyms and head nouns', () => {
  assert.equal(top('desk lamps'), 'lamp-aurora');
  assert.equal(top('something to light my desk'), 'lamp-aurora');
  assert.equal(top('mouse'), 'mouse-ergo');              // not the "mouse pad" mat
  assert.equal(top('4k monitor'), 'mon-4k');
  assert.equal(top('monitor'), 'mon-fhd');                // cheapest real monitor, not the riser accessory
  assert.equal(top('monitor stand'), 'mon-stand');
  assert.equal(top('headphones'), 'headphones-nc');
  assert.equal(top('mechanical keyboard'), 'kb-tactile');
});

test('no match for things we do not sell; price filter respected', () => {
  assert.equal(searchProducts({ query: 'standing desk' }).length, 0);
  assert.equal(searchProducts({ query: 'lamp', max_price_cents: 2000 }).length, 0);
  assert.deepEqual(searchProducts({ query: 'lamp', max_price_cents: 4000 }).map((p) => p.id), ['lamp-aurora']);
});
