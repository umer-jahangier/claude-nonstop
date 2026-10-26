'use strict';

// The gateway with lines on two services: any client format goes out on whatever line is
// next in your order, translated when it has to be.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { isolate, startFakeApi, startFakeOpenAI, testKey, testOpenaiKey, signInFakeAccount, signInFakeChatgpt, call } = require('./helpers');

isolate();
let api;
let openai;
// The sign-in token endpoint is read when openai-auth loads, so the fake must exist first.
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

function useKeys(...list) {
  vault.update((v) => {
    v.keys = list.map((key, i) => keys.newEntry(key, `key ${i + 1}`, i + 1));
  });
  state.clearCooldowns();
}

// Lines in order: ['claude', kind] is a Claude account, ['chatgpt', kind] a ChatGPT account, ['key', key] a key.
function useLines(...lines) {
  const accounts = [];
  const order = [];
  const entries = [];
  lines.forEach((l, i) => {
    if (l[0] === 'claude') {
      const configDir = path.join(process.env.CLAUDE_NONSTOP_HOME, 'profiles', `acct-${l[1]}-${i}`);
      signInFakeAccount(configDir, l[1]);
      accounts.push({ id: `acct-${l[1]}-${i}`, label: `Claude ${l[1]} ${i}`, kind: 'profile', configDir, enabled: true });
      order.push(`account:acct-${l[1]}-${i}`);
    } else if (l[0] === 'chatgpt') {
      const id = `gpt-${l[1]}-${i}`;
      accounts.push({ id, label: `ChatGPT ${l[1]} ${i}`, kind: 'chatgpt', provider: 'openai', enabled: true });
      signInFakeChatgpt(id, l[1], l[2] || {});
      order.push(`account:${id}`);
    } else {
      const entry = keys.newEntry(l[1], `key ${i}`, i);
      entries.push(entry);
      order.push(`key:${entry.id}`);
    }
  });
  vault.update((v) => {
    v.keys = entries;
    v.accounts = Object.fromEntries(Object.entries(v.accounts).filter(([id]) => accounts.some((a) => a.id === id)));
  });
  config.update((c) => {
    c.accounts = accounts.length ? accounts : c.accounts.map((a) => ({ ...a, enabled: false }));
    c.order = order;
    c.pinned = null;
  });
  state.clearCooldowns();
  api.requests.length = 0;
  openai.requests.length = 0;
  openai.modelRequests.length = 0;
}

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

const auth = { authorization: `Bearer ${token}` };
const parseSse = (text) => sse.parser()(text).map((r) => ({ event: r.event, data: r.data === '[DONE]' ? '[DONE]' : JSON.parse(r.data) }));

test('keys of both services are told apart when saved', () => {
  assert.equal(keys.newEntry(testKey('ok'), 'a', 1).provider, 'anthropic');
  assert.equal(keys.newEntry(testOpenaiKey('ok'), 'b', 1).provider, 'openai');
  assert.equal(keys.problemWith(testOpenaiKey('ok')), null);
  assert.match(keys.problemWith('sk-ant-oat-xyz'), /subscription sign-in token/);
  assert.match(keys.problemWith('hello'), /Claude keys start with sk-ant-api, OpenAI keys with sk-/);
});

test('a chat-completions request (Cursor) goes out on a Claude API key, translated both ways', async () => {
  useLines(['key', testKey('ok')]);
  const r = await call(`${base}/v1/chat/completions`, { method: 'POST', headers: auth, body: { model: 'gpt-4o', messages: [{ role: 'system', content: 'Be brief' }, { role: 'user', content: 'hi' }] } });
  assert.equal(r.status, 200);
  const out = JSON.parse(r.body);
  assert.equal(out.object, 'chat.completion');
  assert.equal(out.choices[0].message.content, 'ok');
  assert.equal(out.model, 'gpt-4o', 'the client sees the model it asked for');
  const sent = JSON.parse(api.requests[0].body);
  assert.equal(api.requests[0].url, '/v1/messages');
  assert.equal(sent.model, 'claude-sonnet-5-5', 'a model from the other family becomes the line\'s default');
  assert.equal(sent.system, 'Be brief');
  assert.equal(api.requests[0].key, testKey('ok'));
  assert.equal(api.requests[0].headers['anthropic-version'], '2026-10-21');
});

test('a chat-completions stream is rewritten chunk by chunk', async () => {
  useLines(['key', testKey('ok')]);
  const r = await call(`${base}/v1/chat/completions`, { method: 'POST', headers: auth, body: { model: 'claude-haiku-5-5', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/event-stream/);
  const records = parseSse(r.body);
  assert.equal(records[0].data.object, 'chat.completion.chunk');
  assert.equal(records[records.length - 1].data, '[DONE]');
  assert.equal(JSON.parse(api.requests[0].body).model, 'claude-haiku-5-5', 'a Claude model is kept as asked');
});

test('a Codex request goes out on a Claude account as Claude Code, and the answer comes back as Responses events', async () => {
  useLines(['claude', 'ok']);
  const r = await call(`${base}/v1/responses`, { method: 'POST', headers: auth, body: { model: 'gpt-5.5', stream: true, store: false, instructions: 'You are Codex.', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] } });
  assert.equal(r.status, 200);
  const records = parseSse(r.body);
  assert.equal(records[0].event, 'response.created');
  assert.equal(records[records.length - 1].event, 'response.completed');
  const q = api.requests[0];
  assert.equal(q.bearer, 'sk-ant-oat-test-ok');
  assert.match(q.headers['user-agent'], /^claude-cli\//);
  const sent = JSON.parse(q.body);
  assert.equal(sent.model, 'claude-sonnet-5-5');
  assert.ok(Array.isArray(sent.system) && sent.system[0].text.startsWith('You are Claude Code'), 'Claude Code\'s line goes first for the sign-in');
  assert.equal(sent.system[1].text, 'You are Codex.');
});

test('a Claude Code request goes out on an OpenAI API key as a Responses request, and comes back as a Claude message', async () => {
  useLines(['key', testOpenaiKey('ok')]);
  const r = await call(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': token, 'anthropic-version': '2026-10-21' }, body: { model: 'claude-sonnet-5-5', max_tokens: 50, system: 'You are Claude Code.', messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(r.status, 200);
  const out = JSON.parse(r.body);
  assert.equal(out.type, 'message');
  assert.equal(out.role, 'assistant');
  assert.equal(out.content[0].text, 'ok via gpt-5.5');
  assert.equal(out.model, 'claude-sonnet-5-5');
  assert.deepEqual(out.usage, { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 });
  const q = openai.requests[0];
  assert.equal(q.url, '/v1/responses');
  assert.equal(q.bearer, testOpenaiKey('ok'));
  assert.equal(q.headers['anthropic-version'], undefined, 'nothing of Anthropic\'s goes to OpenAI');
  const sent = JSON.parse(q.body);
  assert.equal(sent.model, 'gpt-5.5');
  assert.equal(sent.store, false);
  assert.equal(sent.instructions, 'You are Claude Code.');
});

test('a Claude Code stream on an OpenAI key becomes Anthropic events, tool call included', async () => {
  useLines(['key', testOpenaiKey('tool')]);
  const r = await call(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': token, 'anthropic-version': '2026-10-21' }, body: { model: 'claude-sonnet-5-5', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'weather' }], tools: [{ name: 'get_weather', input_schema: { type: 'object' } }] } });
  assert.equal(r.status, 200);
  const records = parseSse(r.body);
  assert.equal(records[0].event, 'message_start');
  const tool = records.find((x) => x.event === 'content_block_start' && x.data.content_block.type === 'tool_use');
  assert.equal(tool.data.content_block.name, 'get_weather');
  assert.equal(records.filter((x) => x.event === 'content_block_delta').map((x) => x.data.delta.partial_json).join(''), '{"city":"Lahore"}');
  assert.equal(records.find((x) => x.event === 'message_delta').data.delta.stop_reason, 'tool_use');
});

test('a Codex request on a ChatGPT account goes to the Codex backend as Codex, streamed, with usage read from the answer', async () => {
  useLines(['chatgpt', 'ok']);
  const body = { model: 'gpt-5.5', stream: true, store: true, previous_response_id: 'resp_old', instructions: 'You are Codex.', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], include: ['reasoning.encrypted_content'] };
  const r = await call(`${base}/v1/responses`, { method: 'POST', headers: { ...auth, originator: 'codex_cli_rs', session_id: 'client-session' }, body });
  assert.equal(r.status, 200);
  const records = parseSse(r.body);
  assert.equal(records[records.length - 1].event, 'response.completed', 'the Codex backend\'s own events pass through');
  const q = openai.requests[0];
  assert.equal(q.url, '/backend-api/codex/responses');
  assert.equal(q.bearer, 'oat-test-ok');
  assert.equal(q.headers['chatgpt-account-id'], 'acct_ok');
  assert.equal(q.headers.originator, 'codex_cli_rs');
  assert.match(q.headers['user-agent'], /^codex_cli_rs\//);
  assert.notEqual(q.headers.session_id, 'client-session', 'the client\'s session id is replaced');
  const sent = JSON.parse(q.body);
  assert.equal(sent.store, false);
  assert.equal(sent.previous_response_id, undefined);
  assert.deepEqual(sent.include, ['reasoning.encrypted_content']);
  const usage = state.load().usage[config.load().accounts[0].id];
  assert.equal(usage.session.pct, 42);
  assert.equal(usage.week.pct, 7);
  assert.equal(usage.session.resetsAt, 1800000000000);
});

test('a ChatGPT account gets a model its backend lists: the one asked for when listed, else the backend\'s first choice', async () => {
  useLines(['chatgpt', 'ok']);
  const chatgptModels = require('../src/chatgpt-models');
  const [account] = config.load().accounts;
  chatgptModels.forget(account.id);
  // gpt-5.5 is listed by the fake backend: sent as is.
  let r = await call(`${base}/v1/responses`, { method: 'POST', headers: auth, body: { model: 'gpt-5.5', input: 'hi' } });
  assert.equal(JSON.parse(r.body).output[0].content[0].text, 'ok via gpt-5.5');
  assert.equal(openai.modelRequests.length, 1);
  assert.match(openai.modelRequests[0].url, /client_version=\d/);
  // gpt-5.4 isn't: the backend's first choice goes instead, with the list kept from before.
  r = await call(`${base}/v1/responses`, { method: 'POST', headers: auth, body: { model: 'gpt-5.4', input: 'hi' } });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).output[0].content[0].text, 'ok via gpt-6.1-sol');
  assert.equal(openai.modelRequests.length, 1);
  // A Claude name from Claude Code maps to the OpenAI default, and from there onto the list.
  r = await call(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': token, 'anthropic-version': '2026-10-21' }, body: { model: 'claude-opus-5-5', max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(JSON.parse(r.body).content[0].text, 'ok via gpt-5.5');
  assert.deepEqual(state.load().chatgptModels[account.id].slugs, ['gpt-6.1-sol', 'gpt-5.5']);
  // /v1/models lists what the backend listed.
  r = await call(`${base}/v1/models`, { headers: auth });
  assert.ok(JSON.parse(r.body).data.some((m) => m.id === 'gpt-6.1-sol'));
});

test('when the backend\'s list changes under a kept copy, the refused request is sent again with a model it lists now', async () => {
  useLines(['chatgpt', 'ok']);
  const chatgptModels = require('../src/chatgpt-models');
  const [account] = config.load().accounts;
  chatgptModels.forget(account.id);
  await call(`${base}/v1/responses`, { method: 'POST', headers: auth, body: { model: 'gpt-5.5', input: 'hi' } });
  openai.chatgptModels = ['gpt-6.2-sol'];
  try {
    const r = await call(`${base}/v1/responses`, { method: 'POST', headers: auth, body: { model: 'gpt-5.5', input: 'hi' } });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).output[0].content[0].text, 'ok via gpt-6.2-sol');
    assert.equal(openai.requests.filter((q) => q.url === '/backend-api/codex/responses').length, 3, 'the refused request, then the one that worked');
    assert.equal(openai.modelRequests.length, 2);
  } finally {
    openai.chatgptModels = ['gpt-6.1-sol', 'gpt-5.5'];
    chatgptModels.forget(account.id);
  }
});

test('a client that didn\'t ask to stream still gets a whole answer from the Codex backend, which only streams', async () => {
  useLines(['chatgpt', 'ok']);
  const r = await call(`${base}/v1/responses`, { method: 'POST', headers: auth, body: { model: 'gpt-5.5', input: 'hi' } });
  assert.equal(r.status, 200);
  const out = JSON.parse(r.body);
  assert.equal(out.object, 'response');
  assert.equal(out.status, 'completed');
  assert.equal(out.output[0].content[0].text, 'ok via gpt-5.5');
  assert.equal(out.usage.output_tokens, 3);
  assert.equal(JSON.parse(openai.requests[0].body).stream, true);
});

test('Claude Code on a ChatGPT account: translated out as Codex, back as a Claude message', async () => {
  useLines(['chatgpt', 'ok']);
  // Claude Code sends who's asking; the Codex backend refuses that and other fields it doesn't take.
  const r = await call(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': token, 'anthropic-version': '2026-10-21' }, body: { model: 'claude-opus-5-5', max_tokens: 20, metadata: { user_id: 'user_abc' }, messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(r.status, 200, r.body);
  assert.equal(JSON.parse(r.body).content[0].text, 'ok via gpt-5.5');
  assert.equal(openai.requests[0].url, '/backend-api/codex/responses');
  const sent = JSON.parse(openai.requests[0].body);
  assert.equal(sent.user, undefined);
  assert.equal(sent.metadata, undefined);
  assert.deepEqual(sent.include, ['reasoning.encrypted_content']);
});

test('/v1/models puts the service of the line in use first', async () => {
  useLines(['chatgpt', 'ok'], ['key', testKey('ok')]);
  let r = await call(`${base}/v1/models`, { headers: auth });
  let ids = JSON.parse(r.body).data.map((m) => m.id);
  assert.match(ids[0], /^gpt/);
  assert.ok(ids.some((m) => /^claude/.test(m)));
  useLines(['key', testKey('ok')], ['chatgpt', 'ok']);
  r = await call(`${base}/v1/models`, { headers: auth });
  ids = JSON.parse(r.body).data.map((m) => m.id);
  assert.match(ids[0], /^claude/);
});

test('an account at its limit is set aside and the request moves down the order, across services', async () => {
  useLines(['chatgpt', 'limited'], ['claude', 'limited'], ['key', testOpenaiKey('second')]);
  const r = await call(`${base}/v1/chat/completions`, { method: 'POST', headers: auth, body: { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).choices[0].message.content, 'second via gpt-5.5');
  const s = state.load();
  const [chatgpt, claude] = config.load().accounts;
  assert.match(s.accounts[chatgpt.id].reason, /usage limit reached/);
  assert.match(s.accounts[claude.id].reason, /usage limit reached/);
  assert.equal(openai.requests.map((q) => q.url).join(','), '/backend-api/codex/responses,/v1/responses');
  assert.equal(api.requests.length, 1);
});

test('a stale ChatGPT sign-in is renewed with its refresh token and the request sent again', async () => {
  useLines(['chatgpt', 'stale'], ['key', testKey('ok')]);
  const r = await call(`${base}/v1/responses`, { method: 'POST', headers: auth, body: { model: 'gpt-5.5', stream: true, input: 'hi' } });
  assert.equal(r.status, 200);
  const urls = openai.requests.map((q) => `${q.url}:${q.bearer}`);
  assert.deepEqual(urls.slice(0, 3), ['/backend-api/codex/responses:oat-test-stale', '/oauth/token:', '/backend-api/codex/responses:oat-test-ok']);
  assert.equal(api.requests.length, 0, 'the Claude key was never needed');
  const refresh = JSON.parse(openai.requests[1].body);
  assert.equal(refresh.grant_type, 'refresh_token');
  assert.equal(refresh.client_id, 'app_EMoamEEZ73f0CkXaXp7hrann');
  const id = config.load().accounts[0].id;
  assert.equal(vault.load().accounts[id].accessToken, 'oat-test-ok', 'the renewed sign-in is saved');
});

test('a sign-in that expires soon is renewed before it\'s used', async () => {
  useLines(['chatgpt', 'ok', { expiresAt: Date.now() + 60000 }]);
  const r = await call(`${base}/v1/responses`, { method: 'POST', headers: auth, body: { model: 'gpt-5.5', input: 'hi' } });
  assert.equal(r.status, 200);
  assert.equal(openai.requests[0].url, '/oauth/token');
});

test('an OpenAI key out of credit is set aside like a Claude one, and the next key answers', async () => {
  useLines(['key', testOpenaiKey('quota')], ['key', testKey('ok')]);
  const r = await call(`${base}/v1/responses`, { method: 'POST', headers: auth, body: { model: 'gpt-5.5', input: 'hi' } });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).output[0].content[0].text, 'ok');
  const [quota] = vault.load().keys;
  assert.equal(state.load().keys[quota.id].verdict, 'used-up');
});

test('an OpenAI-format client gets OpenAI-shaped errors, and the model list covers every service in use', async () => {
  useLines(['key', testOpenaiKey('ok')], ['key', testKey('ok')]);
  let r = await call(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: { model: 'x', messages: [] } });
  assert.equal(r.status, 401);
  assert.equal(JSON.parse(r.body).error.type, 'authentication_error');
  r = await call(`${base}/v1/models`, { headers: auth });
  const ids = JSON.parse(r.body).data.map((m) => m.id);
  assert.ok(ids.some((m) => /^gpt-/.test(m)) && ids.some((m) => /^claude-/.test(m)));
});

test('an OpenAI key is tested against the free model list', async () => {
  useLines(['key', testOpenaiKey('ok')], ['key', testOpenaiKey('invalid')]);
  const [ok, bad] = vault.load().keys;
  assert.equal((await keys.check(ok, config.load())).verdict, 'ok');
  const r = await keys.check(bad, config.load());
  assert.equal(r.verdict, 'used-up');
  assert.match(r.detail, /Incorrect API key/);
});

test('a ChatGPT account is checked with one small request to the Codex backend', async () => {
  useLines(['chatgpt', 'ok'], ['chatgpt', 'limited']);
  const accounts = require('../src/accounts');
  const [ok, limited] = config.load().accounts;
  assert.deepEqual(await accounts.probe(ok, null), { ok: true, reason: '' });
  const r = await accounts.probe(limited, null);
  assert.equal(r.ok, false);
  assert.match(r.reason, /usage limit reached/);
  assert.equal(state.load().usage[ok.id].session.pct, 42);
});

test('a terminal session can name the account line it runs on, the way Claude Code is started on a ChatGPT account', async () => {
  useLines(['claude', 'ok'], ['chatgpt', 'ok']);
  const [, chatgpt] = config.load().accounts;
  const r = await call(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': token, 'anthropic-version': '2026-10-21', 'x-claude-nonstop-line': `account:${chatgpt.id}` }, body: { model: 'claude-sonnet-5-5', max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(r.status, 200);
  assert.equal(api.requests.length, 0, 'the Claude account above it is left alone');
  assert.equal(openai.requests[0].url, '/backend-api/codex/responses');
  assert.equal(openai.requests[0].headers['x-claude-nonstop-line'], undefined);
  assert.equal(state.load().current, null, 'a named line is a session, recorded by the launcher, not the desktop app');
});

test('the web UI adds a ChatGPT account from Codex\'s own sign-in and reports both services', async () => {
  const fs = require('fs');
  const path = require('path');
  const codexHome = path.join(process.env.CLAUDE_NONSTOP_HOME, 'codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'oat-test-ok', refresh_token: 'refresh-ok', id_token: null, account_id: 'acct_codex' } }));
  process.env.CODEX_HOME = codexHome;
  useLines(['key', testKey('ok')]);
  const ui = require('../src/ui');
  const ctx = require('../src/server').createContext();
  const added = await ui.route('POST', '/api/accounts', { label: 'From Codex', service: 'chatgpt', importCodex: true }, ctx);
  assert.equal(added.imported, true);
  const snap = ui.route('GET', '/api/state', {}, ctx);
  const account = (await snap).accounts.find((a) => a.id === added.id);
  assert.equal(account.provider, 'openai');
  assert.equal(account.kind, 'chatgpt');
  assert.equal(vault.load().accounts[added.id].accountId, 'acct_codex');
  const statuses = await ui.route('GET', '/api/accounts/status', {}, ctx);
  assert.equal(statuses[added.id].loggedIn, true);
  await ui.route('DELETE', `/api/accounts/${added.id}`, {}, ctx);
  assert.equal(vault.load().accounts[added.id], undefined, 'removing the account forgets its sign-in');
  delete process.env.CODEX_HOME;
});
