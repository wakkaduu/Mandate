// Thin, dependency-free client for the documented PayPal REST endpoints we use:
//   POST /v1/oauth2/token                              (client-credentials)
//   POST /v2/checkout/orders                           (create order, server-side)
//   GET  /v2/checkout/orders/{id}                      (verify order state)
//   POST /v2/checkout/orders/{id}/capture              (capture after buyer approval)
//   POST /v2/payments/captures/{id}/refund             (refund a capture)
//   POST /v1/notifications/verify-webhook-signature    (webhook authenticity)
// Sandbox host only (see config.js). Amounts are always supplied by the server, never the browser.
import { config, paypalConfigured } from './config.js';
import { centsToValue } from './policy.js';

export class PayPalError extends Error {
  constructor(message, { status, name, issues = [], debugId } = {}) {
    super(message);
    this.name = 'PayPalError';
    this.status = status;
    this.paypalName = name;
    this.issues = issues; // e.g. ['INSTRUMENT_DECLINED']
    this.debugId = debugId;
  }
  hasIssue(issue) {
    return this.issues.includes(issue);
  }
}

let tokenCache = { value: null, expiresAt: 0 };

export function resetTokenCache() {
  tokenCache = { value: null, expiresAt: 0 };
}

async function getAccessToken() {
  if (!paypalConfigured()) {
    throw new PayPalError('PayPal sandbox credentials are not configured (set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET, or use PAYPAL_MODE=mock).');
  }
  if (tokenCache.value && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.value;
  const { clientId, clientSecret, apiBase } = config.paypal;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(`${apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new PayPalError('PayPal authentication failed - check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (sandbox).', {
      status: res.status, name: body.error, issues: [body.error].filter(Boolean),
    });
  }
  tokenCache = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 300) * 1000 };
  return tokenCache.value;
}

async function api(method, path, { body, requestId } = {}) {
  const token = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (requestId) headers['PayPal-Request-Id'] = requestId; // idempotency key
  const res = await fetch(`${config.paypal.apiBase}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    throw new PayPalError(json.message || `PayPal ${method} ${path} failed (${res.status})`, {
      status: res.status,
      name: json.name,
      issues: (json.details || []).map((d) => d.issue).filter(Boolean),
      debugId: json.debug_id,
    });
  }
  return json;
}

/** Create an order for one purchase. Idempotent per purchase via PayPal-Request-Id + unique invoice_id. */
export function createOrder(purchase) {
  const currency = config.paypal.currency;
  const unit = centsToValue(purchase.amount_cents / purchase.qty);
  const total = centsToValue(purchase.amount_cents);
  return api('POST', '/v2/checkout/orders', {
    requestId: `mandate-create-${purchase.id}`,
    body: {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: purchase.id,
        custom_id: purchase.id,
        invoice_id: `MANDATE-${purchase.id}`,
        description: `${purchase.product_name} (agent purchase)`.slice(0, 127),
        amount: {
          currency_code: currency,
          value: total,
          breakdown: { item_total: { currency_code: currency, value: total } },
        },
        items: [{
          name: purchase.product_name.slice(0, 127),
          sku: purchase.product_id.slice(0, 127),
          quantity: String(purchase.qty),
          category: 'PHYSICAL_GOODS',
          unit_amount: { currency_code: currency, value: unit },
        }],
      }],
    },
  });
}

export function getOrder(orderId) {
  return api('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
}

export function captureOrder(orderId, purchaseId) {
  return api('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    requestId: `mandate-capture-${purchaseId}`,
    body: {},
  });
}

export function refundCapture(captureId, purchase) {
  return api('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    requestId: `mandate-refund-${purchase.id}`,
    body: {
      amount: { currency_code: config.paypal.currency, value: centsToValue(purchase.amount_cents) },
      note_to_payer: 'Refund requested from Mandate',
    },
  });
}

/**
 * Verify a webhook via PayPal's verify-webhook-signature endpoint.
 * `rawBody` must be the exact bytes PayPal sent (we embed it verbatim; re-serialising would break the signature).
 */
export async function verifyWebhook(headers, rawBody) {
  const { webhookId } = config.paypal;
  if (!webhookId) throw new PayPalError('PAYPAL_WEBHOOK_ID is not configured; webhook verification unavailable.');
  const h = (k) => headers[k.toLowerCase()];
  const required = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];
  if (required.some((k) => !h(k))) return false;
  const token = await getAccessToken();
  const payload =
    `{"auth_algo":${JSON.stringify(h('paypal-auth-algo'))},` +
    `"cert_url":${JSON.stringify(h('paypal-cert-url'))},` +
    `"transmission_id":${JSON.stringify(h('paypal-transmission-id'))},` +
    `"transmission_sig":${JSON.stringify(h('paypal-transmission-sig'))},` +
    `"transmission_time":${JSON.stringify(h('paypal-transmission-time'))},` +
    `"webhook_id":${JSON.stringify(webhookId)},` +
    `"webhook_event":${rawBody}}`;
  const res = await fetch(`${config.paypal.apiBase}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: payload,
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({}));
  return res.ok && json.verification_status === 'SUCCESS';
}

/** Pull the first capture out of an order/capture response. */
export function firstCapture(order) {
  return order?.purchase_units?.[0]?.payments?.captures?.[0] ?? null;
}
