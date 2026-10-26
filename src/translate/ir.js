'use strict';

// One shape every request and answer passes through on its way between formats, so each
// format needs only a reader and a writer, never a translator to every other format.
//
// Request:  { model, stream, maxTokens, temperature, topP, stop, system, messages, tools,
//             toolChoice, parallelToolCalls, reasoning, metadata }
//   message: { role: 'user' | 'assistant', content: [part] }
//   part:    { type: 'text', text }
//            { type: 'image', mediaType, data }  (base64)  or  { type: 'image', url }
//            { type: 'tool_use', id, name, input }
//            { type: 'tool_result', toolUseId, content, isError }  (content: text or [part])
//            { type: 'thinking', text }
//   tool:    { name, description, parameters, strict }
//   toolChoice: 'auto' | 'none' | 'required' | { name }
//   reasoning: { effort: 'low' | 'medium' | 'high' | 'xhigh' } or null
//
// Answer:   { id, model, content: [part], stopReason, usage }
//   stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'
//   usage: { input, output, cacheRead, cacheWrite }
//
// Stream events, in order: start, then any of text_start/text/text_end, thinking,
// tool_start/tool_args/tool_end, then usage and stop (or error).

const crypto = require('crypto');

const newId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;

const text = (parts) => parts.filter((p) => p.type === 'text').map((p) => p.text).join('');

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

// Builds a whole answer out of a stream, for clients that didn't ask for streaming.
function collector() {
  const answer = { id: null, model: null, content: [], stopReason: 'end_turn', usage: emptyUsage() };
  let open = null; // the part being streamed
  let error = null;
  return {
    push(event) {
      switch (event.type) {
        case 'start':
          answer.id = event.id || answer.id;
          answer.model = event.model || answer.model;
          break;
        case 'text_start':
          open = { type: 'text', text: '' };
          answer.content.push(open);
          break;
        case 'text':
          if (!open || open.type !== 'text') {
            open = { type: 'text', text: '' };
            answer.content.push(open);
          }
          open.text += event.delta;
          break;
        case 'thinking': {
          const last = answer.content[answer.content.length - 1];
          if (last && last.type === 'thinking' && open === last) last.text += event.delta;
          else {
            open = { type: 'thinking', text: event.delta };
            answer.content.push(open);
          }
          break;
        }
        case 'tool_start':
          open = { type: 'tool_use', id: event.id, name: event.name, input: '', partial: true };
          answer.content.push(open);
          break;
        case 'tool_args':
          if (open && open.type === 'tool_use') open.input += event.delta;
          break;
        case 'tool_end':
        case 'text_end':
          open = null;
          break;
        case 'usage':
          answer.usage = { ...answer.usage, ...event.usage };
          break;
        case 'stop':
          answer.stopReason = event.stopReason || answer.stopReason;
          break;
        case 'error':
          error = event;
          break;
        default:
      }
    },
    result() {
      for (const part of answer.content) {
        if (part.type === 'tool_use' && part.partial) {
          delete part.partial;
          part.input = parseArgs(part.input);
        }
      }
      return { answer, error };
    },
  };
}

function parseArgs(value) {
  if (value && typeof value === 'object') return value;
  if (!value || !String(value).trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    return { _raw: String(value) };
  }
}

// A stream of answer events out of a finished answer, for a client that asked to stream
// what came back whole.
function* eventsOf(answer) {
  yield { type: 'start', id: answer.id, model: answer.model };
  for (const part of answer.content) {
    if (part.type === 'text') {
      yield { type: 'text_start' };
      yield { type: 'text', delta: part.text };
      yield { type: 'text_end' };
    } else if (part.type === 'thinking') {
      yield { type: 'thinking', delta: part.text };
    } else if (part.type === 'tool_use') {
      yield { type: 'tool_start', id: part.id, name: part.name };
      yield { type: 'tool_args', delta: JSON.stringify(part.input || {}) };
      yield { type: 'tool_end' };
    }
  }
  yield { type: 'usage', usage: answer.usage };
  yield { type: 'stop', stopReason: answer.stopReason };
}

// Which family a model name belongs to, from its name alone.
function family(model) {
  const m = String(model || '').toLowerCase();
  if (/^claude/.test(m)) return 'anthropic';
  if (/^(gpt|o[1-9]|codex|chatgpt|text-|davinci)/.test(m)) return 'openai';
  return null;
}

module.exports = { newId, text, emptyUsage, collector, parseArgs, eventsOf, family };
