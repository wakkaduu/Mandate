// Offers = web search results the SERVER has looked at. An offer id is the only thing the agent can buy, and its
// price is whatever the server stored (read from the retailer's page), so a model can neither invent a price nor
// change one after the fact.
import { createHash } from 'node:crypto';
import { db } from './db.js';

/** Offers older than this are not purchasable: prices move, so the agent must search again. */
export const OFFER_TTL_MS = 6 * 3600_000;

const TRACKING = /^(utm_|fbclid|gclid|msclkid|mc_|ref$|ref_|tag$|_encoding)/i;

export function canonicalUrl(raw) {
  const u = new URL(raw);
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  return u.href;
}

export const offerId = (url) => `o_${createHash('sha256').update(canonicalUrl(url)).digest('hex').slice(0, 16)}`;

/** Insert or refresh an offer (same product URL => same id, new price/time). */
export async function saveOffer({ id, title, merchant, category, price_cents, url, price_verified }) {
  const d = await db();
  const now = Date.now();
  const oid = id ?? offerId(url);
  await d.run(`INSERT INTO offers (id,title,merchant,category,price_cents,url,price_verified,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, merchant=excluded.merchant, category=excluded.category, price_cents=excluded.price_cents,
      url=excluded.url, price_verified=excluded.price_verified, updated_at=excluded.updated_at`,
  [oid, title, merchant, category, price_cents, url, price_verified ? 1 : 0, now, now]);
  return getOffer(oid);
}

export async function getOffer(id) {
  const row = await (await db()).get('SELECT * FROM offers WHERE id = ?', [String(id ?? '')]);
  if (!row) return undefined;
  return {
    id: row.id, name: row.title, merchant: row.merchant, category: row.category, price_cents: row.price_cents,
    url: row.url, price_verified: Boolean(row.price_verified), stale: Date.now() - row.updated_at > OFFER_TTL_MS,
  };
}
