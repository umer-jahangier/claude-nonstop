'use strict';

// OpenAI's Responses API: what Codex speaks, and what OpenAI's API and a ChatGPT sign-in
// take. Read into the shared shape and written back out of it, both requests and answers.

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
    if (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text') out.push({ type: 'text', text: c.text || '' });
    else if (c.type === 'input_image') {
      const url = typeof c.image_url === 'string' ? c.image_url : c.image_url && c.image_url.url;
      const inline = dataUrl(url);
      if (url) out.push(inline ? { type: 'image', ...inline } : { type: 'image', url });
    } else if (c.type === 'refusal') out.push({ type: 'text', text: c.refusal || '' });
  }
  return out;
}

const outputText = (output) => (typeof output === 'string' ? output : Array.isArray(output) ? readContent(output) : output == null ? '' : JSON.stringify(output));

function readRequest(json) {
  const systems = [];
  if (json.instructions) systems.push(String(json.instructions));
  const messages = [];
  const input = typeof json.input === 'string' ? [{ type: 'message', role: 'user', content: json.input }] : Array.isArray(json.input) ? json.input : [];
  for (const item of input) {
    if (!item) continue;
    const type = item.type || (item.role ? 'message' : '');
    if (type === 'message') {
      if (item.role === 'system' || item.role === 'developer') {
        systems.push(ir.text(readContent(item.content)));
      } else if (item.role === 'assistant') {
        messages.push({ role: 'assistant', content: readContent(item.content) });
      } else {
        messages.push({ role: 'user', content: readContent(item.content) });
      }
    } else if (type === 'function_call') {
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: item.call_id || item.id, name: item.name, input: ir.parseArgs(item.arguments) }] });
    } else if (type === 'function_call_output') {
      messages.push({ role: 'user', content: [{ type: 'tool_result', toolUseId: item.call_id, content: outputText(item.output), isError: false }] });
    } else if (type === 'custom_tool_call') {
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: item.call_id || item.id, name: item.name, input: { input: item.input } }] });
    } else if (type === 'custom_tool_call_output') {
      messages.push({ role: 'user', content: [{ type: 'tool_result', toolUseId: item.call_id, content: outputText(item.output), isError: false }] });
    } else if (type === 'local_shell_call') {
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: item.call_id || item.id, name: 'local_shell', input: item.action || {} }] });
    } else if (type === 'local_shell_call_output') {
      messages.push({ role: 'user', content: [{ type: 'tool_result', toolUseId: item.call_id, content: outputText(item.output), isError: false }] });
    }
    // reasoning items (another model's encrypted thoughts) can't be replayed elsewhere
  }
  const tools = [];
  for (const t of json.tools || []) {
    if (!t) continue;
    if (t.type === 'function') tools.push({ name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} }, strict: Boolean(t.strict) });
    else if (t.type === 'custom') tools.push({ name: t.name, description: `${t.description || ''}\nCall with a single string argument "input".`.trim(), parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } });
    else if (t.type === 'local_shell') tools.push({ name: 'local_shell', description: 'Run a shell command on the local computer.', parameters: { type: 'object', properties: { type: { type: 'string', enum: ['exec'] }, command: { type: 'array', items: { type: 'string' } }, timeout_ms: { type: 'number' }, working_directory: { type: 'string' } }, required: ['type', 'command'] } });
  }
  let toolChoice;
  const c = json.tool_choice;
  if (c === 'auto' || c === 'none' || c === 'required') toolChoice = c;
  else if (c && typeof c === 'object' && c.type === 'function' && c.name) toolChoice = { name: c.name };
  const effort = json.reasoning && json.reasoning.effort;
  return {
    model: json.model,
    stream: Boolean(json.stream),
    maxTokens: json.max_output_tokens,
    temperature: json.temperature,
    topP: json.top_p,
    stop: [],
    system: systems.filter(Boolean).join('\n\n') || null,
    messages,
    tools,
    toolChoice,
    parallelToolCalls: typeof json.parallel_tool_calls === 'boolean' ? json.parallel_tool_calls : undefined,
    reasoning: effort ? { effort, summary: json.reasoning.summary } : null,
    metadata: json.user ? { user_id: json.user } : undefined,
    promptCacheKey: json.prompt_cache_key,
  };
}

// --------------------------------------------------------------- writing a request

function writeContent(parts, role) {
  const out = [];
  for (const p of parts) {
    if (p.type === 'text') out.push(role === 'assistant' ? { type: 'output_text', text: p.text, annotations: [] } : { type: 'input_text', text: p.text });
    else if (p.type === 'image' && role !== 'assistant') out.push({ type: 'input_image', image_url: p.url || `data:${p.mediaType || 'image/png'};base64,${p.data}`, detail: 'auto' });
  }
  return out;
}

const toolOutputText = (content) => (typeof content === 'string' ? content : ir.text(content || []) || JSON.stringify(content));

function writeRequest(req, { model = req.model, store = false, stream = req.stream, includeEncrypted = false } = {}) {
  const input = [];
  for (const m of req.messages) {
    const plain = m.content.filter((p) => p.type === 'text' || p.type === 'image');
    if (plain.length) {
      const content = writeContent(plain, m.role);
      if (content.length) input.push({ type: 'message', role: m.role, content });
    }
    for (const p of m.content) {
      if (p.type === 'tool_use') input.push({ type: 'function_call', call_id: p.id, name: p.name, arguments: typeof p.input === 'string' ? p.input : JSON.stringify(p.input || {}) });
      else if (p.type === 'tool_result') input.push({ type: 'function_call_output', call_id: p.toolUseId, output: toolOutputText(p.content) });
    }
  }
  const out = { model, input, store, stream: Boolean(stream) };
  if (req.system) out.instructions = req.system;
  if (req.maxTokens) out.max_output_tokens = req.maxTokens;
  if (req.temperature !== undefined && req.temperature !== null) out.temperature = req.temperature;
  if (req.topP !== undefined && req.topP !== null) out.top_p = req.topP;
  if (req.tools && req.tools.length) {
    out.tools = req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} }, strict: false }));
    const c = req.toolChoice;
    if (c === 'required' || c === 'none' || c === 'auto') out.tool_choice = c;
    else if (c && typeof c === 'object' && c.name) out.tool_choice = { type: 'function', name: c.name };
    else out.tool_choice = 'auto';
    if (req.parallelToolCalls !== undefined) out.parallel_tool_calls = req.parallelToolCalls;
  }
  if (req.reasoning && req.reasoning.effort) out.reasoning = { effort: req.reasoning.effort === 'xhigh' ? 'high' : req.reasoning.effort, ...(req.reasoning.summary ? { summary: req.reasoning.summary } : { summary: 'auto' }) };
  if (includeEncrypted) out.include = ['reasoning.encrypted_content'];
  if (req.promptCacheKey) out.prompt_cache_key = req.promptCacheKey;
  if (req.metadata && req.metadata.user_id) out.user = String(req.metadata.user_id);
  return out;
}

// --------------------------------------------------------------- answers

const readUsage = (u) => ({
  input: Math.max(0, ((u && u.input_tokens) || 0) - ((u && u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0)),
  output: (u && u.output_tokens) || 0,
  cacheRead: (u && u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0,
  cacheWrite: 0,
});

function stopReasonOf(json, content) {
  if (json.status === 'incomplete' && json.incomplete_details && /max_output_tokens/.test(json.incomplete_details.reason || '')) return 'max_tokens';
  return content.some((p) => p.type === 'tool_use') ? 'tool_use' : 'end_turn';
}

function readAnswer(json) {
  const content = [];
  for (const item of json.output || []) {
    if (!item) continue;
    if (item.type === 'message') content.push(...readContent(item.content));
    else if (item.type === 'function_call') content.push({ type: 'tool_use', id: item.call_id || item.id, name: item.name, input: ir.parseArgs(item.arguments) });
    else if (item.type === 'reasoning') {
      const summary = (item.summary || []).map((s) => s.text || '').join('\n');
      if (summary) content.push({ type: 'thinking', text: summary });
    }
  }
  return { id: json.id, model: json.model, content, stopReason: stopReasonOf(json, content), usage: readUsage(json.usage) };
}

const writeUsage = (u) => ({
  input_tokens: (u.input || 0) + (u.cacheRead || 0),
  input_tokens_details: { cached_tokens: u.cacheRead || 0 },
  output_tokens: u.output || 0,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: (u.input || 0) + (u.cacheRead || 0) + (u.output || 0),
});

function outputItems(answer) {
  const items = [];
  let text = [];
  const flush = () => {
    if (!text.length) return;
    items.push({ id: ir.newId('msg'), type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: text.join(''), annotations: [] }] });
    text = [];
  };
  for (const p of answer.content) {
    if (p.type === 'text') text.push(p.text);
    else if (p.type === 'tool_use') {
      flush();
      items.push({ id: ir.newId('fc'), type: 'function_call', status: 'completed', call_id: p.id || ir.newId('call'), name: p.name, arguments: typeof p.input === 'string' ? p.input : JSON.stringify(p.input || {}) });
    } else if (p.type === 'thinking' && p.text) {
      flush();
      items.push({ id: ir.newId('rs'), type: 'reasoning', summary: [{ type: 'summary_text', text: p.text }] });
    }
  }
  flush();
  return items;
}

function envelope(answer, model, output, status) {
  const out = {
    id: answer.id && /^resp_/.test(answer.id) ? answer.id : ir.newId('resp'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    error: null,
    incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    model,
    output,
    usage: writeUsage(answer.usage),
    parallel_tool_calls: true,
    store: false,
    tool_choice: 'auto',
    tools: [],
    truncation: 'disabled',
    metadata: {},
  };
  return out;
}

function writeAnswer(answer, { model = answer.model } = {}) {
  return envelope(answer, model, outputItems(answer), answer.stopReason === 'max_tokens' ? 'incomplete' : 'completed');
}

// Reads a Responses event stream into shared events.
function streamReader() {
  const parse = sse.parser();
  const items = new Map(); // output_index -> { type, hadArgs, hadText }
  let completed = false;
  return (chunk) => {
    const out = [];
    for (const record of parse(chunk)) {
      const j = sse.json(record);
      if (!j) continue;
      const type = j.type || record.event;
      switch (type) {
        case 'response.created': {
          const r = j.response || {};
          out.push({ type: 'start', id: r.id, model: r.model });
          break;
        }
        case 'response.output_item.added': {
          const item = j.item || {};
          items.set(j.output_index, { type: item.type, hadArgs: false, hadText: false });
          if (item.type === 'function_call') out.push({ type: 'tool_start', id: item.call_id || item.id, name: item.name });
          else if (item.type === 'message') out.push({ type: 'text_start' });
          break;
        }
        case 'response.output_text.delta': {
          const it = items.get(j.output_index);
          if (it) it.hadText = true;
          out.push({ type: 'text', delta: j.delta || '' });
          break;
        }
        case 'response.function_call_arguments.delta': {
          const it = items.get(j.output_index);
          if (it) it.hadArgs = true;
          out.push({ type: 'tool_args', delta: j.delta || '' });
          break;
        }
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta':
          out.push({ type: 'thinking', delta: j.delta || '' });
          break;
        case 'response.output_item.done': {
          const item = j.item || {};
          const it = items.get(j.output_index) || {};
          if (item.type === 'function_call') {
            if (!it.hadArgs && item.arguments) out.push({ type: 'tool_args', delta: item.arguments });
            out.push({ type: 'tool_end' });
          } else if (item.type === 'message') {
            if (!it.hadText) {
              const text = readContent(item.content).map((p) => p.text || '').join('');
              if (text) out.push({ type: 'text', delta: text });
            }
            out.push({ type: 'text_end' });
          }
          break;
        }
        case 'response.completed':
        case 'response.incomplete': {
          completed = true;
          const r = j.response || {};
          const content = r.output ? readAnswer(r).content : [];
          out.push({ type: 'usage', usage: readUsage(r.usage) });
          const sawTools = [...items.values()].some((i) => i.type === 'function_call');
          out.push({ type: 'stop', stopReason: type === 'response.incomplete' || (r.status === 'incomplete') ? 'max_tokens' : sawTools || content.some((p) => p.type === 'tool_use') ? 'tool_use' : 'end_turn' });
          break;
        }
        case 'response.failed': {
          const e = (j.response && j.response.error) || {};
          out.push({ type: 'error', message: e.message || 'the response failed', code: e.code });
          break;
        }
        case 'error':
          out.push({ type: 'error', message: j.message || (j.error && j.error.message) || 'upstream error', code: j.code || (j.error && j.error.code) });
          break;
        default:
      }
    }
    return out;
  };
}

// Writes shared events as a Responses event stream.
function streamWriter({ model }) {
  let seq = 0;
  let outputIndex = -1;
  let item = null;
  let text = '';
  let args = '';
  const output = [];
  let usage = ir.emptyUsage();
  let id = ir.newId('resp');
  const created = Math.floor(Date.now() / 1000);
  const base = () => ({ id, object: 'response', created_at: created, model, output: [], usage: null, store: false, tool_choice: 'auto', tools: [], parallel_tool_calls: true, truncation: 'disabled', metadata: {} });
  const ev = (type, body) => sse.format(type, { type, sequence_number: seq++, ...body });
  return (event) => {
    switch (event.type) {
      case 'start':
        if (event.id && /^resp_/.test(event.id)) id = event.id;
        return ev('response.created', { response: { ...base(), status: 'in_progress', error: null, incomplete_details: null } }) + ev('response.in_progress', { response: { ...base(), status: 'in_progress', error: null, incomplete_details: null } });
      case 'text_start':
        outputIndex += 1;
        text = '';
        item = { id: ir.newId('msg'), type: 'message', status: 'in_progress', role: 'assistant', content: [] };
        return ev('response.output_item.added', { output_index: outputIndex, item }) + ev('response.content_part.added', { item_id: item.id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      case 'text': {
        let prefix = '';
        if (!item || item.type !== 'message') {
          outputIndex += 1;
          text = '';
          item = { id: ir.newId('msg'), type: 'message', status: 'in_progress', role: 'assistant', content: [] };
          prefix = ev('response.output_item.added', { output_index: outputIndex, item }) + ev('response.content_part.added', { item_id: item.id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        }
        text += event.delta;
        return prefix + ev('response.output_text.delta', { item_id: item.id, output_index: outputIndex, content_index: 0, delta: event.delta, logprobs: [] });
      }
      case 'text_end': {
        if (!item || item.type !== 'message') return '';
        const done = { ...item, status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
        output.push(done);
        const s = ev('response.output_text.done', { item_id: item.id, output_index: outputIndex, content_index: 0, text, logprobs: [] }) +
          ev('response.content_part.done', { item_id: item.id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text, annotations: [] } }) +
          ev('response.output_item.done', { output_index: outputIndex, item: done });
        item = null;
        return s;
      }
      case 'thinking': {
        outputIndex += 1;
        const rs = { id: ir.newId('rs'), type: 'reasoning', summary: [{ type: 'summary_text', text: event.delta }] };
        output.push(rs);
        return ev('response.output_item.added', { output_index: outputIndex, item: { ...rs, summary: [] } }) +
          ev('response.reasoning_summary_text.delta', { item_id: rs.id, output_index: outputIndex, summary_index: 0, delta: event.delta }) +
          ev('response.output_item.done', { output_index: outputIndex, item: rs });
      }
      case 'tool_start':
        outputIndex += 1;
        args = '';
        item = { id: ir.newId('fc'), type: 'function_call', status: 'in_progress', call_id: event.id || ir.newId('call'), name: event.name, arguments: '' };
        return ev('response.output_item.added', { output_index: outputIndex, item });
      case 'tool_args':
        if (!item || item.type !== 'function_call') return '';
        args += event.delta;
        return ev('response.function_call_arguments.delta', { item_id: item.id, output_index: outputIndex, delta: event.delta });
      case 'tool_end': {
        if (!item || item.type !== 'function_call') return '';
        const done = { ...item, status: 'completed', arguments: args || '{}' };
        output.push(done);
        const s = ev('response.function_call_arguments.done', { item_id: item.id, output_index: outputIndex, arguments: done.arguments }) + ev('response.output_item.done', { output_index: outputIndex, item: done });
        item = null;
        return s;
      }
      case 'usage':
        usage = { ...usage, ...event.usage };
        return '';
      case 'stop': {
        const incomplete = event.stopReason === 'max_tokens';
        const response = { ...base(), status: incomplete ? 'incomplete' : 'completed', error: null, incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null, output, usage: writeUsage(usage) };
        return ev(incomplete ? 'response.incomplete' : 'response.completed', { response });
      }
      case 'error':
        return ev('response.failed', { response: { ...base(), status: 'failed', error: { code: event.code || 'server_error', message: event.message }, incomplete_details: null, output } }) +
          ev('error', { code: event.code || 'server_error', message: event.message, param: null });
      default:
        return '';
    }
  };
}

const errorBody = (type, message, code = null) => ({ error: { message, type, param: null, code } });

module.exports = { readRequest, writeRequest, readAnswer, writeAnswer, streamReader, streamWriter, errorBody };
