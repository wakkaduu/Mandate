// Gemini tool-use loop over the public REST API (generateContent + function calling).
// Same tools and the same policy gate as every other brain; the model can only *request* purchases.
// Verified live: the model's turn is echoed back UNCHANGED (this preserves thought signatures that newer
// Gemini models require), and function results are returned as functionResponse parts that echo the call id.
import { config } from '../config.js';
import { TOOLS, runTool } from '../tools.js';

const MAX_TURNS = 6;
const DEADLINE_MS = 45_000; // whole chat must fit a 60s serverless limit; past this we hand over to the fallback agent
const RETRYABLE = new Set([429, 500, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// OpenAPI-subset schema Gemini accepts; empty-object tools are given no `parameters` at all.
const declarations = TOOLS.map((t) => {
  const hasProps = Object.keys(t.input_schema.properties ?? {}).length > 0;
  return { name: t.name, description: t.description, ...(hasProps ? { parameters: t.input_schema } : {}) };
});

// Per-model cooldowns: free-tier keys have per-model daily quotas, so once a model says 429 (or is overloaded)
// we skip it for a while instead of paying its latency on every request. Exported for tests/diagnostics.
export const cooldowns = new Map();
function parseRetrySeconds(json) {
  const info = (json.error?.details ?? []).find((d) => d.retryDelay);
  const s = info ? parseFloat(info.retryDelay) : NaN;
  return Number.isFinite(s) ? s : null;
}

async function generate(model, body, deadlineAt) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (Date.now() > deadlineAt) throw Object.assign(new Error('Gemini deadline exceeded'), { status: 504, model });
    const res = await fetch(`${config.gemini.baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': config.gemini.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(3000, Math.min(25_000, deadlineAt - Date.now()))),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) return json;
    last = Object.assign(new Error(json.error?.message?.slice(0, 160) || `Gemini HTTP ${res.status}`), { status: res.status, model });
    if (res.status === 429) {
      const wait = parseRetrySeconds(json);
      cooldowns.set(model, Date.now() + Math.min((wait ?? 60) * 1000, 6 * 3600_000));
      break; // quota: retrying the same model is pointless
    }
    if (!RETRYABLE.has(res.status)) break;
    if (res.status === 503) cooldowns.set(model, Date.now() + 20_000);
    await sleep(500 * (attempt + 1));
  }
  throw last;
}

/** Try the configured model, then the fallbacks, on overload / quota / retired-model errors. */
async function generateWithFallback(body, deadlineAt) {
  let last;
  const now = Date.now();
  const all = config.gemini.models;
  const usable = all.filter((m) => (cooldowns.get(m) ?? 0) <= now);
  for (const model of usable.length ? usable : all) { // if everything is cooling down, try anyway
    try {
      return { json: await generate(model, body, deadlineAt), model };
    } catch (e) {
      last = e;
      if (!(RETRYABLE.has(e.status) || e.status === 404 || e.status === 429)) throw e;
      if (e.status === 404) cooldowns.set(model, Date.now() + 6 * 3600_000);
      console.warn(`[gemini] ${model} unavailable (${e.status}); trying next model`);
    }
  }
  throw last;
}

export async function runGemini({ system, history, userText, sid, steps }) {
  const contents = [
    ...history.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    { role: 'user', parts: [{ text: userText }] },
  ];
  let usedModel = config.gemini.models[0];
  const deadlineAt = Date.now() + DEADLINE_MS;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const { json, model } = await generateWithFallback({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools: [{ functionDeclarations: declarations }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: { maxOutputTokens: 2048 },
    }, deadlineAt);
    usedModel = model;
    const cand = json.candidates?.[0];
    if (!cand?.content?.parts?.length) {
      const why = json.promptFeedback?.blockReason || cand?.finishReason || 'empty response';
      return { text: `I could not produce an answer (${why}).`, model: usedModel };
    }
    contents.push(cand.content); // unchanged, incl. thought signatures
    const calls = cand.content.parts.filter((p) => p.functionCall);
    if (!calls.length) {
      return { text: cand.content.parts.map((p) => p.text ?? '').join('').trim() || 'Done.', model: usedModel };
    }
    const responses = [];
    for (const p of calls) {
      const { result, step } = await runTool(sid, p.functionCall.name, p.functionCall.args ?? {});
      steps.push(step);
      responses.push({ functionResponse: { name: p.functionCall.name, ...(p.functionCall.id ? { id: p.functionCall.id } : {}), response: result } });
    }
    contents.push({ role: 'user', parts: responses });
  }
  return { text: 'I hit my step limit - check the approvals queue for what I have requested so far.', model: usedModel };
}
