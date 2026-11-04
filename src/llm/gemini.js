// Gemini tool-use loop over the public REST API (generateContent + function calling).
// Same tools and the same policy gate as every other brain; the model can only *request* purchases.
// Verified live: the model's turn is echoed back UNCHANGED (this preserves thought signatures that newer
// Gemini models require), and function results are returned as functionResponse parts that echo the call id.
import { config } from '../config.js';
import { TOOLS, runToolBatch } from '../tools.js';
import { generateWithFallback, deadlineMs } from './gemini-core.js';

const MAX_TURNS = 6;

// OpenAPI-subset schema Gemini accepts; empty-object tools are given no `parameters` at all.
const declarations = TOOLS.map((t) => {
  const hasProps = Object.keys(t.input_schema.properties ?? {}).length > 0;
  return { name: t.name, description: t.description, ...(hasProps ? { parameters: t.input_schema } : {}) };
});

export async function runGemini({ system, history, userText, sid, steps }) {
  const contents = [
    ...history.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    { role: 'user', parts: [{ text: userText }] },
  ];
  let usedModel = config.gemini.models[0];
  const deadlineAt = Date.now() + deadlineMs();

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
    const ran = await runToolBatch(sid, calls.map((p) => ({ name: p.functionCall.name, input: p.functionCall.args ?? {} })));
    const responses = calls.map((p, i) => {
      steps.push(ran[i].step);
      return { functionResponse: { name: p.functionCall.name, ...(p.functionCall.id ? { id: p.functionCall.id } : {}), response: ran[i].result } };
    });
    contents.push({ role: 'user', parts: responses });
  }
  return { text: 'I hit my step limit - check the approvals queue for what I have requested so far.', model: usedModel };
}
