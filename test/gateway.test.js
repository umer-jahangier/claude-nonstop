'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { isolate, startFakeApi, testKey, call } = require('./helpers');

isolate();
const vault = require('../src/vault');
const keys = require('../src/keys');
const state = require('../src/state');
const config = require('../src/config');
const { createServer, createContext } = require('../src/server');

let api;
let server;
let base;
let token;

function useKeys(...kinds) {
  vault.update((v) => {
    v.keys = kinds.map((kind, i) => keys.newEntry(testKey(kind), kind, i + 1));
  });
  state.clearCooldowns();
}

before(async () => {
  api = await startFakeApi();
  process.env.CLAUDE_NONSTOP_UPSTREAM = api.url;
  token = vault.loadWithTokens().gatewayToken;
  server = createServer(createContext());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await api.close();
});

const message = (extra = {}) => ({ model: 'claude-sonnet-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], ...extra });

test('refuses requests without the gateway token', async () => {
  useKeys('ok');
  const r = await call(`${base}/v1/messages`, { method: 'POST', body: message() });
  assert.equal(r.status, 401);
  const wrong = await call(`${base}/v1/messages`, { method: 'POST', body: message(), headers: { 'x-api-key': 'cn_wrong' } });
  assert.equal(wrong.status, 401);
});

test('only answers under 127.0.0.1 or localhost', async () => {
  const r = await call(`${base}/health`, { headers: { host: 'evil.example:80' } });
  assert.equal(r.status, 403);
  const ok = await call(`${base}/health`);
  assert.equal(JSON.parse(ok.body).name, 'claude-nonstop');
});

test('sends the same request again on the next key when one is used up', async () => {
  useKeys('credit', 'billing', 'second');
  api.requests.length = 0;
  const r = await call(`${base}/v1/messages`, { method: 'POST', body: message(), headers: { authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).id, 'msg_second');
  assert.deepEqual(api.requests.map((q) => q.key), [testKey('credit'), testKey('billing'), testKey('second')]);
  // Every attempt carried the exact same body, and the client's own token never went upstream.
  assert.ok(api.requests.every((q) => q.body === JSON.stringify(message())));
  assert.ok(api.requests.every((q) => !String(q.headers.authorization || '').includes(token)));
});

test('remembers used-up keys, so later requests go straight to a working one', async () => {
  api.requests.length = 0;
  const r = await call(`${base}/v1/messages`, { method: 'POST', body: message(), headers: { 'x-api-key': token } });
  assert.equal(r.status, 200);
  assert.deepEqual(api.requests.map((q) => q.key), [testKey('second')]);
});

test('streams server-sent events through untouched', async () => {
  useKeys('credit', 'ok');
  const body = JSON.stringify(message({ stream: true }));
  const text = await new Promise((resolve, reject) => {
    const req = http.request(
      `${base}/v1/messages`,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-api-key': token } },
      (res) => {
        assert.equal(res.headers['content-type'], 'text/event-stream');
        let all = '';
        res.on('data', (d) => (all += d));
        res.on('end', () => resolve(all));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
  assert.match(text, /"served_by":"ok"/);
  assert.match(text, /message_stop/);
});

test('passes through errors that are not the key\'s fault, without switching', async () => {
  useKeys('ratelimit', 'ok');
  api.requests.length = 0;
  const r = await call(`${base}/v1/messages`, { method: 'POST', body: message(), headers: { 'x-api-key': token } });
  assert.equal(r.status, 429);
  assert.equal(api.requests.length, 1);
});

test('says clearly when every key is used up', async () => {
  useKeys('credit', 'invalid');
  let r = await call(`${base}/v1/messages`, { method: 'POST', body: message(), headers: { 'x-api-key': token } });
  assert.equal(r.status, 402);
  assert.match(JSON.parse(r.body).error.message, /no API key has credit.*sign in to Claude\.ai in the desktop app/, 'the desktop app hears how to use its subscription');
  const ids = vault.load().keys.map((k) => k.id).join(',');
  r = await call(`${base}/v1/messages`, { method: 'POST', body: message(), headers: { 'x-api-key': token, 'x-claude-nonstop-keys': ids } });
  assert.match(JSON.parse(r.body).error.message, /every API key is used up/);
});

test('lists models even while every key is set aside, so the desktop app can connect', async () => {
  useKeys('ok');
  const [entry] = vault.load().keys;
  state.recordKey(entry.id, { verdict: 'used-up', status: 400, detail: 'Your credit balance is too low' });
  state.setDesktop('earlier');
  const models = await call(`${base}/v1/models`, { headers: { 'x-api-key': token } });
  assert.equal(models.status, 200);
  assert.equal(state.load().desktop.label, 'earlier', 'listing models is not use');
  const r = await call(`${base}/v1/messages`, { method: 'POST', body: message(), headers: { 'x-api-key': token } });
  assert.equal(r.status, 402, 'real requests still skip it');
});

test("a key whose credit doesn't cover Claude Code is set aside for every request, since each goes out as Claude Code", async () => {
  useKeys('ok');
  const [entry] = vault.load().keys;
  state.recordKey(entry.id, { verdict: 'used-up', status: 400, detail: 'Your credit balance is too low', scope: 'claude-code' });
  let r = await call(`${base}/v1/messages`, { method: 'POST', body: message(), headers: { 'x-api-key': token } });
  assert.equal(r.status, 402, 'the desktop app is billed as Claude Code too');
  r = await call(`${base}/v1/messages`, { method: 'POST', body: message(), headers: { 'x-api-key': token, 'user-agent': 'claude-cli/2.1.310 (external, cli)' } });
  assert.equal(r.status, 402);
  r = await call(`${base}/v1/messages`, { method: 'POST', body: message(), headers: { 'x-api-key': token, 'anthropic-beta': 'claude-code-20250219' } });
  assert.equal(r.status, 402);
});

test("the desktop app's key is recorded apart from the line terminal sessions are on", async () => {
  useKeys('second');
  state.setCurrent('Main account');
  const r = await call(`${base}/v1/messages`, { method: 'POST', body: message(), headers: { 'x-api-key': token } });
  assert.equal(r.status, 200);
  const s = state.load();
  assert.equal(s.current, 'Main account', 'still where terminal sessions are');
  assert.equal(s.desktop.label, 'second');
});

test('drops OAuth beta flags, since requests go out with an API key', async () => {
  useKeys('ok');
  api.requests.length = 0;
  await call(`${base}/v1/messages`, {
    method: 'POST',
    body: message(),
    headers: { 'x-api-key': token, 'anthropic-beta': 'oauth-2025-04-20, fine-grained-tool-streaming-2025-05-14' },
  });
  assert.equal(api.requests[0].headers['anthropic-beta'], 'fine-grained-tool-streaming-2025-05-14,claude-code-20250219');
});

test('every request goes out as Claude Code, the desktop app\'s included', async () => {
  useKeys('ok');
  api.requests.length = 0;
  // The desktop app: no Claude Code headers of its own, and a browser-ish user agent.
  await call(`${base}/v1/messages`, { method: 'POST', body: message(), headers: { 'x-api-key': token, 'user-agent': 'Claude/1.0 Electron' } });
  // A terminal session, which already names itself.
  await call(`${base}/v1/messages`, { method: 'POST', body: message(), headers: { 'x-api-key': token, 'user-agent': 'claude-cli/2.1.310 (external, cli)', 'anthropic-beta': 'claude-code-20250219' } });
  for (const r of api.requests) {
    assert.match(r.headers['user-agent'], /^claude-cli\//, 'the CLI user agent, whoever asked');
    assert.equal(r.headers['x-app'], 'cli');
    assert.equal(r.headers['anthropic-beta'], 'claude-code-20250219', 'the beta the key probe uses, exactly once');
  }
});

test('forwards model listing for the desktop app', async () => {
  useKeys('ok');
  const r = await call(`${base}/v1/models`, { headers: { 'x-api-key': token } });
  assert.equal(r.status, 200);
});

test('a session sent to one group of keys uses only those, in your order, and skips paused keys', async () => {
  useKeys('credit', 'ok', 'second');
  const [credit, ok, second] = vault.load().keys;
  const send = (group) => call(`${base}/v1/messages`, { method: 'POST', body: message(), headers: { 'x-api-key': token, 'x-claude-nonstop-keys': group } });
  api.requests.length = 0;
  let r = await send(`${credit.id},${second.id}`);
  assert.equal(JSON.parse(r.body).id, 'msg_second', 'moved past the used-up key, but not to the key outside the group');
  assert.deepEqual(api.requests.map((q) => q.key), [credit.key, second.key]);
  assert.equal(api.requests[1].headers['x-claude-nonstop-keys'], undefined, 'the group header stays on this computer');

  config.update((c) => (c.pausedKeys = [second.id]));
  try {
    r = await send(`${credit.id},${second.id}`);
    assert.equal(r.status, 402, 'nothing left in the group, so the session can move on');
    api.requests.length = 0;
    r = await call(`${base}/v1/messages`, { method: 'POST', body: message(), headers: { 'x-api-key': token } });
    assert.equal(JSON.parse(r.body).id, 'msg_ok', 'without a group (the desktop app), any key that is not paused');
    assert.deepEqual(api.requests.map((q) => q.key), [ok.key]);
  } finally {
    config.update((c) => delete c.pausedKeys);
  }
});

test('a key pinned from the web UI takes every request at once', async () => {
  useKeys('ok', 'second');
  config.update((c) => (c.pinned = { type: 'key', id: keys.fingerprint(testKey('second')) }));
  try {
    api.requests.length = 0;
    const r = await call(`${base}/v1/messages`, { method: 'POST', body: message(), headers: { 'x-api-key': token } });
    assert.equal(JSON.parse(r.body).id, 'msg_second');
    assert.deepEqual(api.requests.map((q) => q.key), [testKey('second')]);
  } finally {
    config.update((c) => (c.pinned = null));
  }
});
