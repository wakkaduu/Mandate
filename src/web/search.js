// Live product search, in two stages:
//   1. FIND: Tavily and Serper (asked together; Gemini grounding only as a fallback) propose candidate product pages.
//      Providers are leads only.
//   2. VERIFY: the SERVER opens each candidate page itself and reads the retailer's published price and category
//      (src/web/extract.js). Only those verified results become "offers" the agent can buy.
import { config, searchProviders } from '../config.js';
import { categorize } from '../categories.js';
import { PROVIDERS, PROVIDER_LABEL, ProviderError } from './providers.js';
import { safeGet } from './safe-fetch.js';
import { extractProduct } from './extract.js';
import { saveOffer, getOffer, offerId, canonicalUrl } from '../offers.js';
import { db } from '../db.js';

export class SearchUnavailable extends Error {}

const MAX_OFFERS = 6;

const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const hostOf = (u) => new URL(u).hostname.replace(/^www\./, '');

// Not the product itself: a price on these pages is a deposit, a sample, a card balance, a warranty...
const NOT_THE_PRODUCT = /\b(deposit|swatch(?:es)?|samples?|gift ?cards?|e-?gift|warranty|protection plan|subscription|installation|pre-?order)\b/i;

async function verify(c) {
  const label = c.merchant || hostOf(c.url);
  try {
    const page = await safeGet(c.url);
    const found = extractProduct(page.body);
    const finalUrl = canonicalUrl(page.finalUrl);
    const title = clean(found?.name, 160) || c.title;
    if (NOT_THE_PRODUCT.test(title)) return { dropped: `${label}: "${title.slice(0, 40)}" is not the product itself (deposit, sample, gift card or service)` };
    const base = { url: finalUrl, title, merchant: c.merchant || hostOf(finalUrl), category: categorize(title, found?.category, new URL(finalUrl).pathname.replace(/[-_/]+/g, ' ')) };
    if (found && found.currency === 'USD') return { ...base, price_cents: found.price_cents, price_verified: true };
    if (found) return { dropped: `${label}: price is in ${found.currency}, only USD is supported` };
    if (config.web.allowUnverifiedPrices && c.quoted_cents) return { ...base, price_cents: c.quoted_cents, price_verified: false };
    return { dropped: `${label}: no product price found on the page (not a product page, or the site hides it from bots)` };
  } catch (e) {
    return { dropped: `${label}: page not reachable (${String(e.message).slice(0, 60)})` };
  }
}

/** Verify candidates in parallel but never wait on stragglers: whatever has finished after the cap is what we use. */
async function verifyAll(cands, capMs = 8000) {
  const done = new Array(cands.length);
  await Promise.race([
    Promise.all(cands.map(async (c, i) => { done[i] = { ...c, ...(await verify(c)) }; })),
    new Promise((r) => setTimeout(r, capMs).unref?.()),
  ]);
  return cands.map((c, i) => done[i] ?? { dropped: `${c.merchant || hostOf(c.url)}: too slow to respond` });
}

/** @returns {{offers: object[], dropped: string[], provider: string, model?: string}} */
export async function searchWeb({ query, max_price_usd, category }) {
  const providers = searchProviders();
  if (!providers.length) {
    throw new SearchUnavailable('Web product search is not configured: set TAVILY_API_KEY (free tier), SERPER_API_KEY or GEMINI_API_KEY (needs billing for Google Search).');
  }
  const q = clean(query, 120);
  if (!q) return { offers: [], dropped: [], provider: providers[0] };

  // Same question asked again (suggestion chips, repeated judges, an agent re-checking) reuses the last answer.
  const key = JSON.stringify([q.toLowerCase(), max_price_usd ?? null, category ?? null]);
  const d = await db();
  const hit = await d.get('SELECT * FROM search_cache WHERE key = ? AND created_at > ?', [key, Date.now() - config.web.searchCacheMs]);
  if (hit) {
    const cached = (await Promise.all(JSON.parse(hit.offer_ids).map((id) => getOffer(id)))).filter((o) => o && !o.stale);
    if (cached.length) return { offers: cached, dropped: Array(hit.skipped).fill('(skipped in the earlier identical search)'), provider: `${hit.provider} (cached)` };
  }
  const spent = (await d.get('SELECT COUNT(*) AS c FROM search_log WHERE created_at > ?', [Date.now() - 24 * 3600_000])).c;
  if (spent >= config.web.searchesPerDay) {
    throw new SearchUnavailable('The daily web-search budget for this deployment is used up (it protects the free search-API quotas). Try again tomorrow, or repeat an earlier search.');
  }
  await d.run('INSERT INTO search_log (created_at) VALUES (?)', [Date.now()]);

  const errors = [];
  const dropped = [];
  const all = new Map();      // offer id -> offer
  const perHost = new Map();
  const used = new Set();
  let model;

  // Stage 1: the plain search APIs are asked TOGETHER (one network round trip, and one verification pass over the
  // merged candidates). Gemini's Google Search grounding is only the fallback when they produce nothing verifiable.
  const plain = providers.filter((p) => p !== 'gemini');
  const fallback = providers.filter((p) => p === 'gemini');
  const run = async (names) => {
    const settled = await Promise.all(names.map(async (name) => {
      try { return { name, ...(await PROVIDERS[name]({ query: q, maxPriceUsd: max_price_usd, category })) }; }
      catch (e) { if (!(e instanceof ProviderError)) throw e; errors.push(`${PROVIDER_LABEL[name]}: ${e.message}`); return null; }
    }));
    // interleave so one provider cannot crowd out the other, tag each candidate with who found it
    const lists = settled.filter(Boolean).map((r) => r.candidates.map((c) => ({ ...c, via: [r.name] })));
    const merged = new Map();
    for (let i = 0; lists.some((l) => i < l.length); i++) {
      for (const l of lists) {
        const c = l[i];
        if (!c) continue;
        const k = canonicalUrl(c.url);
        if (merged.has(k)) merged.get(k).via.push(...c.via); else merged.set(k, c);
      }
    }
    const candidates = [...merged.values()].slice(0, 14);
    if (!candidates.length) return;
    const checked = await verifyAll(candidates);
    dropped.push(...checked.filter((x) => x.dropped).map((x) => x.dropped));
    for (const c of checked.filter((x) => !x.dropped)) {
      const id = offerId(c.url);
      const host = hostOf(c.url);
      if (all.has(id) || (perHost.get(host) ?? 0) >= config.web.maxPerHost || all.size >= MAX_OFFERS) continue;
      if (max_price_usd && c.price_cents > Math.round(max_price_usd * 100)) continue;
      if (category && c.category !== category) continue;
      perHost.set(host, (perHost.get(host) ?? 0) + 1);
      all.set(id, await saveOffer({ id, title: c.title, merchant: c.merchant, category: c.category, price_cents: c.price_cents, url: c.url, price_verified: c.price_verified }));
      c.via.forEach((v) => used.add(v));
    }
    for (const r of settled.filter(Boolean)) if (r.model) model = r.model;
  };
  if (plain.length) await run(plain);
  if (!all.size && fallback.length) await run(fallback);
  if (!all.size) for (const n of [...plain, ...fallback]) if (!errors.some((e) => e.startsWith(PROVIDER_LABEL[n]))) errors.push(`${PROVIDER_LABEL[n]}: no candidate could be verified`);
  if (all.size) {
    const offers = [...all.values()].sort((a, b) => a.price_cents - b.price_cents);
    await d.run('INSERT INTO search_cache (key, offer_ids, provider, skipped, created_at) VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET offer_ids=excluded.offer_ids, provider=excluded.provider, skipped=excluded.skipped, created_at=excluded.created_at',
      [key, JSON.stringify(offers.map((o) => o.id)), [...used].join('+'), dropped.length, Date.now()]);
    return { offers, dropped, provider: [...used].join('+'), model };
  }
  // Every provider either failed or produced nothing verifiable. Only call it "unavailable" if none actually answered.
  const answered = errors.some((e) => /no candidate could be verified/.test(e));
  if (!answered) throw new SearchUnavailable(`Web search is unavailable right now (${errors.join('; ')}).`);
  return { offers: [], dropped, provider: providers.at(-1) };
}
