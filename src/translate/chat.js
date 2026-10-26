'use strict';

// OpenAI's Chat Completions API (what Cursor's own-key mode and most OpenAI-compatible
// tools speak), read into the shared shape and written back out of it. The gateway only
// ever receives this format; nothing upstream needs it written as a request.

const ir = require('./ir');
const sse = require('./sse');

function dataUrl(url) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(url || ''));
  return m ? { mediaType: m[1], data: m[2] } : null;
}

function readContent(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const c of content) {
    if (!c) continue;
    if (c.type === 'text') out.push({ type: 'text', text: c.text || '' });
    else if (c.type === 'image_url') {
      const url = typeof c.image_url === 'string' ? c.image_url : c.image_url && c.image_url.url;
      const inline = dataUrl(url);
      out.push(inline ? { type: 'image', ...inline } : { type: 'image', url });
    } else if (c.type === 'input_text') out.push({ type: 'text', text: c.text || '' });
  }
  return out;
}

function readRequest(json) {
  const systems = [];
  const messages = [];
  for (const m of json.messages || []) {
    if (!m) continue;
    if (m.role === 'system' || m.role === 'developer') {
      systems.push(ir.text(readContent(m.content)));
      continue;
    }
    if (m.role === 'tool') {
      messages.push({ role: 'user', content: [{ type: 'tool_result', toolUseId: m.tool_call_id, content: typeof m.content === 'string' ? m.content : readContent(m.content), isError: false }] });
      continue;
    }
    if (m.role === 'assistant') {
      const content = readContent(m.content);
      for (const call of m.tool_calls || []) {
        if (call.type !== 'function' || !call.function) continue;
        content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: ir.parseArgs(call.function.arguments) });
      }
      messages.push({ role: 'assistant', content });
      continue;
    }
    messages.push({ role: 'user', content: readContent(m.content) });
  }
  let tools = (json.tools || []).filter((t) => t && t.type === 'function' && t.function).map((t) => ({ name: t.function.name, description: t.function.description || '', parameters: t.function.parameters || { type: 'object', properties: {} }, strict: Boolean(t.function.strict) }));
  if (!tools.length && Array.isArray(json.functions)) tools = json.functions.map((f) => ({ name: f.name, description: f.description || '', parameters: f.parameters || { type: 'object', properties: {} } }));
  let toolChoice;
  const c = json.tool_choice;
  if (c === 'auto' || c === 'none' || c === 'required') toolChoice = c;
  else if (c && typeof c === 'object' && c.function && c.function.name) toolChoice = { name: c.function.name };
  const effort = json.reasoning_effort || (json.reasoning && json.reasoning.effort);
  return {
    model: json.model,
    stream: Boolean(json.stream),
    includeUsage: Boolean(json.stream_options && json.stream_options.include_usage),
    maxTokens: json.max_completion_tokens || json.max_tokens,
    temperature: json.temperature,
    topP: json.top_p,
    stop: typeof json.stop === 'string' ? [json.stop] : Array.isArray(json.stop) ? json.stop : [],
    system: systems.filter(Boolean).join('\n\n') || null,
    messages,
    tools,
    toolChoice,
    parallelToolCalls: typeof json.parallel_tool_calls === 'boolean' ? json.parallel_tool_calls : undefined,
    reasoning: effort ? { effort } : null,
    metadata: json.user ? { user_id: json.user } : undefined,
  };
}

// --------------------------------------------------------------- answers

const finishReason = (stop, hasTools) => (hasTools || stop === 'tool_use' ? 'tool_calls' : stop === 'max_tokens' ? 'length' : 'stop');

const writeUsage = (u) => ({
  prompt_tokens: (u.input || 0) + (u.cacheRead || 0),
  completion_tokens: u.output || 0,
  total_tokens: (u.input || 0) + (u.cacheRead || 0) + (u.output || 0),
  prompt_tokens_details: { cached_tokens: u.cacheRead || 0 },
});

function writeAnswer(answer, { model = answer.model } = {}) {
  const calls = answer.content.filter((p) => p.type === 'tool_use');
  const message = { role: 'assistant', content: ir.text(answer.content) || null };
  if (calls.length) message.tool_calls = calls.map((c) => ({ id: c.id || ir.newId('call'), type: 'function', function: { name: c.name, arguments: typeof c.input === 'string' ? c.input : JSON.stringify(c.input || {}) } }));
  const thinking = answer.content.filter((p) => p.type === 'thinking').map((p) => p.text).join('');
  if (thinking) message.reasoning_content = thinking;
  return {
    id: answer.id || ir.newId('chatcmpl'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, logprobs: null, finish_reason: finishReason(answer.stopReason, calls.length > 0) }],
    usage: writeUsage(answer.usage),
  };
}

// Writes shared events as chat-completion chunks.
function streamWriter({ model, includeUsage = false }) {
  const id = ir.newId('chatcmpl');
  const created = Math.floor(Date.now() / 1000);
  let usage = ir.emptyUsage();
  let toolIndex = -1;
  let sawTools = false;
  let roleSent = false;
  const chunk = (delta, finish = null) => sse.format(null, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] });
  const role = () => {
    if (roleSent) return '';
    roleSent = true;
    return chunk({ role: 'assistant', content: '' });
  };
  return (event) => {
    switch (event.type) {
      case 'start':
        return role();
      case 'text':
        return role() + chunk({ content: event.delta });
      case 'thinking':
        return role() + chunk({ reasoning_content: event.delta });
      case 'tool_start':
        sawTools = true;
        toolIndex += 1;
        return role() + chunk({ tool_calls: [{ index: toolIndex, id: event.id || ir.newId('call'), type: 'function', function: { name: event.name, arguments: '' } }] });
      case 'tool_args':
        return chunk({ tool_calls: [{ index: toolIndex, function: { arguments: event.delta } }] });
      case 'usage':
        usage = { ...usage, ...event.usage };
        return '';
      case 'stop':
        return role() + chunk({}, finishReason(event.stopReason, sawTools)) +
          (includeUsage ? sse.format(null, { id, object: 'chat.completion.chunk', created, model, choices: [], usage: writeUsage(usage) }) : '') +
          'data: [DONE]\n\n';
      case 'error':
        return sse.format(null, { error: { message: event.message, type: 'server_error', code: event.code || null } }) + 'data: [DONE]\n\n';
      default:
        return '';
    }
  };
}

module.exports = { readRequest, writeAnswer, streamWriter };
