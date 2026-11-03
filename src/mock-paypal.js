// In-process PayPal SANDBOX SIMULATOR - used only when PAYPAL_MODE=mock (offline dev + automated tests).
// It mimics the shape/behaviour of the real endpoints we call (orders, capture, refund, webhook verify)
// including the failure modes we handle (declined instrument, already captured, not approved).
// It is NOT PayPal and is never mounted in sandbox mode. The real demo uses the real PayPal sandbox.
import express from 'express';
import { randomUUID } from 'node:crypto';

export function createMockPayPal() {
  const router = express.Router();
  router.use(express.json());
  const orders = new Map();
  const idempotency = new Map();
  const captures = new Map();
  let seq = 1000;

  const err = (res, status, name, issue, message) =>
    res.status(status).json({ name, message, debug_id: `mock-${randomUUID().slice(0, 8)}`, details: issue ? [{ issue, description: message }] : [] });

  router.post('/v1/oauth2/token', (req, res) => {
    if (!String(req.headers.authorization || '').startsWith('Basic ')) {
      return res.status(401).json({ error: 'invalid_client', error_description: 'Client Authentication failed' });
    }
    res.json({ access_token: `mock-token-${randomUUID()}`, token_type: 'Bearer', expires_in: 32400 });
  });

  router.use((req, res, next) => {
    if (req.path.startsWith('/_sim/') || req.path === '/v1/oauth2/token') return next();
    if (!String(req.headers.authorization || '').startsWith('Bearer mock-token-')) {
      return res.status(401).json({ name: 'AUTHENTICATION_FAILURE', message: 'Authentication failed due to invalid authentication credentials.' });
    }
    next();
  });

  router.post('/v2/checkout/orders', (req, res) => {
    const key = req.headers['paypal-request-id'];
    if (key && idempotency.has(key)) return res.status(201).json(orders.get(idempotency.get(key)));
    const unit = req.body?.purchase_units?.[0];
    const total = Number(unit?.amount?.value);
    const itemTotal = Number(unit?.amount?.breakdown?.item_total?.value);
    if (req.body?.intent !== 'CAPTURE' || !unit || !(total > 0)) {
      return err(res, 400, 'INVALID_REQUEST', 'MISSING_REQUIRED_PARAMETER', 'Request is not well-formed.');
    }
    if (itemTotal !== total) return err(res, 422, 'UNPROCESSABLE_ENTITY', 'AMOUNT_MISMATCH', 'Item total should equal sum of (unit_amount * quantity) across all items.');
    const id = `MOCKORDER${seq++}`;
    const order = {
      id, status: 'CREATED', intent: 'CAPTURE',
      purchase_units: [{ reference_id: unit.reference_id, custom_id: unit.custom_id, invoice_id: unit.invoice_id, amount: unit.amount, items: unit.items }],
      links: [{ href: `/mock-paypal/v2/checkout/orders/${id}`, rel: 'self', method: 'GET' }],
      _outcome: 'ok',
    };
    orders.set(id, order);
    if (key) idempotency.set(key, id);
    res.status(201).json(publicOrder(order));
  });

  router.get('/v2/checkout/orders/:id', (req, res) => {
    const o = orders.get(req.params.id);
    if (!o) return err(res, 404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'The specified resource does not exist.');
    res.json(publicOrder(o));
  });

  router.post('/v2/checkout/orders/:id/capture', (req, res) => {
    const o = orders.get(req.params.id);
    if (!o) return err(res, 404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'The specified resource does not exist.');
    if (o.status === 'COMPLETED') return err(res, 422, 'UNPROCESSABLE_ENTITY', 'ORDER_ALREADY_CAPTURED', 'Order already captured. If \'intent=CAPTURE\' only one capture per order is allowed.');
    if (o.status !== 'APPROVED') return err(res, 422, 'UNPROCESSABLE_ENTITY', 'ORDER_NOT_APPROVED', 'Payer has not yet approved the Order for payment.');
    if (o._outcome === 'decline') return err(res, 422, 'UNPROCESSABLE_ENTITY', 'INSTRUMENT_DECLINED', 'The instrument presented was either declined by the processor or bank, or it can\'t be used for this payment.');
    const unit = o.purchase_units[0];
    const capture = {
      id: `MOCKCAP${seq++}`, status: 'COMPLETED', amount: unit.amount, custom_id: unit.custom_id,
      invoice_id: unit.invoice_id, create_time: new Date().toISOString(),
    };
    captures.set(capture.id, { capture, order: o, refunded: false });
    o.status = 'COMPLETED';
    o.payer = { email_address: 'sb-buyer@personal.example.com', name: { given_name: 'Sandbox', surname: 'Buyer' } };
    o._capture = capture;
    res.status(201).json(publicOrder(o));
  });

  router.post('/v2/payments/captures/:id/refund', (req, res) => {
    const c = captures.get(req.params.id);
    if (!c) return err(res, 404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'The specified resource does not exist.');
    if (c.refunded) return err(res, 422, 'UNPROCESSABLE_ENTITY', 'CAPTURE_FULLY_REFUNDED', 'The capture has already been fully refunded.');
    c.refunded = true;
    res.status(201).json({ id: `MOCKREF${seq++}`, status: 'COMPLETED', amount: c.capture.amount });
  });

  // Mock verification rule: transmission_sig === 'valid-signature' passes. Anything else fails.
  router.post('/v1/notifications/verify-webhook-signature', (req, res) => {
    const ok = req.body?.transmission_sig === 'valid-signature' && req.body?.webhook_id && req.body?.webhook_event;
    res.json({ verification_status: ok ? 'SUCCESS' : 'FAILURE' });
  });

  // ---- Simulator controls (stand-in for the buyer's PayPal approval popup) ----
  router.post('/_sim/approve/:id', (req, res) => {
    const o = orders.get(req.params.id);
    if (!o) return res.status(404).json({ error: 'unknown order' });
    const outcome = req.query.outcome === 'decline' ? 'decline' : 'ok';
    o.status = 'APPROVED';
    o._outcome = outcome;
    res.json({ id: o.id, status: o.status, outcome });
  });

  return router;
}

function publicOrder(o) {
  const { _outcome, _capture, ...rest } = o;
  const out = structuredClone(rest);
  if (_capture) out.purchase_units[0].payments = { captures: [_capture] };
  return out;
}
