// Upgrading a database created before "the owner sets the budget" (schema v7): existing mandates stay usable
// (they were set by the owner or by the old built-in default), while mandates created afterwards start unconfigured.
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';

process.env.LOG_REQUESTS = '0';
process.env.PAYPAL_MODE = 'mock';
const file = path.join(os.tmpdir(), `mandate-migrate-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = file;

// A v7 database, as the previous release left it: no activated_at column.
const old = createClient({ url: `file:${file}` });
await old.executeMultiple(`
  CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, mcp_token_hash TEXT);
  CREATE TABLE mandates (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, name TEXT NOT NULL,
    budget_cents INTEGER NOT NULL CHECK (budget_cents > 0), per_item_cap_cents INTEGER NOT NULL CHECK (per_item_cap_cents > 0),
    categories TEXT NOT NULL, expires_at INTEGER, max_per_hour INTEGER DEFAULT 6, max_per_day_cents INTEGER,
    blocked_sellers TEXT NOT NULL DEFAULT '[]', allowed_sellers TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL
  );
  INSERT INTO app_meta VALUES ('schema_version', '7');
  INSERT INTO sessions VALUES ('legacy', ${Date.now()}, NULL);
  INSERT INTO mandates (session_id, name, budget_cents, per_item_cap_cents, categories, updated_at) VALUES ('legacy', 'Home office refresh', 30000, 12000, '["office","home"]', ${Date.now()});
`);
old.close();

const { openDb, closeDb } = await import('../src/db.js');
const svc = await import('../src/purchases.js');

test('upgrade v7 -> v8: an existing mandate stays active with its figures; a new session starts unconfigured', async () => {
  await openDb();
  const legacy = await svc.getMandate('legacy');
  assert.equal(legacy.configured, true);
  assert.equal(legacy.budget_cents, 30000);
  assert.equal(legacy.per_item_cap_cents, 12000);
  assert.deepEqual(legacy.categories, ['office', 'home']);

  const fresh = await svc.ensureSession();
  assert.equal((await svc.getMandate(fresh)).configured, false);
  await closeDb();

  // opening again (already v8) must not activate anything it should not
  await openDb();
  assert.equal((await svc.getMandate(fresh)).configured, false, 'a second start keeps "not set up" as it was');
  assert.equal((await svc.getMandate('legacy')).configured, true);
  await closeDb();
});
