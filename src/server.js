import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config, paypalConfigured, searchProviders } from './config.js';
import { openDb, db, closeDb } from './db.js';
import * as svc from './purchases.js';
import { AppError } from './purchases.js';
import { runTool } from './tools.js';
import { chat, agentMode, agentModel } from './agent.js';
import { verifyWebhook } from './paypal.js';
import { createMockPayPal } from './mock-paypal.js';
import { createMcpRouter } from './mcp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = 'mandate_sid';
const appVersion = (() => { try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return null; } })();

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2).map(([k, v]) => [k, decodeURIComponent(v)]));
}

/** Simple in-memory sliding-window limiter (protects the AI key and PayPal quota). */
function limiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const t = Date.now();
    const arr = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return false; }
    arr.push(t);
    hits.set(key, arr);
    return true;
  };
}

/** One error envelope for the whole API: { error: { code, message, requestId } } */
function sendError(res, status, code, message) {
  res.status(status).json({ error: { code, message, requestId: res.req?.id } });
}

export function createApp() {
  const dbReady = openDb(); // one-time schema check; every request waits for it (matters on serverless cold starts)
  dbReady.catch((e) => console.error('[db] initialisation failed:', e.message));
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Correlation id on every request/response/log line (honours an inbound X-Request-Id from a proxy).
  app.use((req, res, next) => {
    const inbound = String(req.headers['x-request-id'] || '');
    req.id = /^[\w-]{8,64}$/.test(inbound) ? inbound : randomUUID();
    res.set('X-Request-Id', req.id);
    const started = Date.now();
    res.on('finish', () => {
      if (!req.path.startsWith('/api') || process.env.LOG_REQUESTS === '0') return;
      console.log(JSON.stringify({ t: new Date().toISOString(), id: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started }));
    });
    next();
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY' });
    next();
  });

  app.use(async (_req, _res, next) => { try { await dbReady; next(); } catch (e) { next(e); } });

  app.get('/healthz', async (_req, res) => {
    try { await (await db()).get('SELECT 1 AS ok'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });

  // ---- PayPal webhook: raw body (signature covers exact bytes) - must precede express.json()
  app.post('/api/paypal/webhook', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
    if (!config.paypal.webhookId) return sendError(res, 503, 'WEBHOOK_NOT_CONFIGURED', 'Webhook verification is not configured (PAYPAL_WEBHOOK_ID).');
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    let event;
    try { event = JSON.parse(raw); } catch { return sendError(res, 400, 'INVALID_JSON', 'Invalid JSON'); }
    try {
      const ok = await verifyWebhook(req.headers, raw);
      if (!ok) return sendError(res, 401, 'INVALID_SIGNATURE', 'Invalid webhook signature');
      const result = await svc.applyWebhookEvent(event);
      return res.json({ received: true, ...result });
    } catch (e) {
      console.error('[webhook]', e.message);
      return sendError(res, 500, 'WEBHOOK_FAILED', 'Webhook processing failed'); // PayPal retries non-2xx
    }
  });

  if (config.paypal.mode === 'mock') app.use('/mock-paypal', createMockPayPal());

  app.use('/mcp', createMcpRouter());

  app.use(express.json({ limit: '16kb' }));

  // ---- session cookie
  app.use('/api', async (req, res, next) => {
    // Header-based (not body-based) so body-less POST/DELETE from API clients work, while cross-site form posts are still rejected.
    if (req.method !== 'GET' && req.method !== 'HEAD' && !/^application\/json/i.test(req.headers['content-type'] ?? '')) {
      return sendError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
    }
    try {
      const existing = parseCookies(req.headers.cookie)[COOKIE];
      const sid = await svc.ensureSession(existing);
      if (sid !== existing) {
        const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
        res.append('Set-Cookie', `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}${secure ? '; Secure' : ''}`);
      }
      req.sid = sid;
      next();
    } catch (e) { next(e); }
  });

    app.get('/api/config', (_req, res) => {
    res.json({
      paypalMode: config.paypal.mode,
      paypalClientId: config.paypal.clientId,
      paypalConfigured: paypalConfigured(),
      currency: config.paypal.currency,
      agentMode: agentMode(),
      webSearch: searchProviders().length > 0,
      searchProviders: searchProviders(),
      models: config.gemini.models,
      strictPrices: !config.web.allowUnverifiedPrices,
      searchCacheMinutes: Math.round(config.web.searchCacheMs / 60_000),
      searchesPerDay: config.web.searchesPerDay,
      mcpPath: '/mcp',
      version: appVersion,
      model: agentModel(),
      webhooks: Boolean(config.paypal.webhookId),
      persistent: config.dbPersistent,
      host: config.onVercel ? 'vercel' : 'node',
    });
  });

  app.get('/api/state', wrap(async (req, res) => {
    const [mandate, purchases, audit, messages] = await Promise.all([
      svc.getMandate(req.sid), svc.listPurchases(req.sid), svc.listAudit(req.sid), svc.listMessages(req.sid),
    ]);
    res.json({ mandate, purchases, audit, messages, categories: svc.listCategories() });
  }));

  // ---- connect external agents (MCP)
  const mcpUrl = (req) => `${(req.headers['x-forwarded-proto'] || req.protocol)}://${req.get('host')}/mcp`;
  app.get('/api/connect', wrap(async (req, res) => res.json({ url: mcpUrl(req), connected: await svc.hasMcpToken(req.sid) })));
  app.post('/api/connect', wrap(async (req, res) => res.json({ url: mcpUrl(req), token: await svc.issueMcpToken(req.sid), connected: true })));
  app.delete('/api/connect', wrap(async (req, res) => { await svc.revokeMcpToken(req.sid); res.json({ connected: false }); }));

  app.put('/api/mandate', wrap(async (req, res) => {
    const b = req.body ?? {};
    res.json({ mandate: await svc.updateMandate(req.sid, {
      name: b.name, budget_cents: b.budget_cents, per_item_cap_cents: b.per_item_cap_cents, categories: b.categories,
      expires_at: b.expires_at, max_per_hour: b.max_per_hour,
    }) });
  }));

  const chatLimit = limiter(12, 60_000);
  const globalChatLimit = limiter(400, 3600_000);
  const busy = new Set();
  app.post('/api/chat', wrap(async (req, res) => {
    if (!chatLimit(req.sid) || !globalChatLimit('all')) throw new AppError(429, 'RATE_LIMITED', 'Too many requests - give the agent a moment.');
    const message = typeof req.body?.message === 'string' ? req.body.message : '';
    if (busy.has(req.sid)) throw new AppError(429, 'BUSY', 'The agent is still working on your previous request.');
    busy.add(req.sid);
    try {
      res.json(await chat(req.sid, message));
    } finally {
      busy.delete(req.sid);
    }
  }));

  // Manual path: the human searches the web themselves (works even when the AI model is down) and asks for a
  // purchase. It goes through exactly the same offers, policy gate and PayPal approval as an agent's request.
  const searchLimit = limiter(10, 60_000);
  app.post('/api/search', wrap(async (req, res) => {
    if (!searchLimit(req.sid) || !globalChatLimit('search')) throw new AppError(429, 'RATE_LIMITED', 'Too many searches - give it a moment.');
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (query.length < 2 || query.length > 120) throw new AppError(400, 'BAD_INPUT', 'Search text must be 2 to 120 characters.');
    const max = req.body?.max_price_usd;
    if (max !== undefined && max !== null && !(typeof max === 'number' && max > 0 && max <= 10000)) throw new AppError(400, 'BAD_INPUT', 'Maximum price must be between $0 and $10,000.');
    const { result, step } = await runTool(req.sid, 'search_products', { query, max_price_usd: max ?? undefined });
    if (result.error) throw new AppError(503, 'SEARCH_UNAVAILABLE', result.error);
    await svc.audit(req.sid, null, 'search.manual', `You: ${step.text}`);
    res.json({ offers: result.offers, skipped: result.skipped ?? null });
  }));
  app.post('/api/offers/:id/request', wrap(async (req, res) => {
    const qty = Number.isInteger(req.body?.qty) ? req.body.qty : 1;
    res.json(await svc.proposePurchase(req.sid, { product_id: req.params.id, qty, rationale: 'Requested by you from the search results.' }));
  }));

  app.post('/api/purchases/:id/capture', wrap(async (req, res) => res.json(await svc.capturePurchase(req.sid, req.params.id))));
  app.post('/api/purchases/:id/cancel', wrap(async (req, res) => res.json({ purchase: await svc.cancelPurchase(req.sid, req.params.id) })));
  app.post('/api/purchases/:id/refund', wrap(async (req, res) => res.json({ purchase: await svc.refundPurchase(req.sid, req.params.id) })));
  app.post('/api/purchases/:id/rerequest', wrap(async (req, res) => {
    const old = await svc.getPurchase(req.sid, req.params.id);
    if (!['declined', 'cancelled', 'expired', 'failed'].includes(old.status)) throw new AppError(409, 'BAD_STATE', `A ${old.status} purchase cannot be re-requested.`);
    res.json(await svc.proposePurchase(req.sid, { product_id: old.product_id, qty: old.qty, rationale: `Re-request of earlier ${old.status} purchase.` }));
  }));
  app.post('/api/reset', wrap(async (req, res) => res.json({ mandate: await svc.resetSession(req.sid) })));

  app.use('/api', (_req, res) => sendError(res, 404, 'NOT_FOUND', 'Not found'));

  // ---- static
  // public/vendor/ag-grid is copied from node_modules by scripts/copy-vendor.mjs (postinstall / build)
  app.use(express.static(path.join(here, '..', 'public'), { maxAge: 0 }));

  // ---- errors
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return sendError(res, err.status, err.code, err.message);
    if (err?.type === 'entity.parse.failed') return sendError(res, 400, 'INVALID_JSON', 'Invalid JSON body');
    if (err?.type === 'entity.too.large') return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
    console.error('[error]', req.id, err);
    sendError(res, 500, 'INTERNAL', 'Something went wrong.');
  });

  return app;
}

export function start(port = config.port) {
  const app = createApp();
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      const actual = server.address().port;
      if (config.paypal.mode === 'mock') config.paypal.apiBase = `http://127.0.0.1:${actual}/mock-paypal`;
      console.log(`Mandate listening on :${actual}  paypal=${config.paypal.mode}${paypalConfigured() ? '' : ' (NOT CONFIGURED - set PAYPAL_CLIENT_ID/SECRET)'}  agent=${agentMode()}${agentModel() ? `(${agentModel()})` : ''}`);
      resolve(server);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().then((server) => {
    // Graceful shutdown (Render sends SIGTERM on deploy/scale-down): stop accepting, finish in-flight, close DB.
    const stop = () => { server.close(async () => { await closeDb(); process.exit(0); }); setTimeout(() => process.exit(0), 8000).unref(); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  });
}
