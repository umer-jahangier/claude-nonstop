'use strict';

// Anthropic's Messages API (what Claude Code and the Claude desktop app speak), read into
// the shared shape and written back out of it.

const ir = require('./ir');
const sse = require('./sse');

const asArray = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []);

function readPart(block) {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text || '' };
    case 'image':
      if (block.source && block.source.type === 'base64') return { type: 'image', mediaType: block.source.media_type, data: block.source.data };
      if (block.source && block.source.type === 'url') return { type: 'image', url: block.source.url };
      return null;
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input || {} };
    case 'tool_result':
      return {
        type: 'tool_result',
        toolUseId: block.tool_use_id,
        content: typeof block.content === 'string' ? block.content : asArray(block.content).map(readPart).filter(Boolean),
        isError: Boolean(block.is_error),
      };
    case 'thinking':
      return { type: 'thinking', text: block.thinking || '' };
    default:
      return null;
  }
}

function readToolChoice(choice) {
  if (!choice) return undefined;
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'tool') return { name: choice.name };
  return undefined;
}

function readRequest(json) {
  const system = Array.isArray(json.system)
    ? json.system.map((b) => (typeof b === 'string' ? b : b && b.text) || '').filter(Boolean).join('\n\n')
    : json.system || null;
  const messages = (json.messages || []).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: asArray(m.content).map(readPart).filter(Boolean) }));
  const tools = (json.tools || []).filter((t) => t && t.name && !t.type?.startsWith('computer') && !t.type?.startsWith('bash') && !t.type?.startsWith('text_editor')).map((t) => ({
    name: t.name,
    description: t.description || '',
    parameters: t.input_schema || { type: 'object', properties: {} },
  }));
  const thinking = json.thinking && json.thinking.type === 'enabled' ? { effort: json.thinking.budget_tokens >= 16000 ? 'high' : json.thinking.budget_tokens >= 4000 ? 'medium' : 'low' } : null;
  return {
    model: json.model,
    stream: Boolean(json.stream),
    maxTokens: json.max_tokens,
    temperature: json.temperature,
    topP: json.top_p,
    stop: json.stop_sequences || [],
    system,
    messages,
    tools,
    toolChoice: readToolChoice(json.tool_choice),
    parallelToolCalls: json.tool_choice && json.tool_choice.disable_parallel_tool_use ? false : undefined,
    reasoning: thinking,
    metadata: json.metadata,
  };
}

// --------------------------------------------------------------- writing a request

const BUDGET = { low: 2048, medium: 8192, high: 16384, xhigh: 32768 };

function writePart(part) {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'image':
      return part.url
        ? { type: 'image', source: { type: 'url', url: part.url } }
        : { type: 'image', source: { type: 'base64', media_type: part.mediaType || 'image/png', data: part.data } };
    case 'tool_use':
      return { type: 'tool_use', id: part.id, name: part.name, input: part.input && typeof part.input === 'object' ? part.input : ir.parseArgs(part.input) };
    case 'tool_result': {
      const content = typeof part.content === 'string' ? part.content : (part.content || []).map(writePart).filter(Boolean);
      const out = { type: 'tool_result', tool_use_id: part.toolUseId, content: content.length === 0 ? '' : content };
      if (part.isError) out.is_error = true;
      return out;
    }
    case 'thinking':
      return null; // another provider's reasoning can't be replayed as Claude's
    default:
      return null;
  }
}

// Anthropic wants strictly alternating turns: adjacent same-role messages are merged, and a
// conversation can't open with the assistant.
function mergeTurns(messages) {
  const out = [];
  for (const m of messages) {
    if (!m.content.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content.push(...m.content);
    else out.push({ role: m.role, content: [...m.content] });
  }
  if (out.length && out[0].role === 'assistant') out.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });
  return out;
}

function writeRequest(req, { model = req.model, defaultMaxTokens = 16384 } = {}) {
  const out = { model, max_tokens: req.maxTokens || defaultMaxTokens, messages: mergeTurns(req.messages).map((m) => ({ role: m.role, content: m.content.map(writePart).filter(Boolean) })) };
  // Every message needs some content; a tool-only or image-only turn is fine, an empty one isn't.
  out.messages = out.messages.filter((m) => m.content.length);
  if (!out.messages.length) out.messages = [{ role: 'user', content: [{ type: 'text', text: '(empty)' }] }];
  if (req.stream) out.stream = true;
  if (req.system) out.system = req.system;
  if (req.stop && req.stop.length) out.stop_sequences = req.stop;
  if (req.tools && req.tools.length) {
    out.tools = req.tools.map((t) => ({ name: t.name, description: t.description || '', input_schema: t.parameters || { type: 'object', properties: {} } }));
    const c = req.toolChoice;
    if (c === 'required') out.tool_choice = { type: 'any' };
    else if (c === 'none') out.tool_choice = { type: 'none' };
    else if (c && typeof c === 'object' && c.name) out.tool_choice = { type: 'tool', name: c.name };
    else if (req.parallelToolCalls === false) out.tool_choice = { type: 'auto', disable_parallel_tool_use: true };
  }
  if (req.reasoning && req.reasoning.effort && req.reasoning.effort !== 'none') {
    const budget = BUDGET[req.reasoning.effort] || BUDGET.medium;
    out.thinking = { type: 'enabled', budget_tokens: budget };
    if (out.max_tokens <= budget) out.max_tokens = budget + 4096;
    // Thinking takes the model's own sampling settings.
  } else {
    if (req.temperature !== undefined && req.temperature !== null) out.temperature = req.temperature;
    if (req.topP !== undefined && req.topP !== null) out.top_p = req.topP;
  }
  if (req.metadata && req.metadata.user_id) out.metadata = { user_id: String(req.metadata.user_id) };
  return out;
}

// --------------------------------------------------------------- answers

const readUsage = (u) => ({
  input: (u && u.input_tokens) || 0,
  output: (u && u.output_tokens) || 0,
  cacheRead: (u && u.cache_read_input_tokens) || 0,
  cacheWrite: (u && u.cache_creation_input_tokens) || 0,
});

function readAnswer(json) {
  return {
    id: json.id,
    model: json.model,
    content: (json.content || []).map(readPart).filter(Boolean),
    stopReason: json.stop_reason || 'end_turn',
    usage: readUsage(json.usage),
  };
}

function writeAnswer(answer, { model = answer.model } = {}) {
  const content = answer.content.filter((p) => p.type !== 'thinking' || p.text).map((p) => (p.type === 'thinking' ? { type: 'thinking', thinking: p.text, signature: '' } : writePart(p))).filter(Boolean);
  return {
    id: answer.id || ir.newId('msg'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: answer.stopReason || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: answer.usage.input,
      output_tokens: answer.usage.output,
      cache_read_input_tokens: answer.usage.cacheRead || 0,
      cache_creation_input_tokens: answer.usage.cacheWrite || 0,
    },
  };
}

// Reads Anthropic's event stream into shared events.
function streamReader() {
  const parse = sse.parser();
  const blocks = new Map(); // index -> type
  return (chunk) => {
    const out = [];
    for (const record of parse(chunk)) {
      const j = sse.json(record);
      if (!j) continue;
      switch (j.type) {
        case 'message_start': {
          const m = j.message || {};
          out.push({ type: 'start', id: m.id, model: m.model });
          if (m.usage) out.push({ type: 'usage', usage: readUsage(m.usage) });
          break;
        }
        case 'content_block_start': {
          const b = j.content_block || {};
          blocks.set(j.index, b.type);
          if (b.type === 'text') {
            out.push({ type: 'text_start' });
            if (b.text) out.push({ type: 'text', delta: b.text });
          } else if (b.type === 'tool_use') {
            out.push({ type: 'tool_start', id: b.id, name: b.name });
            if (b.input && Object.keys(b.input).length) out.push({ type: 'tool_args', delta: JSON.stringify(b.input) });
          }
          break;
        }
        case 'content_block_delta': {
          const d = j.delta || {};
          if (d.type === 'text_delta') out.push({ type: 'text', delta: d.text || '' });
          else if (d.type === 'input_json_delta') out.push({ type: 'tool_args', delta: d.partial_json || '' });
          else if (d.type === 'thinking_delta') out.push({ type: 'thinking', delta: d.thinking || '' });
          break;
        }
        case 'content_block_stop': {
          const kind = blocks.get(j.index);
          if (kind === 'text') out.push({ type: 'text_end' });
          else if (kind === 'tool_use') out.push({ type: 'tool_end' });
          break;
        }
        case 'message_delta': {
          if (j.usage) out.push({ type: 'usage', usage: { output: j.usage.output_tokens || 0, ...(j.usage.input_tokens ? { input: j.usage.input_tokens } : {}) } });
          if (j.delta && j.delta.stop_reason) out.push({ type: 'stop', stopReason: j.delta.stop_reason });
          break;
        }
        case 'error':
          out.push({ type: 'error', message: (j.error && j.error.message) || 'upstream error', code: j.error && j.error.type });
          break;
        default:
      }
    }
    return out;
  };
}

// Writes shared events as Anthropic's event stream.
function streamWriter({ model }) {
  let index = -1;
  let usage = ir.emptyUsage();
  let started = false;
  let stopSent = false;
  const open = () => {
    index += 1;
  };
  return (event) => {
    switch (event.type) {
      case 'start':
        started = true;
        return sse.format('message_start', {
          type: 'message_start',
          message: { id: event.id || ir.newId('msg'), type: 'message', role: 'assistant', model: event.model || model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
        });
      case 'text_start':
        open('text');
        return sse.format('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      case 'text':
        return sse.format('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: event.delta } });
      case 'text_end':
      case 'tool_end':
        return sse.format('content_block_stop', { type: 'content_block_stop', index });
      case 'thinking':
        // Reasoning summaries from another provider are shown as one thinking block each.
        open('thinking');
        return sse.format('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } }) +
          sse.format('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: event.delta } }) +
          sse.format('content_block_stop', { type: 'content_block_stop', index });
      case 'tool_start':
        open('tool_use');
        return sse.format('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: event.id || ir.newId('toolu'), name: event.name, input: {} } });
      case 'tool_args':
        return sse.format('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: event.delta } });
      case 'usage':
        usage = { ...usage, ...event.usage };
        return '';
      case 'stop':
        stopSent = true;
        return sse.format('message_delta', { type: 'message_delta', delta: { stop_reason: event.stopReason || 'end_turn', stop_sequence: null }, usage: { input_tokens: usage.input, output_tokens: usage.output } }) +
          sse.format('message_stop', { type: 'message_stop' });
      case 'error':
        if (!started) return sse.format('error', { type: 'error', error: { type: 'api_error', message: event.message } });
        return (stopSent ? '' : sse.format('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output } })) +
          sse.format('error', { type: 'error', error: { type: 'api_error', message: event.message } });
      default:
        return '';
    }
  };
}

const errorBody = (type, message) => ({ type: 'error', error: { type, message } });

module.exports = { readRequest, writeRequest, readAnswer, writeAnswer, streamReader, streamWriter, errorBody, mergeTurns };
