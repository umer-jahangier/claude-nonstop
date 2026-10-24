'use strict';

const { test, before, after } = require('node:test');
const http = require('http');
const assert = require('node:assert/strict');
const { isolate, installFakeClaude, startFakeApi, testKey, call } = require('./helpers');

const { root } = isolate();
process.env.CLAUDE_NONSTOP_CLAUDE = installFakeClaude(root);
const vault = require('../src/vault');
const { createServer, createContext } = require('../src/server');

let api;
let server;
let base;
let cookie;

const apiCall = (method, path, body, extra = {}) => call(`${base}${path}`, { method, body, headers: { cookie, 'x-claude-nonstop': '1', ...extra } });

before(async () => {
  api = await startFakeApi();
  process.env.CLAUDE_NONSTOP_UPSTREAM = api.url;
  server = createServer(createContext());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await api.close();
});

test('the page needs the one-time link', async () => {
  const page = await call(`${base}/`);
  assert.equal(page.status, 401);
  const wrong = await call(`${base}/auth?t=cn_wrong`);
  assert.equal(wrong.status, 403);
  const { uiToken } = vault.loadWithTokens();
  const ok = await call(`${base}/auth?t=${uiToken}`);
  assert.equal(ok.status, 302);
  assert.match(ok.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
  cookie = ok.headers['set-cookie'][0].split(';')[0];
  const signedIn = await call(`${base}/`, { headers: { cookie } });
  assert.equal(signedIn.status, 200);
  assert.match(signedIn.headers['content-security-policy'], /default-src 'none'/);
  assert.match(signedIn.body, /claude-nonstop/);
});

test('the API refuses calls without the cookie, the header, or from another origin', async () => {
  assert.equal((await call(`${base}/api/state`, { headers: { 'x-claude-nonstop': '1' } })).status, 403);
  assert.equal((await call(`${base}/api/state`, { headers: { cookie } })).status, 403);
  assert.equal((await apiCall('GET', '/api/state', undefined, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await apiCall('GET', '/api/state')).status, 200);
});

test('adding a key tests it and never sends the full key back', async () => {
  const r = await apiCall('POST', '/api/keys', { key: testKey('ok'), label: 'Personal' });
  assert.equal(r.status, 200, r.body);
  assert.equal(JSON.parse(r.body).check.verdict, 'ok');
  await apiCall('POST', '/api/keys', { key: testKey('credit'), label: 'Team' });
  const state = await apiCall('GET', '/api/state');
  assert.ok(!state.body.includes(testKey('ok')), 'state leaks a full key');
  const s = JSON.parse(state.body);
  assert.deepEqual(s.keys.map((k) => k.label), ['Personal', 'Team']);
  assert.equal(s.keys[1].lastCheck.verdict, 'used-up');
  assert.equal(s.keys[1].coolingDown, true);
});

test('refuses duplicates, subscription tokens and things that are not keys', async () => {
  assert.equal((await apiCall('POST', '/api/keys', { key: testKey('ok') })).status, 409);
  const oauth = await apiCall('POST', '/api/keys', { key: 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123' });
  assert.equal(oauth.status, 400);
  assert.match(JSON.parse(oauth.body).error, /subscription/);
  assert.equal((await apiCall('POST', '/api/keys', { key: 'nope' })).status, 400);
});

test('reorders, renames and removes keys', async () => {
  let s = JSON.parse((await apiCall('GET', '/api/state')).body);
  const team = s.keys[1];
  await apiCall('POST', `/api/keys/${team.id}/move`, { direction: 'up' });
  await apiCall('PATCH', `/api/keys/${team.id}`, { label: 'Team budget' });
  s = JSON.parse((await apiCall('GET', '/api/state')).body);
  assert.deepEqual(s.keys.map((k) => k.label), ['Team budget', 'Personal']);
  await apiCall('DELETE', `/api/keys/${team.id}`);
  s = JSON.parse((await apiCall('GET', '/api/state')).body);
  assert.deepEqual(s.keys.map((k) => k.label), ['Personal']);
});

test('adds an account, signs it in through Claude Code, and reports its status', async () => {
  const r = await apiCall('POST', '/api/accounts', { label: 'Work' });
  assert.equal(r.status, 200, r.body);
  const { id, job } = JSON.parse(r.body);
  let view;
  for (let i = 0; i < 50; i++) {
    view = JSON.parse((await apiCall('GET', `/api/jobs/${job}`)).body);
    if (view.done) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(view.done, true);
  assert.equal(view.ok, true);
  // Signing in is followed by a usage check without anyone asking for one.
  let work;
  for (let i = 0; i < 50; i++) {
    const s = JSON.parse((await apiCall('GET', '/api/state')).body);
    work = s.accounts.find((a) => a.id === id);
    if (work.lastCheck && !s.checking.includes(id)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(work.lastCheck.ok, true, 'checked by itself after signing in');
  const statuses = JSON.parse((await apiCall('GET', '/api/accounts/status')).body);
  assert.equal(statuses[id].loggedIn, true);
  const check = JSON.parse((await apiCall('POST', `/api/accounts/${id}/check`)).body);
  assert.equal(check.ok, true);
  await apiCall('PATCH', `/api/accounts/${id}`, { enabled: false });
  const s = JSON.parse((await apiCall('GET', '/api/state')).body);
  assert.deepEqual(s.accounts.map((a) => [a.label, a.enabled]), [['Main account', true], ['Work', false]]);
  assert.equal((await apiCall('DELETE', '/api/accounts/default')).status, 400);
  assert.equal((await apiCall('DELETE', `/api/accounts/${id}`)).status, 200);
});

test('validates timing settings', async () => {
  assert.equal((await apiCall('PATCH', '/api/settings', { cooldownMinutes: 0 })).status, 400);
  assert.equal((await apiCall('PATCH', '/api/settings', { cooldownMinutes: 45 })).status, 200);
  assert.equal(JSON.parse((await apiCall('GET', '/api/state')).body).settings.cooldownMinutes, 45);
});

test('writes the desktop app file with the gateway address and token', async () => {
  const r = JSON.parse((await apiCall('POST', '/api/desktop')).body);
  assert.equal(r.settings.inferenceProvider, 'gateway');
  assert.match(r.settings.inferenceGatewayBaseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(r.settings.inferenceGatewayApiKey, vault.loadWithTokens().gatewayToken);
});

test('the live stream needs the cookie', async () => {
  assert.equal((await call(`${base}/api/events`)).status, 403);
});

test('plugging the rope into a line pins it, and the live stream reports it', async () => {
  const s = JSON.parse((await apiCall('GET', '/api/state')).body);
  const key = s.keys[0];
  const chunks = [];
  const req = await new Promise((resolve) => {
    const r = http.get(`${base}/api/events`, { headers: { cookie } }, (res) => {
      assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
      res.setEncoding('utf8');
      res.on('data', (d) => chunks.push(d));
      resolve(r);
    });
  });
  try {
    assert.equal((await apiCall('PUT', '/api/pin', { type: 'key', id: key.id })).status, 200);
    assert.deepEqual(JSON.parse((await apiCall('GET', '/api/state')).body).pinned, { type: 'key', id: key.id });
    assert.equal((await apiCall('PUT', '/api/pin', { type: 'key', id: 'missing' })).status, 404);
    assert.equal((await apiCall('PUT', '/api/pin', { type: 'nonsense', id: key.id })).status, 400);
    assert.equal((await apiCall('DELETE', '/api/pin')).status, 200);
    assert.equal(JSON.parse((await apiCall('GET', '/api/state')).body).pinned, null);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const events = chunks.join('').split('\n\n').filter((x) => x.startsWith('data: ')).map((x) => JSON.parse(x.slice(6)));
    assert.deepEqual(events.filter((e) => e.type === 'pin').map((e) => e.pinType), ['key', null]);
  } finally {
    req.destroy();
  }
});
