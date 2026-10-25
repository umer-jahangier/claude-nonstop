'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { isolate, startFakeApi, testKey } = require('./helpers');

isolate();
const keys = require('../src/keys');
const state = require('../src/state');
const config = require('../src/config');

let api;
before(async () => {
  api = await startFakeApi();
  process.env.CLAUDE_NONSTOP_UPSTREAM = api.url;
});
after(() => api.close());

const entries = (...kinds) => kinds.map((kind, i) => keys.newEntry(testKey(kind), kind, i + 1));

test('skips used-up keys and picks the first one that works', async () => {
  const list = entries('credit', 'billing', 'spend', 'ok', 'second');
  const picked = await keys.pick(list, config.load());
  assert.equal(picked.label, 'ok');
  assert.deepEqual(
    api.requests.map((r) => r.key),
    [testKey('credit'), testKey('billing'), testKey('spend'), testKey('ok')],
  );
});

test("used-up keys are skipped without asking again until their cooldown ends", async () => {
  api.requests.length = 0;
  const list = entries('credit', 'billing', 'spend', 'ok');
  const picked = await keys.pick(list, config.load());
  assert.equal(picked.label, 'ok');
  assert.deepEqual(api.requests.map((r) => r.key), [testKey('ok')]);
});

test('after the cooldown a used-up key is checked again', async () => {
  api.requests.length = 0;
  const [credit] = entries('credit');
  state.recordKey(credit.id, { verdict: 'used-up', status: 400, detail: '', at: 0 });
  // Pretend the mark is 31 minutes old.
  const s = state.load();
  s.keys[credit.id].at = Date.now() - 31 * 60000;
  require('../src/files').writeJson(require('../src/paths').STATE, s);
  await keys.pick([credit], config.load());
  assert.deepEqual(api.requests.map((r) => r.key), [testKey('credit')]);
});

test('returns null when every key is used up', async () => {
  assert.equal(await keys.pick(entries('credit', 'invalid'), config.load()), null);
});

test("stays on a key when the problem isn't the key", async () => {
  for (const kind of ['badreq', 'overloaded', 'ratelimit']) {
    const picked = await keys.pick(entries(kind, 'ok'), config.load());
    assert.equal(picked.label, kind);
  }
});

test('the probe is the smallest possible request', async () => {
  api.requests.length = 0;
  await keys.check(entries('ok')[0], config.load());
  const sent = JSON.parse(api.requests[0].body);
  assert.equal(sent.max_tokens, 1);
  assert.equal(sent.model, 'claude-haiku-5-5');
  assert.equal(api.requests[0].headers['anthropic-version'], keys.API_VERSION);
  assert.equal(api.requests[0].headers['anthropic-beta'], 'claude-code-20250219', 'asked the way Claude Code is billed');
});

test("a key whose credit doesn't cover Claude Code is marked as such", async () => {
  const result = await keys.check(entries('credit')[0], config.load());
  assert.equal(result.verdict, 'used-up');
  assert.equal(result.scope, 'claude-code');
});

test('recognizes what is and is not an API key', () => {
  assert.equal(keys.problemWith(testKey('ok')), null);
  assert.match(keys.problemWith('sk-ant-oat01-abcdefghijklmnopqrstuvwxyz'), /subscription/);
  assert.match(keys.problemWith('sk-ant-admin01-abcdefghijklmnopqrstuvwxyz'), /Admin/);
  assert.match(keys.problemWith('hello'), /doesn't look like/);
  assert.ok(!keys.mask(testKey('ok')).includes('xxxxxxxxxxxx'));
});
