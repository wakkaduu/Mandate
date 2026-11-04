// Persistence via libSQL (SQLite-compatible): a local file for development / Render, or a remote Turso
// database (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN) for serverless hosts such as Vercel where the filesystem is
// ephemeral. One async code path for both. Products are not stored as a catalog: `offers` holds web search results whose price the server verified.
import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const SCHEMA_VERSION = 6;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  mcp_token_hash TEXT
);
CREATE TABLE IF NOT EXISTS mandates (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  budget_cents INTEGER NOT NULL CHECK (budget_cents > 0),
  per_item_cap_cents INTEGER NOT NULL CHECK (per_item_cap_cents > 0),
  categories TEXT NOT NULL,            -- JSON array
  expires_at INTEGER,                  -- epoch ms, NULL = never expires
  max_per_hour INTEGER DEFAULT 6,      -- purchase-request pace limit, NULL = unlimited
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  merchant TEXT NOT NULL,
  category TEXT NOT NULL,
  qty INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,       -- computed server-side from a stored offer, never from the client/agent
  product_url TEXT,                    -- the retailer page the offer came from
  price_verified INTEGER NOT NULL DEFAULT 0, -- 1 = server read the price from the retailer's page
  confirmed_at INTEGER,                -- human confirmed a high-value purchase (typed the amount) before it could be paid
  status TEXT NOT NULL,                -- see src/purchases.js STATUS
  reason TEXT,                         -- policy / failure explanation
  rationale TEXT,                      -- agent's stated reason for the purchase
  paypal_order_id TEXT,
  paypal_capture_id TEXT,
  paypal_refund_id TEXT,
  payer_email TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,                 -- o_ + hash of the canonical product URL
  title TEXT NOT NULL,
  merchant TEXT NOT NULL,
  category TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  url TEXT NOT NULL,
  price_verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS confirmations (   -- two-step confirmations for irreversible actions (refunds)
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  purchase_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  token_hash TEXT NOT NULL,            -- sha256 of the one-time token; the token itself is only ever shown once
  available_at INTEGER NOT NULL,       -- cooling-off: not confirmable before this
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_confirmations_purchase ON confirmations(purchase_id, kind);
CREATE TABLE IF NOT EXISTS search_cache (
  key TEXT PRIMARY KEY,                -- normalised query + filters
  offer_ids TEXT NOT NULL,             -- JSON array of offers.id
  provider TEXT NOT NULL,
  skipped INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS search_log (  -- one row per real provider search: the daily search budget
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_log_time ON search_log(created_at);
CREATE INDEX IF NOT EXISTS idx_purchases_session ON purchases(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_purchases_order ON purchases(paypal_order_id);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  purchase_id TEXT,
  type TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit(session_id, id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  trace TEXT,                          -- JSON: the agent's tool steps for that reply
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,           -- PayPal event id: gives us idempotent webhook handling
  event_type TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
`;

let client;
let ready;

const toObject = (rs) => rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));

/** Thin executor shared by the pool and by transactions: get / all / run. */
function executor(target) {
  const exec = (sql, args = []) => target.execute({ sql, args });
  return {
    get: async (sql, args) => toObject(await exec(sql, args))[0],
    all: async (sql, args) => toObject(await exec(sql, args)),
    run: async (sql, args) => ({ changes: (await exec(sql, args)).rowsAffected }),
  };
}

async function init() {
  const { dbUrl, dbAuthToken, dbPath } = config;
  if (dbUrl.startsWith('file:') && dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  client = createClient({ url: dbUrl, ...(dbAuthToken ? { authToken: dbAuthToken } : {}) });
  const q = executor(client);
  // schema version lives in a tiny table (PRAGMA user_version is not available on every remote libSQL host)
  const version = Number((await q.get("SELECT value FROM app_meta WHERE key = 'schema_version'").catch(() => undefined))?.value ?? 0);
  if (version < SCHEMA_VERSION) {
    await client.executeMultiple(SCHEMA);
    // Additive upgrades for databases created by earlier versions of this app.
    const cols = async (table) => (await q.all(`PRAGMA table_info(${table})`)).map((c) => c.name);
    const add = async (table, col, ddl) => { if (!(await cols(table)).includes(col)) await client.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`); };
    await add('mandates', 'expires_at', 'INTEGER');
    await add('mandates', 'max_per_hour', 'INTEGER DEFAULT 6');
    await add('sessions', 'mcp_token_hash', 'TEXT');
    await add('messages', 'trace', 'TEXT');
    await add('purchases', 'product_url', 'TEXT');
    await add('purchases', 'price_verified', 'INTEGER NOT NULL DEFAULT 0');
    await add('purchases', 'confirmed_at', 'INTEGER');
    await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_mcp ON sessions(mcp_token_hash) WHERE mcp_token_hash IS NOT NULL');
    await q.run("INSERT INTO app_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(SCHEMA_VERSION)]);
  }
  if (dbUrl.startsWith('file:')) await client.execute('PRAGMA foreign_keys = ON').catch(() => {});
  // Housekeeping: demo sessions older than 7 days go away (children cascade).
  await q.run('DELETE FROM sessions WHERE created_at < ?', [Date.now() - 7 * 24 * 3600 * 1000]);
  await q.run('DELETE FROM offers WHERE updated_at < ?', [Date.now() - 7 * 24 * 3600 * 1000]);
  await q.run('DELETE FROM search_cache WHERE created_at < ?', [Date.now() - 24 * 3600 * 1000]);
  await q.run('DELETE FROM confirmations WHERE expires_at < ?', [Date.now() - 24 * 3600 * 1000]);
  await q.run('DELETE FROM search_log WHERE created_at < ?', [Date.now() - 48 * 3600 * 1000]);
  return q;
}

/** Initialise once per process (cheap no-op afterwards). Resolves to the shared executor. */
export function openDb() {
  ready ??= init().catch((e) => { ready = undefined; throw e; });
  return ready;
}

export async function closeDb() {
  if (ready) { try { await ready; } catch { /* ignore */ } }
  client?.close();
  client = undefined;
  ready = undefined;
}

export async function db() {
  return openDb();
}

/** Run fn inside a write transaction (BEGIN IMMEDIATE): budget reservations cannot race. */
export async function tx(fn) {
  await openDb();
  const t = await client.transaction('write');
  try {
    const out = await fn(executor(t));
    await t.commit();
    return out;
  } catch (err) {
    try { await t.rollback(); } catch { /* already closed */ }
    throw err;
  } finally {
    t.close();
  }
}
