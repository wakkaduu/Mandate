// Product-search providers. Each returns CANDIDATE product pages ({title, url, ...}); none of them is trusted for
// prices or categories - the server opens every candidate page and verifies it (src/web/search.js).
//   tavily  - agent-oriented web search API (free tier, no card)
//   serper  - Google results via API (free signup credits)
//   gemini  - Gemini with Google Search grounding (needs a billing-enabled Google key)
import { config } from '../config.js';
import { CATEGORIES } from '../categories.js';
import { generateWithFallback } from '../llm/gemini-core.js';

export class ProviderError extends Error {}

const NOT_PRODUCT_SITES = ['reddit.com', 'youtube.com', 'youtu.be', 'wikipedia.org', 'pinterest.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'quora.com', 'x.com', 'twitter.com'];
const MAX_CANDIDATES = 15;

// Hosts that (as of testing, 2026-11) hide prices from non-browser clients: skipping them up front saves a timeout each.
const BOT_HOSTILE = ['amazon.com', 'walmart.com', 'homedepot.com', 'ebay.com', 'bestbuy.com', 'target.com', 'wayfair.com', 'nytimes.com', 'kirklands.com', 'lowes.com', 'costco.com', 'newegg.com', 'bhphotovideo.com'];
// URL shapes of listing / editorial pages (never a single purchasable product).
const LISTING = /\/(c|b|category|categories|collections?|search|s|browse|blogs?|news|articles?|reviews?|guides?|tags?|topics?)(\/|$)|[?&](q|k|query|search)=|\/best-|\/zgbs\//i;
const PRODUCTISH = /\/(products?|p|pdp|dp|ip|item|itm)\//i;

const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

function toCandidate(c) {
  try {
    const url = new URL(String(c?.url));
    if (!/^https?:$/.test(url.protocol)) return null;
    const host = url.hostname.replace(/^www\./, '');
    const on = (list) => list.some((d) => host === d || host.endsWith(`.${d}`));
    if (on(NOT_PRODUCT_SITES) || on(BOT_HOSTILE) || LISTING.test(url.pathname + url.search)) return null;
    return {
      title: clean(c.title, 160), url: url.href, merchant: clean(c.merchant, 60),
      quoted_cents: Number.isFinite(Number(c.price_usd)) && Number(c.price_usd) > 0 ? Math.round(Number(c.price_usd) * 100) : null,
    };
  } catch { return null; }
}

async function postJson(url, headers, body) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(12_000) });
  } catch (e) { throw new ProviderError(`network error (${e.message})`); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError(`HTTP ${res.status}${json.detail?.error ? `: ${String(json.detail.error).slice(0, 80)}` : json.message ? `: ${String(json.message).slice(0, 80)}` : ''}`);
  return json;
}

const shoppingQuery = ({ query, maxPriceUsd }) => `${query} buy online${maxPriceUsd ? ` under $${maxPriceUsd}` : ''}`;

/** Product-looking URLs (/products/, /p/, /dp/...) first: they are the ones most likely to carry a readable price. */
const rankProductPages = (cands) => [...cands].sort((a, b) => Number(PRODUCTISH.test(new URL(b.url).pathname)) - Number(PRODUCTISH.test(new URL(a.url).pathname)));

async function tavily(args) {
  const json = await postJson(`${config.search.tavilyBase}/search`, { Authorization: `Bearer ${config.search.tavilyKey}` }, {
    query: shoppingQuery(args), search_depth: 'basic', max_results: MAX_CANDIDATES, country: 'united states', exclude_domains: [...NOT_PRODUCT_SITES, ...BOT_HOSTILE],
  });
  return { candidates: rankProductPages((json.results ?? []).map((r) => toCandidate({ title: r.title, url: r.url })).filter(Boolean)) };
}

async function serper(args) {
  // One credit per search. The query is biased toward store product pages ("add to cart" + /products/ URLs usually
  // expose a machine-readable price); a plain query mostly returns category pages and reviews.
  const json = await postJson(`${config.search.serperBase}/search`, { 'X-API-KEY': config.search.serperKey }, {
    q: `${args.query} "add to cart" inurl:products`, gl: 'us', hl: 'en', num: 10,
  });
  return { candidates: rankProductPages((json.organic ?? []).map((r) => toCandidate({ title: r.title, url: r.link })).filter(Boolean)) };
}

const geminiPrompt = ({ query, maxPriceUsd, category }) => `You are a product-sourcing assistant. Use Google Search to find real products that can be bought online right now in the US for: "${query}"${maxPriceUsd ? `, priced at most $${maxPriceUsd} USD` : ''}${category ? `, category ${category}` : ''}.
Return up to 6 DIFFERENT products from reputable online retailers. Each url must be a direct product page (not a search results, category or review page) and must be a URL you actually saw in search results - never guess or construct one.
Reply with ONLY a JSON array, no prose and no markdown, shaped exactly like:
[{"title":"product name","merchant":"retailer name","url":"https://...","price_usd":12.34}]
If you find nothing suitable reply with [].`;

async function gemini(args) {
  let out;
  try {
    out = await generateWithFallback({
      contents: [{ role: 'user', parts: [{ text: geminiPrompt(args) }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.2 },
    }, Date.now() + 25_000, 'search');
  } catch (e) { throw new ProviderError(`${e.status ?? 'network'}: ${String(e.message).slice(0, 100)}`); }
  const text = (out.json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  const a = text.indexOf('[');
  const b = text.lastIndexOf(']');
  let arr = [];
  try { if (a >= 0 && b > a) arr = JSON.parse(text.slice(a, b + 1)); } catch { /* model ignored the format */ }
  return { candidates: (Array.isArray(arr) ? arr : []).map(toCandidate).filter(Boolean), model: out.model };
}

export const PROVIDERS = { tavily, serper, gemini };
export const PROVIDER_LABEL = { tavily: 'Tavily', serper: 'Serper', gemini: 'Gemini + Google Search' };
export const CATEGORY_LIST = CATEGORIES;
