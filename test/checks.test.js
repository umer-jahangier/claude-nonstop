'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { isolate, installFakeClaude, startFakeApi, testKey, readFakeLog } = require('./helpers');

const { root } = isolate();
process.env.CLAUDE_NONSTOP_CLAUDE = installFakeClaude(root);
const vault = require('../src/vault');
const keys = require('../src/keys');
const config = require('../src/config');
const accounts = require('../src/accounts');
const state = require('../src/state');
const events = require('../src/events');
const checks = require('../src/checks');

let api;
let work;
const probes = () => readFakeLog().filter((e) => e.kind === 'probe').length;

before(async () => {
  api = await startFakeApi();
  process.env.CLAUDE_NONSTOP_UPSTREAM = api.url;
  work = { ...accounts.createProfile('Work'), enabled: false };
  config.update((c) => c.accounts.push(work));
  vault.update((v) => {
    v.keys = [keys.newEntry(testKey('ok'), 'Personal', 1), keys.newEntry(testKey('credit'), 'Old', 2)];
  });
});
after(() => api.close());

test('checks every account that is on and every key, and tells open pages as each starts and ends', async () => {
  const seen = [];
  const listen = (e) => e.type === 'checks' && seen.push(e.checking ? 'start' : 'end');
  events.bus.on('event', listen);
  const run = checks.all();
  assert.equal(checks.checking().length, 3, 'Main and both keys, but not Work, which is off');
  await run;
  events.bus.removeListener('event', listen);
  const s = state.load();
  const [personal, old] = vault.load().keys;
  assert.equal(s.accounts.default.ok, true);
  assert.equal(s.accounts[work.id], undefined);
  assert.equal(s.keys[personal.id].verdict, 'ok');
  assert.equal(s.keys[old.id].verdict, 'used-up');
  assert.deepEqual(checks.checking(), []);
  assert.deepEqual(seen.sort(), ['end', 'end', 'end', 'start', 'start', 'start']);
  assert.equal(events.recent().filter((e) => e.type === 'checks').length, 0, 'kept out of the activity feed');
});

test('checking again soon leaves clear answers alone and retries unclear ones', async () => {
  const [, old] = vault.load().keys;
  state.recordKey(old.id, { verdict: 'keep', status: 0, detail: 'no answer' });
  const sent = api.requests.length;
  const probed = probes();
  await checks.all({ freshMs: 60000 });
  assert.deepEqual(api.requests.slice(sent).map((r) => r.key), [old.key], 'only the key without a clear answer');
  assert.equal(probes(), probed, 'Main had usage left a moment ago');
});

test("a line that's already being checked isn't checked twice at once", async () => {
  const [personal] = vault.load().keys;
  const sent = api.requests.length;
  const [a, b] = await Promise.all([checks.key(personal), checks.key(personal)]);
  assert.equal(api.requests.length - sent, 1);
  assert.equal(a, b);
});
