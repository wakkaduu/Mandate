import os from 'node:os';
import path from 'node:path';
// Test harness: boots the real app against the in-process PayPal simulator and an in-memory DB.
process.env.LOG_REQUESTS = '0';
process.env.PAYPAL_MODE = 'mock';
process.env.DATABASE_PATH = path.join(os.tmpdir(), `mandate-test-${process.pid}-${Date.now()}.db`);
process.env.PAYPAL_WEBHOOK_ID = 'WH-TEST';
process.env.REFUND_COOLING_OFF_SECONDS = '0'; // the cooling-off itself is tested explicitly in flow.test.js
process.env.WEB_ALLOW_PRIVATE_HOSTS = '1'; // product-page stubs live on 127.0.0.1 (refused when NODE_ENV=production)
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GEMINI_API_KEY;

const { start } = await import('../src/server.js');

export async function boot() {
  const { seedOffers } = await import('./fixtures.js');
  await seedOffers();
  const server = await start(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, close: () => new Promise((r) => server.close(r)) };
}

/**
 * The mandate most tests run under. The app has NO built-in budget: a new session must be set up by its owner, so the
 * test client does that on first use (pass { setup: false } to get a raw, never-configured session).
 */
export const TEST_MANDATE = { name: 'Home office refresh', budget_cents: 30000, per_item_cap_cents: 12000, categories: ['office', 'electronics', 'home'], max_per_hour: 6 };

/** Minimal cookie-jar client. */
export function client(base, { setup = true } = {}) {
  let cookie = '';
  let ready = !setup;
  async function send(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  }
  async function call(method, path, body, headers) {
    if (!ready) {
      ready = true;
      await send('GET', '/api/state'); // creates the session
      const r = await send('POST', '/api/mandate/setup', TEST_MANDATE);
      if (r.status !== 200) throw new Error(`test mandate setup failed: ${JSON.stringify(r.body)}`);
    }
    return send(method, path, body, headers);
  }
  return {
    sid: () => cookie.split('=')[1],
    get: (p) => call('GET', p),
    post: (p, b = {}) => call('POST', p, b),
    put: (p, b) => call('PUT', p, b),
    raw: call,
  };
}

export const approve = (base, orderId, outcome = 'ok') =>
  fetch(`${base}/mock-paypal/_sim/approve/${orderId}?outcome=${outcome}`, { method: 'POST' }).then((r) => r.json());

/** Ask for purchases the way an agent does (through the policy gate), without an LLM. */
export async function buy(c, ...items) {
  const svc = await import('../src/purchases.js');
  await c.get('/api/state'); // establishes the session cookie
  const out = [];
  for (const it of items) {
    const [id, qty = 1] = Array.isArray(it) ? it : [it];
    out.push(await svc.proposePurchase(c.sid(), { product_id: id, qty, rationale: 'test' }));
  }
  return out;
}
