'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { isolate, installFakeClaude, readFakeLog, startFakeApi, testKey, testAccountToken, signInFakeAccount, call } = require('./helpers');
const fs = require('fs');
const path = require('path');

const { root } = isolate();
process.env.CLAUDE_NONSTOP_CLAUDE = installFakeClaude(root);
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

// Turns every account off, so key-only tests see only keys.
function noAccounts() {
  config.update((c) => (c.accounts = c.accounts.map((a) => ({ ...a, enabled: false }))));
}

// Subscription accounts in the relay, each with a sign-in of the given kind ('ok' or 'limited').
function useAccounts(...kinds) {
  config.update((c) => {
    c.accounts = kinds.map((kind, i) => {
      const configDir = path.join(process.env.CLAUDE_NONSTOP_HOME, 'profiles', `acct-${kind}-${i}`);
      signInFakeAccount(configDir, kind);
      return { id: `acct-${kind}-${i}`, label: `${kind} account ${i + 1}`, kind: 'profile', configDir, enabled: true };
    });
    delete c.order;
  });
  state.clearCooldowns();
}

before(async () => {
  api = await startFakeApi();
  process.env.CLAUDE_NONSTOP_UPSTREAM = api.url;
  token = vault.loadWithTokens().gatewayToken;
  noAccounts();
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

test("the desktop app's key is recorded apart from the line terminal sessions are on", async () => {
  useKeys('second');
  state.setCurrent('Main account');
  const r = await call(`${base}/v1/messages`, { method: 'POST', body: message(), headers: { 'x-api-key': token } });
  assert.equal(r.status, 200);
  const s = state.load();
  assert.equal(s.current, 'Main account', 'still where terminal sessions are');
  assert.equal(s.desktop.label, 'second');
});

test("a request on an API key goes out as plain API: no client identity, no Claude Code or OAuth betas, whoever sent it", async () => {
  useKeys('ok');
  const [entry] = vault.load().keys;
  api.requests.length = 0;
  // The desktop app: its own identity and whatever betas it sends.
  await call(`${base}/v1/messages`, {
    method: 'POST',
    body: message(),
    headers: { 'x-api-key': token, 'user-agent': 'Claude/1.0 Electron', 'x-app': 'desktop', 'anthropic-beta': 'oauth-2025-04-20, fine-grained-tool-streaming-2025-05-14' },
  });
  // A terminal session, which names itself as Claude Code.
  await call(`${base}/v1/messages`, {
    method: 'POST',
    body: message(),
    headers: { 'x-api-key': token, 'x-claude-nonstop-keys': entry.id, 'user-agent': 'claude-cli/2.1.310 (external, cli)', 'x-app': 'cli', 'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219' },
  });
  const [desktop, session] = api.requests;
  assert.equal(desktop.headers['anthropic-beta'], 'fine-grained-tool-streaming-2025-05-14', 'the feature beta stays, the flags go');
  assert.equal(desktop.headers['x-app'], undefined);
  assert.ok(!/Claude\/1\.0/.test(String(desktop.headers['user-agent'] || '')));
  assert.equal(desktop.key, entry.key);
  assert.equal(session.headers['anthropic-beta'], undefined);
  assert.equal(session.headers['x-app'], undefined);
  assert.ok(!/claude-cli/.test(String(session.headers['user-agent'] || '')), 'any Claude Code signal would bill the key as Claude Code');
  assert.equal(session.key, entry.key);
});

test('the desktop app runs on your subscription accounts first, in your order, and moves to the next line when one is at its limit', async () => {
  useKeys('ok');
  useAccounts('limited', 'ok');
  try {
    api.requests.length = 0;
    const r = await call(`${base}/v1/messages`, { method: 'POST', body: message(), headers: { 'x-api-key': token, 'user-agent': 'Claude/1.0 Electron' } });
    assert.equal(r.status, 200);
    assert.deepEqual(api.requests.map((q) => q.bearer), [testAccountToken('limited'), testAccountToken('ok')], 'the limited account, then the next one; no key spent');
    assert.ok(api.requests.every((q) => !q.key));
    const second = api.requests[1];
    assert.match(second.headers['user-agent'], /^claude-cli\//, 'a subscription sign-in goes out as Claude Code');
    assert.equal(second.headers['anthropic-beta'], 'oauth-2025-04-20', 'the OAuth beta only: the claude-code beta is refused on a sign-in');
    const s = state.load();
    assert.equal(s.accounts['acct-limited-0'].ok, false, 'the limit is remembered');
    assert.match(s.desktop.label, /ok account 2/);

    api.requests.length = 0;
    await call(`${base}/v1/messages`, { method: 'POST', body: message(), headers: { 'x-api-key': token } });
    assert.deepEqual(api.requests.map((q) => q.bearer), [testAccountToken('ok')], 'the limited account is skipped for a while');
  } finally {
    noAccounts();
  }
});

test('an expired sign-in is renewed through Claude Code, not passed over (a server where nothing else runs Claude Code)', async () => {
  useKeys('credit');
  useAccounts('ok');
  const dir = config.load().accounts[0].configDir;
  signInFakeAccount(dir, 'ok', { expiresAt: Date.now() - 14 * 3600000 });
  try {
    api.requests.length = 0;
    const r = await call(`${base}/v1/messages`, { method: 'POST', body: message(), headers: { 'x-api-key': token, 'user-agent': 'Claude/1.0 Electron' } });
    assert.equal(r.status, 200, r.body);
    assert.ok(readFakeLog().some((e) => e.kind === 'renewed'), 'Claude Code renewed the sign-in');
    assert.deepEqual(api.requests.filter((q) => q.url === '/v1/messages').map((q) => q.bearer), [testAccountToken('ok')], 'and the request went out on the account');

    // A sign-in that can't be renewed is passed over, and the request moves on.
    signInFakeAccount(dir, 'ok', { expiresAt: Date.now() - 1000 });
    process.env.FAKE_CLAUDE_NO_RENEW = '1';
    useKeys('ok');
    api.requests.length = 0;
    const next = await call(`${base}/v1/messages`, { method: 'POST', body: message(), headers: { 'x-api-key': token, 'user-agent': 'Claude/1.0 Electron' } });
    assert.equal(next.status, 200);
    assert.equal(api.requests.at(-1).key, testKey('ok'));
  } finally {
    delete process.env.FAKE_CLAUDE_NO_RENEW;
    noAccounts();
  }
});

test('the gateway renews sign-ins that are about to expire, before any request needs them', async () => {
  useAccounts('ok');
  const dir = config.load().accounts[0].configDir;
  signInFakeAccount(dir, 'ok', { expiresAt: Date.now() + 2 * 60000 });
  try {
    await require('../src/gateway').renewExpiring(config.load());
    const after = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8')).claudeAiOauth.expiresAt;
    assert.ok(after > Date.now() + 3600000);
  } finally {
    noAccounts();
  }
});

test("a subscription sign-in gets Claude Code's system line first, since Anthropic takes only Claude Code's requests on it", async () => {
  useKeys();
  useAccounts('ok');
  try {
    api.requests.length = 0;
    // The desktop app's startup probe: no system prompt at all.
    let r = await call(`${base}/v1/messages`, { method: 'POST', body: message(), headers: { 'x-api-key': token } });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(api.requests[0].body).system, "You are Claude Code, Anthropic's official CLI for Claude.");
    // A chat with its own system prompt keeps it, after the line.
    r = await call(`${base}/v1/messages`, { method: 'POST', body: message({ system: 'Be brief.' }), headers: { 'x-api-key': token } });
    assert.equal(r.status, 200);
    const sys = JSON.parse(api.requests[1].body).system;
    assert.match(sys[0].text, /^You are Claude Code/);
    assert.equal(sys[1].text, 'Be brief.');
    // One that already opens with the line goes out as it is.
    const own = message({ system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude. More." }] });
    await call(`${base}/v1/messages`, { method: 'POST', body: own, headers: { 'x-api-key': token } });
    assert.equal(api.requests[2].body, JSON.stringify(own));
    assert.equal(state.load().accounts['acct-ok-0']?.ok, undefined, 'a passing refusal never set the account aside');
  } finally {
    noAccounts();
  }
});

test('when every account is out, the desktop app goes on to API keys, as plain API', async () => {
  useKeys('ok');
  useAccounts('limited');
  try {
    api.requests.length = 0;
    const r = await call(`${base}/v1/messages`, { method: 'POST', body: message(), headers: { 'x-api-key': token, 'anthropic-beta': 'claude-code-20250219' } });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).id, 'msg_ok');
    const last = api.requests[api.requests.length - 1];
    assert.equal(last.key, testKey('ok'));
    assert.equal(last.headers['anthropic-beta'], undefined);
    assert.equal(last.headers['x-app'], undefined);
  } finally {
    noAccounts();
  }
});

test('a request already signed in to a Claude.ai account passes through untouched', async () => {
  useKeys('ok');
  api.requests.length = 0;
  // Claude Code's own request: it already opens with its system line.
  const r = await call(`${base}/v1/messages`, {
    method: 'POST',
    body: message({ system: "You are Claude Code, Anthropic's official CLI for Claude." }),
    headers: { authorization: `Bearer ${testAccountToken('ok')}`, 'user-agent': 'claude-cli/2.1.310 (external, cli)', 'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219' },
  });
  assert.equal(r.status, 200);
  const [q] = api.requests;
  assert.equal(q.bearer, testAccountToken('ok'));
  assert.equal(q.key, '', 'no key spent');
  assert.equal(q.headers['anthropic-beta'], 'oauth-2025-04-20,claude-code-20250219');
});

test('forwards model listing for the desktop app', async () => {
  useKeys('ok');
  const r = await call(`${base}/v1/models`, { headers: { 'x-api-key': token } });
  assert.equal(r.status, 200);
});

test('the model list comes from an account when there is no key, and from a built-in list when nothing can answer', async () => {
  useKeys();
  useAccounts('ok');
  try {
    api.requests.length = 0;
    let r = await call(`${base}/v1/models`, { headers: { 'x-api-key': token } });
    assert.equal(r.status, 200);
    assert.equal(api.requests[0].bearer, testAccountToken('ok'));
    assert.equal(state.load().desktop.label.includes('ok account'), false, 'listing models is not use');
    noAccounts();
    r = await call(`${base}/v1/models`, { headers: { 'x-api-key': token } });
    assert.equal(r.status, 200, 'the app can still connect');
    assert.ok(JSON.parse(r.body).data.some((m) => /^claude-/.test(m.id)));
  } finally {
    noAccounts();
  }
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

test('a request on a key leaves out the system blocks that mark it as Claude Code', () => {
  const { asPlainApiBody } = require('../src/gateway');
  const id = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
  const send = (system) => JSON.parse(asPlainApiBody(Buffer.from(JSON.stringify({ messages: [], system }))).toString('utf8')).system;

  assert.deepEqual(send([
    { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.308; cc_entrypoint=claude-desktop-3p;' },
    { type: 'text', text: id },
    { type: 'text', text: 'Be helpful.', cache_control: { type: 'ephemeral' } },
  ]), [{ type: 'text', text: `${id}\n\nBe helpful.`, cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(send([{ type: 'text', text: id }]), [{ type: 'text', text: `${id}\n` }]);
  assert.equal(send(id), `${id}\n`);
  assert.equal(send('You are a helpful assistant.'), 'You are a helpful assistant.');

  const untouched = Buffer.from('{"messages":[],"system":[{"type":"text","text":"Hi"}]}');
  assert.equal(asPlainApiBody(untouched), untouched);
  assert.equal(asPlainApiBody(Buffer.from('not json')).toString(), 'not json');
});
