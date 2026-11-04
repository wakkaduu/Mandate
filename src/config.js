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
    // First model is preferred; the rest are tried on overload (503/429) or a retired model (404).
    models: (env.GEMINI_MODEL || 'gemini-3.5-flash,gemini-3.1-flash-lite,gemini-flash-latest,gemini-3.8-flash').split(',').map((s) => s.trim()).filter(Boolean),
  },
  // auto: Gemini if its key is set, else Claude if its key is set, else the built-in rule-based agent
  aiProvider: (env.AI_PROVIDER || 'auto').toLowerCase(),
};

export function paypalConfigured() {
  return Boolean(config.paypal.clientId && config.paypal.clientSecret);
}
