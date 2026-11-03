// Central, validated configuration. Secrets only ever come from the environment.
import path from 'node:path';

const env = process.env;
const mode = (env.PAYPAL_MODE || 'sandbox').toLowerCase();
if (!['sandbox', 'mock'].includes(mode)) {
  throw new Error(`PAYPAL_MODE must be "sandbox" or "mock" (got "${mode}"). Live mode is intentionally unsupported.`);
}

const port = Number(env.PORT || 3000);

export const config = {
  port,
  publicUrl: env.PUBLIC_URL || `http://localhost:${port}`,
  dbPath: env.DATABASE_PATH === ':memory:' ? ':memory:' : path.resolve(env.DATABASE_PATH || './data/mandate.db'),
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
};

export function paypalConfigured() {
  return Boolean(config.paypal.clientId && config.paypal.clientSecret);
}
