'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isolate } = require('./helpers');

isolate();
const translate = require('../src/translate');
const messages = require('../src/translate/messages');
const chat = require('../src/translate/chat');
const responses = require('../src/translate/responses');
const sse = require('../src/translate/sse');
const { ir } = translate;

// A Codex turn: a developer message, the user, a tool the model called, and its result.
const codexRequest = () => ({
  model: 'gpt-5.5',
  instructions: 'You are Codex.',
  input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Be brief.' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List files' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' }] },
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'xyz' },
    { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"command":["ls"]}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'a.txt\nb.txt' },
  ],
  tools: [{ type: 'function', name: 'shell', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'array' } } }, strict: false }],
  tool_choice: 'auto',
  parallel_tool_calls: false,
  reasoning: { effort: 'medium', summary: 'auto' },
  store: false,
  stream: true,
  include: ['reasoning.encrypted_content'],
  prompt_cache_key: 'thread-1',
});

test('a Codex request becomes a Claude request: system text, image, tool call and result, tools', () => {
  const req = translate.readRequest('responses', codexRequest());
  assert.equal(req.system, 'You are Codex.\n\nBe brief.');
  assert.equal(req.messages.length, 3, 'user, assistant tool call, tool result (the encrypted reasoning is left out)');
  const out = translate.writeRequest('messages', req, { model: 'claude-sonnet-5-5' });
  assert.equal(out.model, 'claude-sonnet-5-5');
  assert.equal(out.stream, true);
  assert.equal(out.system, 'You are Codex.\n\nBe brief.');
  assert.deepEqual(out.messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  assert.deepEqual(out.messages[1].content[0], { type: 'tool_use', id: 'call_1', name: 'shell', input: { command: ['ls'] } });
  assert.deepEqual(out.messages[2].content[0], { type: 'tool_result', tool_use_id: 'call_1', content: 'a.txt\nb.txt' });
  assert.equal(out.tools[0].name, 'shell');
  assert.deepEqual(out.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
  assert.deepEqual(out.thinking, { type: 'adaptive' }, 'current models think adaptively');
  assert.deepEqual(out.output_config, { effort: 'medium' }, "the client's reasoning effort sets how much");
  assert.equal(out.temperature, undefined);
  const older = translate.writeRequest('messages', req, { model: 'claude-haiku-4-5' });
  assert.deepEqual(older.thinking, { type: 'enabled', budget_tokens: 8192 }, 'older models still take a budget');
  assert.equal(older.output_config, undefined);
});

test('forced tool choice goes out only to models that take it', () => {
  const req = translate.readRequest('chat', { model: 'gpt-5.5', messages: [{ role: 'user', content: 'go' }], tools: [{ type: 'function', function: { name: 'go', parameters: { type: 'object' } } }], tool_choice: 'required' });
  assert.deepEqual(translate.writeRequest('messages', req, { model: 'claude-haiku-5-5' }).tool_choice, { type: 'any' });
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2']) {
    assert.equal(translate.writeRequest('messages', req, { model }).tool_choice, undefined, `${model} refuses a forced choice`);
  }
});

test('a chat-completions request becomes a Claude request, with tool calls both ways', () => {
  const req = translate.readRequest('chat', {
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: [{ type: 'text', text: 'Weather?' }, { type: 'image_url', image_url: { url: 'https://x.test/a.png' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Lahore"}' } }] },
      { role: 'tool', tool_call_id: 'call_9', content: '31C' },
    ],
    tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    tool_choice: { type: 'function', function: { name: 'get_weather' } },
    max_completion_tokens: 200,
    temperature: 0.2,
    stop: ['END'],
    stream: true,
    stream_options: { include_usage: true },
  });
  assert.equal(req.includeUsage, true);
  const out = translate.writeRequest('messages', req, { model: 'claude-haiku-5-5' });
  assert.equal(out.max_tokens, 200);
  assert.equal(out.temperature, undefined, 'API version 2026-10-21 refuses sampling settings');
  assert.deepEqual(out.stop_sequences, ['END']);
  assert.deepEqual(out.messages[0].content[1], { type: 'image', source: { type: 'url', url: 'https://x.test/a.png' } });
  assert.equal(out.messages[1].content[0].type, 'tool_use');
  assert.equal(out.messages[2].content[0].tool_use_id, 'call_9');
  assert.deepEqual(out.tool_choice, { type: 'tool', name: 'get_weather' });
});

test('a Claude request becomes a Responses request: system, tools, tool call and result', () => {
  const req = translate.readRequest('messages', {
    model: 'claude-opus-5-5',
    max_tokens: 500,
    system: [{ type: 'text', text: 'You are Claude Code.' }],
    messages: [
      { role: 'user', content: 'Read it' },
      { role: 'assistant', content: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'hello' }] }] },
    ],
    tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
    tool_choice: { type: 'any' },
    stream: true,
  });
  const out = translate.writeRequest('responses', req, { model: 'gpt-5.5', store: false, includeEncrypted: true });
  assert.equal(out.instructions, 'You are Claude Code.');
  assert.equal(out.store, false);
  assert.equal(out.stream, true);
  assert.equal(out.max_output_tokens, 500);
  assert.deepEqual(out.include, ['reasoning.encrypted_content']);
  assert.deepEqual(out.input[0], { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read it' }] });
  assert.deepEqual(out.input[1], { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reading.', annotations: [] }] });
  assert.deepEqual(out.input[2], { type: 'function_call', call_id: 'toolu_1', name: 'Read', arguments: '{"path":"a"}' });
  assert.deepEqual(out.input[3], { type: 'function_call_output', call_id: 'toolu_1', output: 'hello' });
  assert.equal(out.tools[0].type, 'function');
  assert.equal(out.tool_choice, 'required');
});

test('answers are written in every client format, tool calls included', () => {
  const answer = translate.readAnswer('messages', {
    id: 'msg_1', model: 'claude-sonnet-5-5', stop_reason: 'tool_use',
    content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'toolu_2', name: 'get_weather', input: { city: 'Lahore' } }],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4 },
  });
  const c = translate.writeAnswer('chat', answer, { model: 'gpt-5.5' });
  assert.equal(c.object, 'chat.completion');
  assert.equal(c.choices[0].finish_reason, 'tool_calls');
  assert.equal(c.choices[0].message.content, 'Checking.');
  assert.deepEqual(c.choices[0].message.tool_calls[0].function, { name: 'get_weather', arguments: '{"city":"Lahore"}' });
  assert.equal(c.usage.prompt_tokens, 14);
  const r = translate.writeAnswer('responses', answer, { model: 'gpt-5.5' });
  assert.equal(r.object, 'response');
  assert.equal(r.status, 'completed');
  assert.equal(r.output[0].type, 'message');
  assert.equal(r.output[1].type, 'function_call');
  assert.equal(r.output[1].call_id, 'toolu_2');
  assert.equal(r.usage.input_tokens_details.cached_tokens, 4);
  const back = translate.readAnswer('responses', r);
  assert.deepEqual(back.content[1], { type: 'tool_use', id: 'toolu_2', name: 'get_weather', input: { city: 'Lahore' } });
  const m = translate.writeAnswer('messages', back, { model: 'claude-sonnet-5-5' });
  assert.equal(m.stop_reason, 'tool_use');
  assert.equal(m.content[1].type, 'tool_use');
});

// Anthropic's stream for "Hi" followed by one tool call.
const anthropicStream = [
  ['message_start', { type: 'message_start', message: { id: 'msg_s', model: 'claude-sonnet-5-5', usage: { input_tokens: 9, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_3', name: 'shell', input: {} } }],
  ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '["ls"]}' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 12 } }],
  ['message_stop', { type: 'message_stop' }],
].map(([event, data]) => sse.format(event, data)).join('');

function collectStream(reader, writer, raw) {
  let out = '';
  for (const chunk of raw.match(/[\s\S]{1,37}/g)) for (const event of reader(chunk)) out += writer(event);
  return out;
}

const parseAll = (text) => {
  const parse = sse.parser();
  return parse(text).map((r) => ({ event: r.event, data: r.data === '[DONE]' ? '[DONE]' : JSON.parse(r.data) }));
};

test('a Claude stream is rewritten as chat-completion chunks, split across arbitrary chunk boundaries', () => {
  const out = collectStream(messages.streamReader(), chat.streamWriter({ model: 'gpt-5.5', includeUsage: true }), anthropicStream);
  const records = parseAll(out);
  const chunks = records.filter((r) => r.data !== '[DONE]' && r.data.choices && r.data.choices.length > 0);
  const text = chunks.filter((r) => r.data.choices[0].delta.content).map((r) => r.data.choices[0].delta.content).join('');
  assert.equal(text, 'Hi');
  const calls = chunks.filter((r) => r.data.choices[0].delta.tool_calls);
  assert.equal(calls[0].data.choices[0].delta.tool_calls[0].function.name, 'shell');
  assert.equal(calls.slice(1).map((r) => r.data.choices[0].delta.tool_calls[0].function.arguments).join(''), '{"command":["ls"]}');
  const last = chunks.filter((r) => r.data.choices[0].finish_reason).pop();
  assert.equal(last.data.choices[0].finish_reason, 'tool_calls');
  assert.equal(records.find((r) => r.data !== '[DONE]' && r.data.usage).data.usage.completion_tokens, 12);
  assert.equal(records[records.length - 1].data, '[DONE]');
});

test('a Claude stream is rewritten as Responses events that Codex can follow', () => {
  const out = collectStream(messages.streamReader(), responses.streamWriter({ model: 'gpt-5.5' }), anthropicStream);
  const records = parseAll(out);
  const types = records.map((r) => r.event);
  assert.equal(types[0], 'response.created');
  assert.ok(types.includes('response.output_text.delta'));
  assert.ok(types.includes('response.function_call_arguments.delta'));
  const done = records.filter((r) => r.event === 'response.output_item.done').map((r) => r.data.item);
  assert.equal(done[0].type, 'message');
  assert.equal(done[0].content[0].text, 'Hi');
  assert.equal(done[1].type, 'function_call');
  assert.equal(done[1].call_id, 'toolu_3');
  assert.equal(done[1].arguments, '{"command":["ls"]}');
  const completed = records.find((r) => r.event === 'response.completed').data.response;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.output.length, 2);
  assert.equal(completed.usage.output_tokens, 12);
  assert.ok(records.every((r, i) => r.data.sequence_number === i), 'events are numbered in order');
});

test('a Responses stream is rewritten as Claude events, and can be gathered into one answer', () => {
  const raw = [
    { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.5' } },
    { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, delta: 'Hel' },
    { type: 'response.output_text.delta', output_index: 0, delta: 'lo' },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] } },
    { type: 'response.output_item.added', output_index: 1, item: { id: 'fc_1', type: 'function_call', call_id: 'call_7', name: 'Read', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":"a"}' },
    { type: 'response.output_item.done', output_index: 1, item: { id: 'fc_1', type: 'function_call', call_id: 'call_7', name: 'Read', arguments: '{"path":"a"}' } },
    { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-5.5', status: 'completed', output: [], usage: { input_tokens: 20, input_tokens_details: { cached_tokens: 5 }, output_tokens: 8 } } },
  ].map((e) => sse.format(e.type, e)).join('');
  const out = collectStream(responses.streamReader(), messages.streamWriter({ model: 'claude-sonnet-5-5' }), raw);
  const records = parseAll(out);
  assert.equal(records[0].event, 'message_start');
  assert.equal(records.filter((r) => r.event === 'content_block_delta' && r.data.delta.type === 'text_delta').map((r) => r.data.delta.text).join(''), 'Hello');
  const tool = records.find((r) => r.event === 'content_block_start' && r.data.content_block.type === 'tool_use');
  assert.equal(tool.data.content_block.id, 'call_7');
  assert.equal(tool.data.index, 1);
  const delta = records.find((r) => r.event === 'message_delta').data;
  assert.equal(delta.delta.stop_reason, 'tool_use');
  assert.equal(delta.usage.output_tokens, 8);
  assert.equal(records[records.length - 1].event, 'message_stop');

  const collect = ir.collector();
  const read = responses.streamReader();
  for (const event of read(raw)) collect.push(event);
  const { answer } = collect.result();
  assert.equal(ir.text(answer.content), 'Hello');
  assert.deepEqual(answer.content[1], { type: 'tool_use', id: 'call_7', name: 'Read', input: { path: 'a' } });
  assert.equal(answer.stopReason, 'tool_use');
  assert.deepEqual(answer.usage, { input: 15, output: 8, cacheRead: 5, cacheWrite: 0 });
});

test('model families are told apart by name', () => {
  assert.equal(ir.family('claude-sonnet-5-5'), 'anthropic');
  assert.equal(ir.family('gpt-5.5'), 'openai');
  assert.equal(ir.family('o3-mini'), 'openai');
  assert.equal(ir.family('codex-mini-latest'), 'openai');
  assert.equal(ir.family('llama-3'), null);
});

test('errors are written in the client\'s own format', () => {
  assert.deepEqual(translate.errorBody('messages', 'api_error', 'x'), { type: 'error', error: { type: 'api_error', message: 'x' } });
  assert.deepEqual(translate.errorBody('chat', 'api_error', 'x'), { error: { message: 'x', type: 'api_error', param: null, code: null } });
});
