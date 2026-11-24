'use strict';

// Google's Gemini format (generateContent / streamGenerateContent), as a wire only: requests
// from any client are written in it, and its answers read back. The Gemini API (an API key)
// and Gemini Code Assist (a Google account signed in the way Gemini CLI does) both speak it;
// Code Assist wraps the request as { model, project, request } and each answer as
// { response }, which gateway.js adds and readers here take off.
//
// Gemini 3 models sign each tool call (thoughtSignature) and refuse a conversation that hands
// a call back without its signature. Signatures are kept here by tool call id while the
// gateway runs; a call from before (or from another provider) gets the placeholder Google
// documents for exactly that case.

const crypto = require('crypto');
const ir = require('./ir');
const sse = require('./sse');

const SKIP_SIGNATURE = 'skip_thought_signature_validator';
const signatures = new Map();
const remember = (id, signature) => {
  if (!signature) return;
  signatures.set(id, signature);
  if (signatures.size > 5000) signatures.delete(signatures.keys().next().value);
};

// JSON Schema keywords Gemini's function declarations refuse.
const DROP_SCHEMA = new Set(['$schema', '$id', '$comment', 'examples']);
function cleanSchema(schema) {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) if (!DROP_SCHEMA.has(k)) out[k] = cleanSchema(v);
  return out;
}

const resultText = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (p.type === 'text' ? p.text : p.type === 'image' ? '[image]' : '')).join('\n') : JSON.stringify(content ?? ''));

// Gemini names: letters, digits, _ . : - and up to 64 of them, starting with a letter or _.
const toolName = (name) => {
  const n = String(name || 'tool').replace(/[^A-Za-z0-9_.:-]/g, '_');
  return (/^[A-Za-z_]/.test(n) ? n : `_${n}`).slice(0, 64);
};

function writeRequest(req, { model = req.model } = {}) {
  const names = new Map(); // tool call id -> name, for the function responses that follow
  const contents = [];
  for (const m of req.messages || []) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts = [];
    let signed = false;
    for (const p of m.content || []) {
      if (p.type === 'text' && p.text) parts.push({ text: p.text });
      else if (p.type === 'image') parts.push(p.data ? { inlineData: { mimeType: p.mediaType || 'image/png', data: p.data } } : { text: `[image: ${p.url}]` });
      else if (p.type === 'tool_use') {
        names.set(p.id, toolName(p.name));
        const part = { functionCall: { name: toolName(p.name), args: p.input && typeof p.input === 'object' ? p.input : {} } };
        // The first call of each turn carries the signature; Gemini checks only that one.
        if (!signed) {
          part.thoughtSignature = signatures.get(p.id) || SKIP_SIGNATURE;
          signed = true;
        }
        parts.push(part);
      } else if (p.type === 'tool_result') {
        const text = resultText(p.content);
        parts.push({ functionResponse: { name: names.get(p.toolUseId) || 'tool', response: p.isError ? { error: text } : { output: text } } });
      }
    }
    if (!parts.length) continue;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  }
  if (!contents.length || contents[0].role !== 'user') contents.unshift({ role: 'user', parts: [{ text: '(continue)' }] });

  const out = { contents };
  if (req.system) out.systemInstruction = { role: 'user', parts: [{ text: String(req.system) }] };
  if (req.tools && req.tools.length) {
    out.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: toolName(t.name), description: t.description || '', parametersJsonSchema: cleanSchema(t.parameters || { type: 'object', properties: {} }) })) }];
    const c = req.toolChoice;
    if (c === 'none') out.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
    else if (c === 'required') out.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
    else if (c && typeof c === 'object' && c.name) out.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [toolName(c.name)] } };
  }
  const gen = {};
  if (req.maxTokens) gen.maxOutputTokens = req.maxTokens;
  if (typeof req.temperature === 'number') gen.temperature = req.temperature;
  if (typeof req.topP === 'number') gen.topP = req.topP;
  if (req.stop && req.stop.length) gen.stopSequences = req.stop.slice(0, 5);
  const effort = req.reasoning && req.reasoning.effort;
  if (/gemini-2\.5/.test(String(model))) {
    gen.thinkingConfig = { includeThoughts: true, ...(effort ? { thinkingBudget: { minimal: 512, low: 2048, medium: 8192, high: 24576, xhigh: 32768 }[effort] || 8192 } : {}) };
  } else if (/gemini-[3-9]/.test(String(model))) {
    gen.thinkingConfig = { includeThoughts: true, ...(effort ? { thinkingLevel: effort === 'low' || effort === 'minimal' ? 'low' : 'high' } : {}) };
  }
  if (Object.keys(gen).length) out.generationConfig = gen;
  return out;
}

// --------------------------------------------------------------- answers

const unwrap = (j) => (j && j.response && (j.response.candidates || j.response.usageMetadata) ? { ...j.response, responseId: j.response.responseId || j.traceId } : j);

const readUsage = (u) => ({
  input: (u && u.promptTokenCount) || 0,
  output: ((u && u.candidatesTokenCount) || 0) + ((u && u.thoughtsTokenCount) || 0),
  cacheRead: (u && u.cachedContentTokenCount) || 0,
  cacheWrite: 0,
});

const STOPS = { MAX_TOKENS: 'max_tokens', STOP: 'end_turn' };

// Turns Gemini answer chunks into shared events. Used for a stream and for a whole answer.
function chunkReader() {
  let started = false;
  let textOpen = false;
  let tools = 0;
  let usage = null;
  let stopped = false;
  return (raw) => {
    const out = [];
    if (raw && raw.error) {
      out.push({ type: 'error', message: raw.error.message || 'Gemini error', code: raw.error.status || raw.error.code });
      return out;
    }
    const j = unwrap(raw);
    if (!j) return out;
    if (!started) {
      started = true;
      out.push({ type: 'start', id: j.responseId || ir.newId('msg'), model: j.modelVersion });
    }
    if (j.usageMetadata) usage = readUsage(j.usageMetadata);
    const cand = (j.candidates || [])[0];
    for (const part of (cand && cand.content && cand.content.parts) || []) {
      if (part.thought && part.text) {
        out.push({ type: 'thinking', delta: part.text });
      } else if (typeof part.text === 'string' && part.text) {
        if (!textOpen) {
          out.push({ type: 'text_start' });
          textOpen = true;
        }
        out.push({ type: 'text', delta: part.text });
      } else if (part.functionCall) {
        if (textOpen) {
          out.push({ type: 'text_end' });
          textOpen = false;
        }
        const id = part.functionCall.id || `toolu_${crypto.randomBytes(12).toString('hex')}`;
        remember(id, part.thoughtSignature);
        tools++;
        out.push({ type: 'tool_start', id, name: part.functionCall.name });
        out.push({ type: 'tool_args', delta: JSON.stringify(part.functionCall.args || {}) });
        out.push({ type: 'tool_end' });
      }
    }
    if (cand && cand.finishReason && !stopped) {
      stopped = true;
      if (textOpen) {
        out.push({ type: 'text_end' });
        textOpen = false;
      }
      if (usage) out.push({ type: 'usage', usage });
      const reason = cand.finishReason;
      if (!tools && !STOPS[reason] && reason !== 'FINISH_REASON_UNSPECIFIED') out.push({ type: 'error', message: `Gemini stopped the answer (${reason})`, code: reason });
      out.push({ type: 'stop', stopReason: tools ? 'tool_use' : STOPS[reason] || 'end_turn' });
    }
    return out;
  };
}

function streamReader() {
  const parse = sse.parser();
  const read = chunkReader();
  return (chunk) => {
    const out = [];
    for (const record of parse(chunk)) {
      const j = sse.json(record);
      if (j) out.push(...read(j));
    }
    return out;
  };
}

function readAnswer(json) {
  const c = ir.collector();
  const read = chunkReader();
  for (const j of Array.isArray(json) ? json : [json]) for (const e of read(j)) c.push(e);
  return c.result().answer;
}

module.exports = { writeRequest, readAnswer, streamReader, cleanSchema, SKIP_SIGNATURE };
