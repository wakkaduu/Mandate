// Read the price a retailer publishes for a product page: schema.org JSON-LD first (what Google Shopping itself
// relies on), then Open Graph / product meta tags. The price used for a purchase is ONLY ever taken from here
// (or, if explicitly enabled, from the search result) - never from what the chat model says later.

const ENT = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };
const decode = (s) => String(s).replace(/&(?:amp|quot|#39|apos|lt|gt|nbsp);/g, (m) => ENT[m]);

const toCents = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 && n < 1_000_000 ? Math.round(n * 100) : null;
};
const asArray = (x) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);
const typeOf = (n) => asArray(n?.['@type']).map(String);
const text = (v) => (typeof v === 'string' ? decode(v).trim() : null);

function offerPrice(offer) {
  if (!offer || typeof offer !== 'object') return null;
  if (asArray(offer.availability).some((a) => /OutOfStock|SoldOut|Discontinued/i.test(String(a)))) return null;
  const specs = asArray(offer.priceSpecification);
  const price = offer.price ?? offer.lowPrice ?? specs.find((s) => s?.price)?.price;
  const currency = offer.priceCurrency ?? specs.find((s) => s?.priceCurrency)?.priceCurrency;
  const cents = toCents(price);
  return cents ? { price_cents: cents, currency: String(currency || '').toUpperCase() } : null;
}

function* walk(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return;
  if (Array.isArray(node)) { for (const n of node) yield* walk(n, depth + 1); return; }
  yield node;
  for (const key of ['@graph', 'hasVariant', 'mainEntity', 'itemListElement', 'item']) yield* walk(node[key], depth + 1);
}

function fromJsonLd(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    for (const node of walk(data)) {
      if (!typeOf(node).some((t) => /^(Product|ProductGroup|IndividualProduct)$/i.test(t))) continue;
      const offers = [...asArray(node.offers).flatMap((o) => [o, ...asArray(o?.offers)])].map(offerPrice).filter(Boolean);
      if (!offers.length) continue;
      const usd = offers.filter((o) => o.currency === 'USD');
      const best = (usd.length ? usd : offers).sort((a, b) => a.price_cents - b.price_cents)[0];
      const cat = asArray(node.category).map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean).join(' ');
      out.push({ ...best, name: text(node.name), category: text(cat) || null, via: 'json-ld', group: typeOf(node).includes('ProductGroup') });
    }
  }
  // A category / search page lists many different products. Attaching one of their prices to the page URL would be
  // wrong, so a page with several distinct products (and no ProductGroup of variants) is not a product page.
  if (!out.some((p) => p.group) && new Set(out.map((p) => p.name)).size > 1) return [];
  return out;
}

function metaMap(html) {
  const map = {};
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = {};
    for (const a of tag[0].matchAll(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[a[1].toLowerCase()] = a[3] ?? a[4];
    const key = attrs.property ?? attrs.name ?? attrs.itemprop;
    if (key && attrs.content !== undefined && !(key in map)) map[key.toLowerCase()] = decode(attrs.content);
  }
  return map;
}

/** @returns {{price_cents:number, currency:string, name:string|null, category:string|null, via:string}|null} */
export function extractProduct(html) {
  const ld = fromJsonLd(html);
  if (ld.length) return ld.find((p) => p.currency === 'USD') ?? ld[0];
  const meta = metaMap(html);
  const cents = toCents(meta['product:price:amount'] ?? meta['og:price:amount']);
  const currency = String(meta['product:price:currency'] ?? meta['og:price:currency'] ?? '').toUpperCase();
  if (cents && /^[A-Z]{3}$/.test(currency)) return { price_cents: cents, currency, name: meta['og:title'] ?? null, category: meta['product:category'] ?? null, via: 'meta' };
  return null;
}
