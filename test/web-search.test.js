// The live-web pipeline, offline: stub search providers (Tavily, Serper, Gemini grounding) propose candidate
// pages, a stub "retailer" serves product pages, and the SERVER must (a) read prices/categories from the pages,
// not trust any provider or model, (b) drop what it cannot verify, (c) fall back across providers, and
// (d) refuse to fetch private / non-https targets (SSRF).
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.LOG_REQUESTS = '0';
process.env.PAYPAL_MODE = 'mock';
process.env.DATABASE_PATH = path.join(os.tmpdir(), `mandate-web-${process.pid}-${Date.now()}.db`);
process.env.WEB_ALLOW_PRIVATE_HOSTS = '1';
process.env.GEMINI_API_KEY = 'gem-key';
process.env.GEMINI_MODEL = 'search-model';
process.env.TAVILY_API_KEY = 'tvly-test';
process.env.SERPER_API_KEY = 'serper-test';
delete process.env.ANTHROPIC_API_KEY;

let origin;
const ld = (price, cur = 'USD', extra = {}, name = 'Test &amp; Product') => `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Product', name, offers: { '@type': 'Offer', price, priceCurrency: cur, ...extra } }] })}</script></head><body>x</body></html>`;
const pages = {
  '/lamp': ld('34.00', 'USD', {}, 'Halo LED Desk Lamp'),
  '/mouse': `<html><head><meta property="og:title" content="Wireless Ergonomic Mouse"><meta content="36.00" property="product:price:amount"><meta property="product:price:currency" content="USD"></head></html>`,
  '/euro': ld('20.00', 'EUR'),
  '/review': '<html><body><h1>The 10 best desk lamps</h1>no structured data here</body></html>',
  '/soldout': ld('10.00', 'USD', { availability: 'https://schema.org/OutOfStock' }),
  '/big': ld('1,299.99', 'USD', {}, 'Mystery Gadget'),
  '/deposit': ld('44.99', 'USD', {}, '(Deposit) Ergonomic Chair'),
  '/a1': ld('11.00', 'USD', {}, 'Cotton Hoodie One'), '/a2': ld('12.00', 'USD', {}, 'Cotton Hoodie Two'), '/a3': ld('13.00', 'USD', {}, 'Cotton Hoodie Three'),
};
const calls = { tavily: 0, serper: 0, gemini: 0 };
let tavilyResults = [];
let serperResults = [];
let geminiCandidates = [];
let tavilyFails = false;
const stub = http.createServer((req, res) => {
  const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    return req.on('end', () => {
      const b = JSON.parse(body);
      if (req.url === '/search' && req.headers.authorization) {          // Tavily
        calls.tavily++;
        assert.equal(req.headers.authorization, 'Bearer tvly-test');
        assert.ok(b.exclude_domains.includes('reddit.com'));
        if (tavilyFails) return json(432, { detail: { error: 'plan limit' } });
        return json(200, { results: tavilyResults.map((u) => ({ title: `Result ${u}`, url: origin + u, content: '', score: 1 })) });
      }
      if (req.url === '/search') {                                       // Serper
        calls.serper++;
        assert.equal(req.headers['x-api-key'], 'serper-test');
        return json(200, { organic: serperResults.map((u) => ({ title: `Result ${u}`, link: origin + u, snippet: '' })) });
      }
      calls.gemini++;                                                     // Gemini generateContent
      assert.ok(b.tools[0].google_search, 'must be grounded');
      return json(200, { candidates: [{ content: { role: 'model', parts: [{ text: 'ok:\n```json\n' + JSON.stringify(geminiCandidates.map((u) => ({ title: `G ${u}`, merchant: 'Shop', url: origin + u, price_usd: 1 }))) + '\n```' }] } }] });
    });
  }
  const html = pages[req.url.split('?')[0]];
  if (!html) { res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
origin = `http://127.0.0.1:${stub.address().port}`;
process.env.GEMINI_BASE_URL = origin;
process.env.TAVILY_BASE_URL = origin;
process.env.SERPER_BASE_URL = origin;

const { searchWeb, SearchUnavailable } = await import('../src/web/search.js');
const { safeGet, isPrivateIp, FetchBlocked } = await import('../src/web/safe-fetch.js');
const { extractProduct } = await import('../src/web/extract.js');
const { config } = await import('../src/config.js');
const { categorize } = await import('../src/categories.js');
const { getOffer, offerId, canonicalUrl } = await import('../src/offers.js');
const { closeDb } = await import('../src/db.js');
test.after(async () => { stub.close(); await closeDb(); });

const path1 = (o) => new URL(o.url).pathname;
config.web.maxPerHost = 10; // every stub page shares one host
const reset = () => { calls.tavily = calls.serper = calls.gemini = 0; tavilyFails = false; tavilyResults = []; serperResults = []; geminiCandidates = []; };

test('Tavily first: the server reads price + category from each page; listicles, EUR and sold-out pages are dropped', async () => {
  reset();
  tavilyResults = ['/lamp', '/mouse', '/big', '/review', '/euro', '/soldout', '/gone'];
  const r = await searchWeb({ query: 'desk lamp' });
  assert.equal(r.provider, 'tavily');
  assert.deepEqual([calls.tavily, calls.serper, calls.gemini], [1, 1, 0]);   // Tavily + Serper are asked together; Gemini is only a fallback
  const by = Object.fromEntries(r.offers.map((o) => [path1(o), o]));
  assert.deepEqual(Object.keys(by).sort(), ['/big', '/lamp', '/mouse']);
  assert.equal(by['/lamp'].price_cents, 3400);
  assert.equal(by['/lamp'].name, 'Halo LED Desk Lamp');
  assert.equal(by['/lamp'].category, 'office');          // derived by the server from the page title
  assert.equal(by['/mouse'].category, 'electronics');
  assert.equal(by['/mouse'].price_cents, 3600);          // meta-tag fallback
  assert.equal(by['/big'].category, 'other');
  assert.equal(by['/big'].price_cents, 129999);
  assert.equal(r.dropped.length, 3);          // '/review' never gets fetched: listing/editorial URL shapes are filtered up front
  assert.ok(r.dropped.some((d) => /EUR/.test(d)));
  assert.deepEqual(r.offers.map((o) => o.price_cents), r.offers.map((o) => o.price_cents).sort((a, b) => a - b));
  assert.equal((await getOffer(by['/lamp'].id)).price_cents, 3400, 'offer is persisted server-side');
});

test('Gemini grounding is the fallback when Tavily errors and Serper yields nothing verifiable', async () => {
  reset();
  tavilyFails = true;                                    // quota / plan limit
  serperResults = ['/review'];                           // answers, but nothing verifiable
  geminiCandidates = ['/lamp'];
  const r = await searchWeb({ query: 'lamp' });
  assert.equal(r.provider, 'gemini');
  assert.deepEqual([calls.tavily, calls.serper, calls.gemini], [1, 1, 1]);
  assert.equal(r.offers.length, 1);
  assert.equal(r.offers[0].price_cents, 3400);           // not the $1 the provider "quoted"

  reset();
  tavilyFails = false; tavilyResults = ['/review'];      // Tavily answers with junk -> Serper has a real page
  serperResults = ['/mouse'];
  assert.equal((await searchWeb({ query: 'mouse' })).provider, 'serper');
});

test('Tavily and Serper are asked together; their candidates are merged and de-duplicated before verification', async () => {
  reset();
  tavilyResults = ['/lamp'];
  serperResults = ['/lamp', '/mouse'];
  const r = await searchWeb({ query: 'x' });
  assert.equal(r.provider, 'tavily+serper');
  assert.deepEqual(r.offers.map(path1).sort(), ['/lamp', '/mouse']);
  assert.deepEqual([calls.tavily, calls.serper, calls.gemini], [1, 1, 0]);   // Gemini grounding is not consulted when the plain providers already produced offers
});

test('max price, category filter and per-host cap apply to VERIFIED data', async () => {
  reset();
  tavilyResults = ['/lamp', '/mouse'];
  assert.deepEqual((await searchWeb({ query: 'x', max_price_usd: 35 })).offers.map(path1), ['/lamp']);   // mouse is really $36
  assert.deepEqual((await searchWeb({ query: 'x', category: 'electronics' })).offers.map(path1), ['/mouse']);
  tavilyResults = ['/a1', '/a2', '/a3'];
  config.web.maxPerHost = 2;                                                                              // same host: max 2
  const r = await searchWeb({ query: 'hoodie' });
  assert.equal(r.offers.length, 2);
  assert.ok(r.offers.every((o) => o.category === 'clothing'));
  config.web.maxPerHost = 10;
});

test('everything failing is "unavailable"; answering-but-empty is a normal empty result; no keys is "not configured"', async () => {
  reset();
  tavilyFails = true;
  config.search.serperKey = '';
  const gem = config.gemini.apiKey; config.gemini.apiKey = '';
  await assert.rejects(() => searchWeb({ query: 'nothing-cached-1' }), (e) => e instanceof SearchUnavailable && /Tavily: HTTP 432/.test(e.message));
  config.search.tavilyKey = '';
  await assert.rejects(() => searchWeb({ query: 'nothing-cached-1' }), (e) => e instanceof SearchUnavailable && /not configured/.test(e.message));
  config.search.tavilyKey = 'tvly-test'; config.search.serperKey = 'serper-test'; config.gemini.apiKey = gem;
  reset();
  tavilyResults = []; serperResults = []; geminiCandidates = [];
  const empty = await searchWeb({ query: 'airplane' });
  assert.deepEqual(empty.offers, []);
});

test('deposit / sample / gift-card pages are not offered as the product', async () => {
  reset();
  tavilyResults = ['/deposit', '/mouse'];
  const r = await searchWeb({ query: 'chair' });
  assert.deepEqual(r.offers.map(path1), ['/mouse']);
  assert.ok(r.dropped.some((d) => /not the product itself/.test(d)));
});

test('identical searches are served from the cache (no provider calls); the daily budget caps real searches', async () => {
  reset();
  tavilyResults = ['/lamp', '/mouse', '/big'];
  const first = await searchWeb({ query: 'Cache Probe' });
  assert.equal(calls.tavily, 1);
  const again = await searchWeb({ query: '  cache   probe ' });       // normalised: case + whitespace
  assert.equal(calls.tavily, 1, 'second identical search must not hit the provider');
  assert.match(again.provider, /cached/);
  assert.deepEqual(again.offers.map((o) => o.id), first.offers.map((o) => o.id));
  assert.equal((await searchWeb({ query: 'cache probe', max_price_usd: 50 })).provider.includes('cached'), false, 'different filters are a different search');

  const saved = config.web.searchesPerDay;
  config.web.searchesPerDay = 0;
  try {
    await assert.rejects(() => searchWeb({ query: 'brand new question' }), (e) => e instanceof SearchUnavailable && /daily web-search budget/.test(e.message));
    assert.ok((await searchWeb({ query: 'cache probe' })).offers.length, 'cached answers still work when the budget is spent');
  } finally { config.web.searchesPerDay = saved; }
});

test('same product URL keeps one offer id (tracking params and fragments ignored)', () => {
  assert.equal(offerId('https://a.example/p?utm_source=x&id=7#top'), offerId('https://a.example/p?id=7'));
  assert.notEqual(offerId('https://a.example/p?id=7'), offerId('https://a.example/p?id=8'));
  assert.equal(canonicalUrl('https://a.example/p?b=1&a=2&fbclid=z'), 'https://a.example/p?a=2&b=1');
});

test('categorize: server-side keyword heuristic', () => {
  assert.equal(categorize('Aurora LED Desk Lamp'), 'office');
  assert.equal(categorize('Vista 27" 4K Monitor'), 'electronics');
  assert.equal(categorize('ErgoFlex Mesh Chair', 'Furniture'), 'furniture');
  assert.equal(categorize("Men's Tree Runner"), 'clothing');
  assert.equal(categorize('Mystery Gadget'), 'other');
  assert.equal(categorize(null, undefined), 'other');
  assert.equal(categorize('Cashmere Desk Pad - Premium Felt Desk Mat & Mouse Pad'), 'office');
  assert.equal(categorize('Mount-It! Turcom LED Desk Lamp, 16", with USB Port'), 'office');
  assert.equal(categorize('Standing Desk 48 inch'), 'furniture');
});

test('extractProduct: a listing page (several distinct products) is not a product page; variants of a group are fine', () => {
  const two = `<script type="application/ld+json">${JSON.stringify([{ '@type': 'Product', name: 'A', offers: { price: '5', priceCurrency: 'USD' } }, { '@type': 'Product', name: 'B', offers: { price: '9', priceCurrency: 'USD' } }])}</script>`;
  assert.equal(extractProduct(two), null);
  const group = `<script type="application/ld+json">${JSON.stringify({ '@type': 'ProductGroup', name: 'Hoodie', hasVariant: [{ '@type': 'Product', name: 'Hoodie - Red', offers: { price: '30', priceCurrency: 'USD' } }, { '@type': 'Product', name: 'Hoodie - Blue', offers: { price: '32', priceCurrency: 'USD' } }], offers: { price: '30', priceCurrency: 'USD' } })}</script>`;
  assert.equal(extractProduct(group).price_cents, 3000);
});

test('extractProduct: JSON-LD variants and rejects unusable markup', () => {
  assert.equal(extractProduct(ld('9.99')).price_cents, 999);
  assert.equal(extractProduct('<html></html>'), null);
  const agg = `<script type="application/ld+json">{"@type":"Product","name":"A","category":["Home","Lamps"],"offers":{"@type":"AggregateOffer","lowPrice":"12.5","highPrice":"20","priceCurrency":"USD"}}</script>`;
  assert.equal(extractProduct(agg).price_cents, 1250);
  assert.equal(extractProduct(agg).category, 'Home Lamps');
  assert.equal(extractProduct('<script type="application/ld+json">{not json</script>'), null);
});

test('SSRF guard: private ranges, non-https, credentials, odd ports and private DNS answers are refused', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0']) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
  config.web.allowPrivate = false;
  try {
    for (const url of [`${origin}/lamp`, 'http://example.com/', 'https://user:pw@example.com/', 'https://example.com:8443/', 'https://localhost/', 'https://169.254.169.254/latest/meta-data/', 'https://[::1]/', 'https://10.0.0.5/admin']) {
      await assert.rejects(() => safeGet(url), FetchBlocked, url);
    }
    await assert.rejects(() => safeGet('https://localhost./'), (e) => /private address/.test(e.message));
  } finally { config.web.allowPrivate = true; }
});

test('a model turn with several searches runs them concurrently and returns results in call order', async () => {
  reset();
  tavilyResults = ['/lamp', '/mouse', '/big'];
  const { ensureSession } = await import('../src/purchases.js');
  const { runToolBatch } = await import('../src/tools.js');
  const sid = await ensureSession();
  const out = await runToolBatch(sid, [
    { name: 'search_products', input: { query: 'batch one' } },
    { name: 'get_mandate', input: {} },
    { name: 'search_products', input: { query: 'batch two' } },
  ]);
  assert.deepEqual(out.map((o) => o.step.tool), ['search_products', 'get_mandate', 'search_products']);
  assert.equal(out[0].result.offers.length, 3);
  assert.ok(out[0].result.offers.every((o) => typeof o.fits_mandate === 'boolean'));
  assert.equal(out[1].result.budget_usd, 300);
  assert.equal(calls.tavily, 2);
});
