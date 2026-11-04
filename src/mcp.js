// Mandate as an MCP server (Streamable HTTP, JSON responses, stateless).
// Any MCP-capable agent can search the catalog and *request* purchases; every request is checked by the same
// policy engine and, if allowed, becomes a PayPal order that the HUMAN approves in the Mandate UI.
// Auth: `Authorization: Bearer mnd_...` (token created in the UI; it maps to one demo session/mandate).
import express from 'express';
import { TOOLS, runTool } from './tools.js';
import { sessionForMcpToken, audit } from './purchases.js';

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const buckets = new Map();

function allow(key, max = 60, windowMs = 60_000) {
  const t = Date.now();
  const arr = (buckets.get(key) ?? []).filter((x) => t - x < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return false; }
  arr.push(t); buckets.set(key, arr);
  return true;
}

async function handle(sid, msg) {
  const { id, method, params } = msg ?? {};
  if (msg?.jsonrpc !== '2.0' || typeof method !== 'string') return rpcError(id, -32600, 'Invalid Request');
  const isNotification = id === undefined;
  switch (method) {
    case 'initialize': {
      const wanted = params?.protocolVersion;
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: SUPPORTED.includes(wanted) ? wanted : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'mandate', title: 'Mandate - spend rails for AI agents', version: '1.0.0' },
          instructions: 'You shop on behalf of a human under a spending mandate. Use search_catalog, then propose_purchase. You cannot spend money: allowed proposals become PayPal orders the human approves; blocked ones return a reason. Never try to bypass a block.',
        },
      };
    }
    case 'ping': return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) } };
    case 'tools/call': {
      const name = params?.name;
      if (!TOOLS.some((t) => t.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const { result, step } = await runTool(sid, name, params?.arguments ?? {});
      await audit(sid, null, 'mcp.tool_call', `External agent: ${step.text}`);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError: Boolean(result.error) } };
    }
    default:
      return isNotification ? null : rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export function createMcpRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  router.post('/', async (req, res) => {
    const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const sid = token && await sessionForMcpToken(token);
    if (!sid) {
      res.set('WWW-Authenticate', 'Bearer realm="mandate"');
      return res.status(401).json(rpcError(null, -32001, 'Missing or invalid bearer token. Generate one in Mandate (Connect an agent).'));
    }
    if (!allow(sid)) return res.status(429).json(rpcError(null, -32002, 'Rate limit exceeded (60 requests/minute).'));
    try {
      const batch = Array.isArray(req.body);
      const out = (await Promise.all((batch ? req.body : [req.body]).map((m) => handle(sid, m)))).filter(Boolean);
      if (!out.length) return res.status(202).end(); // notifications only
      res.json(batch ? out : out[0]);
    } catch (e) {
      console.error('[mcp]', req.id, e);
      res.status(500).json(rpcError(null, -32603, 'Internal error'));
    }
  });

  // Streamable HTTP lets servers decline the optional SSE stream / session teardown.
  router.get('/', (_req, res) => res.status(405).set('Allow', 'POST').end());
  router.delete('/', (_req, res) => res.status(405).set('Allow', 'POST').end());
  return router;
}
