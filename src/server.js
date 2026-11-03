import express from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config, paypalConfigured } from './config.js';
import { openDb, getDb, closeDb } from './db.js';
import * as svc from './purchases.js';
import { AppError } from './purchases.js';
import { chat, agentMode } from './agent.js';
import { verifyWebhook } from './paypal.js';
import { createMockPayPal } from './mock-paypal.js';
import { createMcpRouter } from './mcp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = 'mandate_sid';

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
  openDb();
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

  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY' });
    next();
  });

  app.get('/healthz', (_req, res) => {
    try { getDb().prepare('SELECT 1').get(); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
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
      const result = svc.applyWebhookEvent(event);
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
  app.use('/api', (req, res, next) => {
    // Header-based (not body-based) so body-less POST/DELETE from API clients work, while cross-site form posts are still rejected.
    if (req.method !== 'GET' && req.method !== 'HEAD' && !/^application\/json/i.test(req.headers['content-type'] ?? '')) {
      return sendError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
    }
    const existing = parseCookies(req.headers.cookie)[COOKIE];
    const sid = svc.ensureSession(existing);
    if (sid !== existing) {
      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      res.append('Set-Cookie', `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}${secure ? '; Secure' : ''}`);
    }
    req.sid = sid;
    next();
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  app.get('/api/config', (_req, res) => {
    res.json({
      paypalMode: config.paypal.mode,
      paypalClientId: config.paypal.clientId,
      paypalConfigured: paypalConfigured(),
      currency: config.paypal.currency,
      agentMode: agentMode(),
      model: agentMode() === 'claude' ? config.anthropic.model : null,
      webhooks: Boolean(config.paypal.webhookId),
    });
  });

  app.get('/api/state', (req, res) => {
    res.json({
      mandate: svc.getMandate(req.sid),
      purchases: svc.listPurchases(req.sid),
      audit: svc.listAudit(req.sid),
      messages: svc.listMessages(req.sid),
      categories: svc.listCategories(),
    });
  });

  // ---- connect external agents (MCP)
  const mcpUrl = (req) => `${(req.headers['x-forwarded-proto'] || req.protocol)}://${req.get('host')}/mcp`;
  app.get('/api/connect', (req, res) => res.json({ url: mcpUrl(req), connected: svc.hasMcpToken(req.sid) }));
  app.post('/api/connect', (req, res) => res.json({ url: mcpUrl(req), token: svc.issueMcpToken(req.sid), connected: true }));
  app.delete('/api/connect', (req, res) => { svc.revokeMcpToken(req.sid); res.json({ connected: false }); });

  app.get('/api/products', (_req, res) => res.json({ products: svc.allProducts() }));

  app.put('/api/mandate', (req, res) => {
    const b = req.body ?? {};
    res.json({ mandate: svc.updateMandate(req.sid, {
      name: b.name, budget_cents: b.budget_cents, per_item_cap_cents: b.per_item_cap_cents, categories: b.categories,
      expires_at: b.expires_at, max_per_hour: b.max_per_hour,
    }) });
  });

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

  app.post('/api/purchases/:id/capture', wrap(async (req, res) => res.json(await svc.capturePurchase(req.sid, req.params.id))));
  app.post('/api/purchases/:id/cancel', (req, res) => res.json({ purchase: svc.cancelPurchase(req.sid, req.params.id) }));
  app.post('/api/purchases/:id/refund', wrap(async (req, res) => res.json({ purchase: await svc.refundPurchase(req.sid, req.params.id) })));
  app.post('/api/purchases/:id/rerequest', wrap(async (req, res) => {
    const old = svc.getPurchase(req.sid, req.params.id);
    if (!['declined', 'cancelled', 'expired', 'failed'].includes(old.status)) throw new AppError(409, 'BAD_STATE', `A ${old.status} purchase cannot be re-requested.`);
    res.json(await svc.proposePurchase(req.sid, { product_id: old.product_id, qty: old.qty, rationale: `Re-request of earlier ${old.status} purchase.` }));
  }));
  app.post('/api/reset', (req, res) => res.json({ mandate: svc.resetSession(req.sid) }));

  app.use('/api', (_req, res) => sendError(res, 404, 'NOT_FOUND', 'Not found'));

  // ---- static
  app.use('/vendor/ag-grid', express.static(path.join(here, '..', 'node_modules', 'ag-grid-community', 'dist'), { maxAge: '7d' }));
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
      console.log(`Mandate listening on :${actual}  paypal=${config.paypal.mode}${paypalConfigured() ? '' : ' (NOT CONFIGURED - set PAYPAL_CLIENT_ID/SECRET)'}  agent=${agentMode()}`);
      resolve(server);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().then((server) => {
    // Graceful shutdown (Render sends SIGTERM on deploy/scale-down): stop accepting, finish in-flight, close DB.
    const stop = () => { server.close(() => { closeDb(); process.exit(0); }); setTimeout(() => process.exit(0), 8000).unref(); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  });
}
