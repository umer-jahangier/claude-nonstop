'use strict';

// Every client on every kind of line, with tools: Codex, Claude Code, the Claude desktop
// app and chat-completions apps like Cursor, each on a Claude account, a Claude API key, a ChatGPT account and an OpenAI API key.
// Each test is a whole tool round trip: the client declares its tools, the model calls one,
// the call reaches the client in the client's own shape, the client sends the tool's result
// back, and the model answers having read it.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { FAKE_PATCH, isolate, startFakeApi, startFakeOpenAI, testKey, testOpenaiKey, signInFakeAccount, signInFakeChatgpt, call } = require('./helpers');

isolate();
let api;
let openai;
before(async () => {
  api = await startFakeApi();
  openai = await startFakeOpenAI();
  process.env.CLAUDE_NONSTOP_UPSTREAM = api.url;
  process.env.CLAUDE_NONSTOP_OPENAI_UPSTREAM = `${openai.url}/v1`;
  process.env.CLAUDE_NONSTOP_CHATGPT_UPSTREAM = `${openai.url}/backend-api/codex`;
  process.env.CLAUDE_NONSTOP_OPENAI_ISSUER = openai.url;
});

const vault = require('../src/vault');
const keys = require('../src/keys');
const state = require('../src/state');
const config = require('../src/config');
const sse = require('../src/translate/sse');

let server;
let base;
let token;

before(async () => {
  const { createServer, createContext } = require('../src/server');
  token = vault.loadWithTokens().gatewayToken;
  server = createServer(createContext());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await api.close();
  await openai.close();
});

// ---------------------------------------------------------------- the lines

const LINES = {
  'a Claude account': ['claude'],
  'a Claude API key': ['key', testKey('tools')],
  'a ChatGPT account': ['chatgpt'],
  'an OpenAI API key': ['key', testOpenaiKey('tools')],
};

function useLine([kind, key]) {
  const accounts = [];
  const order = [];
  const entries = [];
  if (kind === 'claude') {
    const configDir = path.join(process.env.CLAUDE_NONSTOP_HOME, 'profiles', 'acct-tools');
    signInFakeAccount(configDir, 'tools');
    accounts.push({ id: 'acct-tools', label: 'Claude tools', kind: 'profile', configDir, enabled: true });
    order.push('account:acct-tools');
  } else if (kind === 'chatgpt') {
    accounts.push({ id: 'gpt-tools', label: 'ChatGPT tools', kind: 'chatgpt', provider: 'openai', enabled: true });
    signInFakeChatgpt('gpt-tools', 'tools');
    order.push('account:gpt-tools');
  } else {
    const entry = keys.newEntry(key, 'tools key', 1);
    entries.push(entry);
    order.push(`key:${entry.id}`);
  }
  vault.update((v) => {
    v.keys = entries;
  });
  config.update((c) => {
    c.accounts = accounts;
    c.order = order;
    c.pinned = null;
  });
  state.clearCooldowns();
  api.requests.length = 0;
  openai.requests.length = 0;
}

// What went upstream for the last request: the service's own request record.
const upstream = () => (api.requests.length ? api.requests : openai.requests).filter((r) => r.method === 'POST').slice(-1)[0];

const records = (body) => sse.parser()(body).map((r) => ({ event: r.event, data: r.data === '[DONE]' ? r.data : JSON.parse(r.data) }));

// ---------------------------------------------------------------- the clients

const CODEX_TOOLS = [
  { type: 'function', name: 'shell', description: 'Runs a shell command.', strict: false, parameters: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' } } }, required: ['command'] } },
  { type: 'custom', name: 'apply_patch', description: 'Edits files with a patch.', format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch hunk+ end_patch' } },
];

const codex = {
  name: 'Codex',
  async send(history) {
    const body = { model: 'gpt-5.5', stream: true, store: false, instructions: 'You are Codex, a coding agent.', tools: CODEX_TOOLS, tool_choice: 'auto', parallel_tool_calls: false, input: history };
    const r = await call(`${base}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'user-agent': 'codex_cli_rs/0.80.0', originator: 'codex_cli_rs' }, body });
    assert.equal(r.status, 200, r.body);
    const recs = records(r.body);
    assert.equal(recs[0].event, 'response.created');
    assert.equal(recs[recs.length - 1].event, 'response.completed');
    const items = recs.filter((x) => x.event === 'response.output_item.done').map((x) => x.data.item);
    const text = recs.filter((x) => x.event === 'response.output_text.delta').map((x) => x.data.delta).join('');
    return { items, text, recs, sent: body };
  },
  async roundTrip(toolName) {
    const user = { type: 'message', role: 'user', content: [{ type: 'input_text', text: `use ${toolName}` }] };
    const first = await this.send([user]);
    const callItem = first.items.find((i) => /_call$/.test(i.type));
    assert.ok(callItem, 'the answer is a tool call');
    const output = { type: `${callItem.type}_output`, call_id: callItem.call_id, output: 'done' };
    const second = await this.send([user, callItem, output]);
    return { call: callItem, first, answer: second.text };
  },
};

function claudeClient(name, headers, system) {
  return {
    name,
    async send(messages) {
      const body = { model: 'claude-sonnet-5-5', max_tokens: 200, stream: true, system, tools: [{ name: 'Bash', description: 'Runs a command.', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }], messages };
      const r = await call(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01', ...headers }, body });
      assert.equal(r.status, 200, r.body);
      const recs = records(r.body);
      assert.equal(recs[0].event, 'message_start');
      const start = recs.find((x) => x.event === 'content_block_start' && x.data.content_block.type === 'tool_use');
      const args = recs.filter((x) => x.event === 'content_block_delta' && x.data.delta.type === 'input_json_delta').map((x) => x.data.delta.partial_json).join('');
      const text = recs.filter((x) => x.event === 'content_block_delta' && x.data.delta.type === 'text_delta').map((x) => x.data.delta.text).join('');
      return { tool: start && { id: start.data.content_block.id, name: start.data.content_block.name, input: JSON.parse(args || '{}') }, text };
    },
    async roundTrip() {
      const user = { role: 'user', content: 'use Bash' };
      const first = await this.send([user]);
      assert.ok(first.tool, 'the answer is a tool call');
      const second = await this.send([user, { role: 'assistant', content: [{ type: 'tool_use', id: first.tool.id, name: first.tool.name, input: first.tool.input }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: first.tool.id, content: 'done' }] }]);
      return { tool: first.tool, answer: second.text };
    },
  };
}

const claudeCode = claudeClient('Claude Code', { 'user-agent': 'claude-cli/2.1.310 (external, cli)', 'x-app': 'cli' }, [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }, { type: 'text', text: 'Help with code.' }]);
const desktop = claudeClient('the Claude desktop app', { 'user-agent': 'Claude/1.9.0 (desktop)' }, 'You are Claude, in the desktop app.');

// Cursor and other OpenAI chat-completions apps.
const chatApp = {
  name: 'A chat-completions app (Cursor)',
  async send(messages) {
    const body = { model: 'gpt-5.5', stream: true, messages, tools: [{ type: 'function', function: { name: 'run_terminal_cmd', description: 'Runs a command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } }] };
    const r = await call(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'user-agent': 'Cursor/2.0' }, body });
    assert.equal(r.status, 200, r.body);
    const recs = records(r.body).filter((x) => x.data !== '[DONE]');
    assert.equal(records(r.body).pop().data, '[DONE]');
    const deltas = recs.map((x) => x.data.choices && x.data.choices[0] && x.data.choices[0].delta).filter(Boolean);
    const calls = deltas.flatMap((d) => d.tool_calls || []);
    const text = deltas.map((d) => d.content || '').join('');
    const first = calls.find((t) => t.id);
    return { tool: first && { id: first.id, name: first.function.name, arguments: calls.map((t) => (t.function && t.function.arguments) || '').join('') }, text };
  },
  async roundTrip() {
    const user = { role: 'user', content: 'use run_terminal_cmd' };
    const first = await this.send([user]);
    assert.ok(first.tool, 'the answer is a tool call');
    const second = await this.send([user, { role: 'assistant', content: null, tool_calls: [{ id: first.tool.id, type: 'function', function: { name: first.tool.name, arguments: first.tool.arguments } }] }, { role: 'tool', tool_call_id: first.tool.id, content: 'done' }]);
    return { tool: { name: first.tool.name, input: JSON.parse(first.tool.arguments) }, answer: second.text };
  },
};

// ---------------------------------------------------------------- Codex on every line

for (const [lineName, line] of Object.entries(LINES)) {
  test(`Codex on ${lineName}: apply_patch comes back as a custom tool call with the raw patch, and its output reaches the model`, async () => {
    useLine(line);
    const { call: c, first, answer } = await codex.roundTrip('apply_patch');
    assert.equal(c.type, 'custom_tool_call');
    assert.equal(c.name, 'apply_patch');
    assert.equal(c.input, FAKE_PATCH, 'the patch text itself, not JSON around it');
    assert.ok(first.recs.some((x) => x.event === 'response.custom_tool_call_input.delta'), 'streamed the way Codex reads a custom tool');
    assert.equal(answer, 'got: done');
  });

  test(`Codex on ${lineName}: shell comes back as a function call, and its output reaches the model`, async () => {
    useLine(line);
    const { call: c, answer } = await codex.roundTrip('shell');
    assert.equal(c.type, 'function_call');
    assert.equal(c.name, 'shell');
    assert.deepEqual(JSON.parse(c.arguments), { command: ['echo', 'hi'] });
    assert.equal(answer, 'got: done');
  });

  for (const client of [claudeCode, desktop, chatApp]) {
    test(`${client.name} on ${lineName}: a tool call and its result go round`, async () => {
      useLine(line);
      const { tool, answer } = await client.roundTrip();
      assert.equal(tool.name, client === chatApp ? 'run_terminal_cmd' : 'Bash');
      assert.deepEqual(tool.input, { command: 'echo hi' });
      assert.equal(answer, 'got: done');
    });
  }
}

// ---------------------------------------------------------------- what goes upstream

test("Codex on a Claude account: only the line a sign-in needs, no Claude Code identity, and every tool", async () => {
  useLine(LINES['a Claude account']);
  await codex.send([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
  const q = upstream();
  assert.doesNotMatch(String(q.headers['user-agent'] || ''), /claude-cli/);
  assert.equal(q.headers['x-app'], undefined);
  const sent = JSON.parse(q.body);
  assert.equal(sent.system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.");
  assert.match(sent.system[1].text, /do not describe yourself as Claude Code/);
  assert.equal(sent.system[2].text, 'You are Codex, a coding agent.');
  assert.deepEqual(sent.tools.map((t) => t.name), ['shell', 'apply_patch']);
  const patch = sent.tools[1];
  assert.deepEqual(Object.keys(patch.input_schema.properties), ['input']);
  assert.match(patch.description, /start: begin_patch hunk\+ end_patch/, "the patch grammar reaches the model");
});

test('Codex on a Claude API key: nothing of Claude Code at all', async () => {
  useLine(LINES['a Claude API key']);
  await codex.send([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
  const q = upstream();
  assert.doesNotMatch(q.body, /Claude Code/);
  assert.doesNotMatch(String(q.headers['user-agent'] || ''), /claude-cli/);
  assert.equal(JSON.parse(q.body).system, 'You are Codex, a coding agent.');
});

test("Codex on an OpenAI API key: the request goes to OpenAI exactly as Codex sent it", async () => {
  useLine(LINES['an OpenAI API key']);
  const { sent } = await codex.send([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
  assert.deepEqual(JSON.parse(upstream().body), sent);
});

test("Codex on a ChatGPT account: its instructions and tools go to the Codex backend unchanged", async () => {
  useLine(LINES['a ChatGPT account']);
  const { sent } = await codex.send([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
  const out = JSON.parse(upstream().body);
  assert.equal(out.instructions, sent.instructions);
  assert.deepEqual(out.tools, sent.tools);
  assert.deepEqual(out.input, sent.input);
});

test('Claude Code and the desktop app on a Claude account still go out as Claude Code', async () => {
  for (const client of [claudeCode, desktop]) {
    useLine(LINES['a Claude account']);
    await client.send([{ role: 'user', content: 'hi' }]);
    const q = upstream();
    assert.match(q.headers['user-agent'], /^claude-cli\//, client.name);
    const sent = JSON.parse(q.body);
    const first = Array.isArray(sent.system) ? sent.system[0].text : sent.system;
    assert.ok(first.startsWith("You are Claude Code, Anthropic's official CLI for Claude."), client.name);
    assert.doesNotMatch(q.body, /required by the API connection only/, client.name);
  }
});

test("Codex's whole-answer requests get the same tool shapes", async () => {
  useLine(LINES['a Claude API key']);
  const r = await call(`${base}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: { model: 'gpt-5.5', tools: CODEX_TOOLS, input: 'use apply_patch' } });
  assert.equal(r.status, 200, r.body);
  const out = JSON.parse(r.body);
  assert.deepEqual(out.output.map((i) => [i.type, i.name, i.input]), [['custom_tool_call', 'apply_patch', FAKE_PATCH]]);
});

// ---------------------------------------------------------------- Codex as it ships now

// Codex 0.164 sends no top-level tools or instructions: its instructions are developer
// messages, and its tools an additional_tools input item, grouped in namespaces. Its one
// code tool, functions.exec, is a custom tool that takes JavaScript.
const codexNow = {
  name: 'Codex (additional_tools)',
  tools: [
    { type: 'namespace', name: 'functions', description: 'Tools', tools: [
      { type: 'custom', name: 'exec', description: 'Runs JavaScript.', format: { type: 'grammar', syntax: 'lark', definition: 'start: SOURCE' } },
      { type: 'function', name: 'wait', description: 'Waits.', strict: false, parameters: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' } } } } },
    ] },
    { type: 'namespace', name: 'collaboration', description: 'Agents', tools: [
      { type: 'function', name: 'list_agents', description: 'Lists agents.', strict: false, parameters: { type: 'object', properties: { command: { type: 'string' } } } },
    ] },
  ],
  async send(history) {
    const input = [{ type: 'additional_tools', id: 'at_1', role: 'developer', tools: this.tools }, { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex, an agent.' }] }, ...history];
    const body = { model: 'gpt-5.5', stream: true, store: false, input, tool_choice: 'auto', parallel_tool_calls: true, include: ['reasoning.encrypted_content'] };
    const r = await call(`${base}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'user-agent': 'codex_exec/0.164.0' }, body });
    assert.equal(r.status, 200, r.body);
    const recs = records(r.body);
    return { items: recs.filter((x) => x.event === 'response.output_item.done').map((x) => x.data.item), text: recs.filter((x) => x.event === 'response.output_text.delta').map((x) => x.data.delta).join(''), sent: body };
  },
  async roundTrip(said) {
    const user = { type: 'message', role: 'user', content: [{ type: 'input_text', text: `use ${said}` }] };
    const first = await this.send([user]);
    const c = first.items.find((i) => /_call$/.test(i.type));
    assert.ok(c, 'the answer is a tool call');
    // Codex sends a tool's result back as a list of text parts.
    const output = { type: `${c.type}_output`, call_id: c.call_id, output: [{ type: 'input_text', text: 'done' }] };
    const second = await this.send([user, c, output]);
    return { call: c, answer: second.text };
  },
};

for (const [lineName, line] of Object.entries(LINES)) {
  test(`Codex 0.164 on ${lineName}: functions.exec comes back as a custom call named exec, with the raw script`, async () => {
    useLine(line);
    const { call: c, answer } = await codexNow.roundTrip('exec');
    assert.equal(c.type, 'custom_tool_call');
    assert.equal(c.name, 'exec');
    assert.equal(c.namespace, undefined, 'the default namespace is left implicit, as Codex itself expects');
    assert.equal(c.input, FAKE_PATCH);
    assert.equal(answer, 'got: done');
  });

  test(`Codex 0.164 on ${lineName}: a namespaced function comes back under its own name and namespace`, async () => {
    useLine(line);
    const { call: c, answer } = await codexNow.roundTrip('collaboration.list_agents');
    assert.equal(c.type, 'function_call');
    assert.equal(c.name, 'list_agents');
    assert.equal(c.namespace, 'collaboration');
    assert.equal(answer, 'got: done');
  });
}

test('Codex 0.164 on a Claude account: every namespaced tool reaches the model, and the developer messages are its instructions', async () => {
  useLine(LINES['a Claude account']);
  await codexNow.send([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
  const sent = JSON.parse(upstream().body);
  assert.deepEqual(sent.tools.map((t) => t.name), ['exec', 'wait', 'collaboration__list_agents']);
  assert.equal(sent.system[2].text, 'You are Codex, an agent.');
});

test('a chat-completions request with sampling settings works on every line', async () => {
  for (const line of Object.values(LINES)) {
    useLine(line);
    const r = await call(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: { model: 'gpt-5.5', temperature: 0.3, top_p: 0.9, messages: [{ role: 'user', content: 'use run_terminal_cmd' }], tools: [{ type: 'function', function: { name: 'run_terminal_cmd', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }] } });
    assert.equal(r.status, 200, `${line[0]}: ${r.body}`);
    assert.equal(JSON.parse(r.body).choices[0].message.tool_calls[0].function.name, 'run_terminal_cmd');
  }
});
