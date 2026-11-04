// Central, validated configuration. Secrets only ever come from the environment.
import path from 'node:path';

const env = process.env;
const mode = (env.PAYPAL_MODE || 'sandbox').toLowerCase();
if (!['sandbox', 'mock'].includes(mode)) {
  throw new Error(`PAYPAL_MODE must be "sandbox" or "mock" (got "${mode}"). Live mode is intentionally unsupported.`);
}

const port = Number(env.PORT || 3000);

// Never run the PayPal simulator in a production deployment (it is for offline dev and automated tests only).
if (mode === 'mock' && env.NODE_ENV === 'production' && env.ALLOW_MOCK !== '1') {
  throw new Error('PAYPAL_MODE=mock is not allowed when NODE_ENV=production. Use PAYPAL_MODE=sandbox with real sandbox credentials.');
}

// Test-only escape hatch: lets product-page fetches reach 127.0.0.1 stubs. Never allowed in production.
if (env.WEB_ALLOW_PRIVATE_HOSTS === '1' && env.NODE_ENV === 'production') {
  throw new Error('WEB_ALLOW_PRIVATE_HOSTS=1 is not allowed when NODE_ENV=production (it disables the SSRF guard).');
}

const dbPath = env.DATABASE_PATH === ':memory:' ? ':memory:' : path.resolve(env.DATABASE_PATH || './data/mandate.db');
const dbUrl = env.TURSO_DATABASE_URL || (dbPath === ':memory:' ? ':memory:' : `file:${dbPath}`);

export const config = {
  port,
  publicUrl: env.PUBLIC_URL || `http://localhost:${port}`,
  dbPath,
  dbUrl,
  dbAuthToken: env.TURSO_AUTH_TOKEN || '',
  // Serverless filesystems are ephemeral and per-instance: without a remote DB, state would vanish between requests.
  dbPersistent: !(env.VERCEL && dbUrl.startsWith('file:')),
  onVercel: Boolean(env.VERCEL),
  paypal: {
    mode,
    clientId: env.PAYPAL_CLIENT_ID || (mode === 'mock' ? 'mock-client-id' : ''),
    clientSecret: env.PAYPAL_CLIENT_SECRET || (mode === 'mock' ? 'mock-secret' : ''),
    webhookId: env.PAYPAL_WEBHOOK_ID || '',
    // Sandbox host only. In mock mode the base is rewritten to the in-process simulator.
    apiBase: mode === 'mock' ? `http://127.0.0.1:${port}/mock-paypal` : 'https://api-m.sandbox.paypal.com',
    currency: 'USD',
  },
  anthropic: {
    apiKey: env.ANTHROPIC_API_KEY || '',
    model: env.ANTHROPIC_MODEL || 'claude-opus-5-5',
  },
  gemini: {
    apiKey: env.GEMINI_API_KEY || '',
    baseUrl: env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
    // First model is preferred (flash-lite: ~1s per call vs ~12s for 3.5-flash on the same prompt, and a shopping turn makes several calls); the rest are tried on overload (503/429) or a retired model (404).
    models: (env.GEMINI_MODEL || 'gemini-3.1-flash-lite,gemini-3.5-flash,gemini-flash-latest,gemini-3.8-flash').split(',').map((s) => s.trim()).filter(Boolean),
  },
  search: {
    // Providers are tried in this order until one yields at least one server-verified offer.
    providers: (env.SEARCH_PROVIDERS || 'tavily,serper,gemini').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
    tavilyKey: env.TAVILY_API_KEY || '',
    tavilyBase: env.TAVILY_BASE_URL || 'https://api.tavily.com',
    serperKey: env.SERPER_API_KEY || '',
    serperBase: env.SERPER_BASE_URL || 'https://google.serper.dev',
  },
  web: {
    allowPrivate: env.WEB_ALLOW_PRIVATE_HOSTS === '1',
    // Strict by default: only offers whose price the server read from the retailer's own page can be bought.
    allowUnverifiedPrices: env.ALLOW_UNVERIFIED_PRICES === '1',
    maxPerHost: Number(env.WEB_MAX_OFFERS_PER_HOST || 2), // keeps one retailer from filling the result list
    // Free search tiers are small (Tavily ~1000 credits/month): cache repeats and cap real provider searches per day.
    searchCacheMs: Number(env.WEB_SEARCH_CACHE_MINUTES || 30) * 60_000,
    searchesPerDay: Number(env.WEB_SEARCHES_PER_DAY || 150),
    searchPerHour: Number(env.WEB_SEARCHES_PER_HOUR || 30),
  },
  // auto: Gemini if its key is set, else Claude if its key is set, else the built-in rule-based agent
  aiProvider: (env.AI_PROVIDER || 'auto').toLowerCase(),
};

/** Search providers that have credentials, in the order they will be tried. */
export function searchProviders() {
  const have = { tavily: Boolean(config.search.tavilyKey), serper: Boolean(config.search.serperKey), gemini: Boolean(config.gemini.apiKey) };
  return config.search.providers.filter((p) => have[p]);
}

export function paypalConfigured() {
  return Boolean(config.paypal.clientId && config.paypal.clientSecret);
}
