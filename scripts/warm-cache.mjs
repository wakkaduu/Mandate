#!/usr/bin/env node
// Pre-warm the web-search cache before a demo or the judging period:
//   node scripts/warm-cache.mjs https://<your-service>.onrender.com ["extra query" ...]
// Runs the demo's product searches through POST /api/search, so the first judge to click them gets an instant,
// provider-free answer. Needs a persistent database (Turso) on the host, otherwise the cache dies with the instance.
// Spends ~2 search credits per query (1 Tavily + 1 Serper) and counts toward WEB_SEARCHES_PER_DAY.
const base = (process.argv[2] || process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const extra = process.argv.slice(3);
const queries = [
  ['LED desk lamp', 60], ['mechanical keyboard', 120], ['large desk mat', 120], ['ergonomic vertical mouse', 120],
  ['USB-C hub', 120], ['27 inch 4K monitor', undefined], ['noise cancelling headphones', 120], ...extra.map((q) => [q, undefined]),
];
let cookie = '';
let ok = 0;
for (const [query, max] of queries) {
  const res = await fetch(`${base}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ query, ...(max ? { max_price_usd: max } : {}) }),
    signal: AbortSignal.timeout(90_000),
  }).catch((e) => ({ status: 0, headers: new Headers(), json: async () => ({ error: { message: e.message } }) }));
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const j = await res.json().catch(() => ({}));
  const n = j.offers?.length ?? 0;
  if (res.status === 200) ok++;
  console.log(`${res.status === 200 ? 'ok  ' : 'FAIL'} ${query}${max ? ` (<= $${max})` : ''}: ${res.status === 200 ? `${n} offer${n === 1 ? '' : 's'}` : j.error?.message ?? res.status}`);
  await new Promise((r) => setTimeout(r, 1500)); // stay under the per-session rate limit (10/min)
}
console.log(`\n${ok}/${queries.length} searches cached.`);
process.exit(ok ? 0 : 1);
