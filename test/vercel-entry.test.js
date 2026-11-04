// The Vercel entry point is just the Express app as a request handler. Check it boots and serves requests the way
// the platform invokes it (a plain (req, res) function), against a fresh database.
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.LOG_REQUESTS = '0';
process.env.PAYPAL_MODE = 'mock';
process.env.DATABASE_PATH = path.join(os.tmpdir(), `mandate-vercel-${process.pid}-${Date.now()}.db`);
delete process.env.GEMINI_API_KEY; delete process.env.ANTHROPIC_API_KEY;

const { default: handler } = await import('../api/index.js');

test('api/index.js exports a handler that serves health, config and a session', async () => {
  assert.equal(typeof handler, 'function');
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true });
  const state = await fetch(`${base}/api/state`);
  assert.equal(state.status, 200);
  assert.ok(state.headers.get('set-cookie').includes('HttpOnly'));
  const { mandate } = await state.json();
  assert.equal(mandate.configured, false, 'a new session has no mandate until its owner sets one up');
  assert.equal(mandate.budget_cents, 0);
  server.close();
});
