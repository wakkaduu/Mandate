// Gemini REST transport shared by the shopping agent loop and the web product search:
// per-model cooldowns, retries, and automatic fallback across the configured models.
import { config } from '../config.js';

// Whole chat must fit the host's request limit: Vercel functions are capped at 60s (vercel.json), other hosts can wait longer.
// Web searches take ~10s each, so a multi-item request needs the room.
export const deadlineMs = () => (config.onVercel ? 52_000 : 90_000);
const RETRYABLE = new Set([429, 500, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Per-model cooldowns: free-tier keys have per-model daily quotas, so once a model says 429 (or is overloaded)
// we skip it for a while instead of paying its latency on every request. Exported for tests/diagnostics.
export const cooldowns = new Map();
function parseRetrySeconds(json) {
  const info = (json.error?.details ?? []).find((d) => d.retryDelay);
  const s = info ? parseFloat(info.retryDelay) : NaN;
  return Number.isFinite(s) ? s : null;
}

async function generate(model, body, deadlineAt, scope) {
  const ck = scope ? `${model}|${scope}` : model;
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (Date.now() > deadlineAt) throw Object.assign(new Error('Gemini deadline exceeded'), { status: 504, model });
    let res;
    try {
      res = await fetch(`${config.gemini.baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': config.gemini.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(3000, Math.min(25_000, deadlineAt - Date.now()))),
      });
    } catch (e) {
      // A slow model is treated like an overloaded one: the caller moves on to the next model.
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw Object.assign(new Error('Gemini request timed out'), { status: 504, model });
      throw e;
    }
    const json = await res.json().catch(() => ({}));
    if (res.ok) return json;
    last = Object.assign(new Error(json.error?.message?.slice(0, 160) || `Gemini HTTP ${res.status}`), { status: res.status, model });
    if (res.status === 429) {
      const wait = parseRetrySeconds(json);
      cooldowns.set(ck, Date.now() + Math.min((wait ?? 60) * 1000, 6 * 3600_000));
      break; // quota: retrying the same model is pointless
    }
    if (!RETRYABLE.has(res.status)) break;
    if (res.status === 503) cooldowns.set(ck, Date.now() + 20_000);
    await sleep(500 * (attempt + 1));
  }
  throw last;
}

/**
 * Try the configured model, then the fallbacks, on overload / quota / retired-model errors.
 * `scope` keeps cooldowns of different kinds of call apart: Google Search grounding has its own (much smaller)
 * quota, and exhausting it must not put the plain chat model on cooldown.
 */
export async function generateWithFallback(body, deadlineAt, scope) {
  let last;
  const now = Date.now();
  const all = config.gemini.models;
  const key = (m) => (scope ? `${m}|${scope}` : m);
  const usable = all.filter((m) => (cooldowns.get(key(m)) ?? 0) <= now);
  for (const model of usable.length ? usable : all) { // if everything is cooling down, try anyway
    try {
      return { json: await generate(model, body, deadlineAt, scope), model };
    } catch (e) {
      last = e;
      if (!(RETRYABLE.has(e.status) || e.status === 404 || e.status === 429)) throw e;
      if (e.status === 404) cooldowns.set(key(model), Date.now() + 6 * 3600_000);
      console.warn(`[gemini] ${model} unavailable (${e.status}); trying next model`);
    }
  }
  throw last;
}

