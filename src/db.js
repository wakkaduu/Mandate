// SQLite via Node's built-in node:sqlite (no native build step -> deploys anywhere Node 22.5+ runs).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { PRODUCTS } from './catalog.js';

let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  merchant TEXT NOT NULL,
  category TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  tags TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  emoji TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS mandates (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  budget_cents INTEGER NOT NULL CHECK (budget_cents > 0),
  per_item_cap_cents INTEGER NOT NULL CHECK (per_item_cap_cents > 0),
  categories TEXT NOT NULL,            -- JSON array
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
  amount_cents INTEGER NOT NULL,       -- computed server-side from the catalog, never from the client/agent
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
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,           -- PayPal event id: gives us idempotent webhook handling
  event_type TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
`;

export function openDb(file = config.dbPath) {
  if (db) return db;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  migrate(db);
  seedProducts(db);
  pruneOldSessions(db);
  return db;
}

export function closeDb() {
  if (db) db.close();
  db = undefined;
}

export function getDb() {
  return db ?? openDb();
}

/** Additive, idempotent migrations (works on fresh and existing databases). */
function migrate(d) {
  const has = (table, col) => d.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  const add = (table, col, ddl) => { if (!has(table, col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`); };
  add('mandates', 'expires_at', 'INTEGER');                     // epoch ms, NULL = never expires
  add('mandates', 'max_per_hour', 'INTEGER DEFAULT 6');         // purchase-request pace limit, NULL = unlimited
  add('sessions', 'mcp_token_hash', 'TEXT');                    // sha256 of the MCP bearer token (token itself is never stored)
  add('messages', 'trace', 'TEXT');                             // JSON: the agent's tool steps for that reply
  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_mcp ON sessions(mcp_token_hash) WHERE mcp_token_hash IS NOT NULL');
}

function seedProducts(d) {
  const upsert = d.prepare(`INSERT INTO products (id,name,merchant,category,price_cents,tags,description,emoji)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, merchant=excluded.merchant, category=excluded.category,
      price_cents=excluded.price_cents, tags=excluded.tags, description=excluded.description, emoji=excluded.emoji`);
  for (const p of PRODUCTS) {
    upsert.run(p.id, p.name, p.merchant, p.category, p.price_cents, p.tags, p.description, p.emoji);
  }
}

function pruneOldSessions(d) {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  d.prepare('DELETE FROM sessions WHERE created_at < ?').run(cutoff);
}

/** Run fn inside an IMMEDIATE transaction (takes the write lock up front -> no budget races). */
export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const out = fn(d);
    d.exec('COMMIT');
    return out;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}
