'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { isolate, installFakeClaude, startFakeApi, testKey, freePort, runCli, readFakeLog } = require('./helpers');

const { root } = isolate();
const fakeClaude = installFakeClaude(root);
const vault = require('../src/vault');
const keys = require('../src/keys');
const config = require('../src/config');
const accounts = require('../src/accounts');
const state = require('../src/state');
const supervise = require('../src/supervise');

const CONTINUE = supervise.CONTINUE_PROMPT;
const limitedFile = path.join(root, 'limited.txt');
let api;
let work;

before(async () => {
  api = await startFakeApi();
  Object.assign(process.env, { CLAUDE_NONSTOP_CLAUDE: fakeClaude, CLAUDE_NONSTOP_UPSTREAM: api.url, CLAUDE_NONSTOP_PORT: String(await freePort()) });
  work = accounts.createProfile('Work');
  config.update((c) => c.accounts.push(work));
});
after(() => api.close());

function setup({ withWork, withKeys }) {
  fs.rmSync(process.env.FAKE_CLAUDE_LOG, { force: true });
  fs.rmSync(limitedFile, { force: true });
  fs.rmSync(path.join(process.env.CLAUDE_NONSTOP_HOME, 'state.json'), { force: true });
  config.update((c) => { c.accounts.find((a) => a.id === work.id).enabled = withWork; });
  vault.update((v) => { v.keys = withKeys ? [keys.newEntry(testKey('ok'), 'Personal', 1)] : []; });
}

const run = (env) => runCli(['run'], { env: { CLAUDE_NONSTOP_SUPERVISE: '1', FAKE_CLAUDE_LIMITED_FILE: limitedFile, FAKE_CLAUDE_WAIT_MS: '2500', ...env } });
// Sessions as they started and ended. A stopped session only gets to record its stop on
// macOS and Linux (Windows ends it with taskkill), so stops are left out.
const log = () => readFakeLog().filter((e) => !['probe', 'auth-status', 'stopped'].includes(e.kind));

test('reopening keeps your flags, drops the old prompt, and resumes the same conversation', () => {
  assert.deepEqual(supervise.resumeArgs(['--model', 'opus', 'fix the bug'], 'S1'), ['--model', 'opus', '--resume', 'S1', CONTINUE]);
  assert.deepEqual(
    supervise.resumeArgs(['-c', '--add-dir', 'a', 'b', '--dangerously-skip-permissions', '--resume', 'old'], 'S2'),
    ['--add-dir', 'a', 'b', '--dangerously-skip-permissions', '--resume', 'S2', CONTINUE],
  );
  assert.deepEqual(supervise.resumeArgs(['--permission-mode', 'plan', '--', '-not a flag'], 'S3'), ['--permission-mode', 'plan', '--resume', 'S3', CONTINUE]);
});

test('your own --settings and hooks are kept alongside the session hooks', () => {
  const mine = JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
  const args = supervise.withSettings(['--settings', mine, 'hello'], { hooks: supervise.hookSettings() });
  assert.equal(args[0], '--settings');
  const merged = JSON.parse(args[1]);
  assert.equal(merged.model, 'opus');
  assert.equal(merged.hooks.Stop.length, 2, 'your Stop hook and ours both run');
  assert.ok(merged.hooks.StopFailure[0].matcher.includes('rate_limit'));
  assert.equal(args[2], 'hello');
});

test('when an account runs out mid-session, the same conversation continues on the next account', async () => {
  setup({ withWork: true, withKeys: false });
  const r = await run({ FAKE_CLAUDE_HIT_LIMIT: 'default' });
  assert.equal(r.code, 0, r.stderr);
  const events = log();
  assert.deepEqual(events.map((e) => `${e.kind}:${e.account === 'default' ? 'main' : 'work'}`), ['session:main', 'session:work']);
  const [first, second] = events;
  assert.deepEqual(second.args.slice(-3), ['--resume', first.session, CONTINUE], 'reopened the same conversation and asked Claude to carry on');
  assert.match(r.stderr, /Main account reached its limit, so this conversation continues on Work/);
  assert.equal(state.load().current, 'Work');
});

test('with a single account, the session is left to wait for the reset and continue by itself', async () => {
  setup({ withWork: false, withKeys: false });
  const r = await run({ FAKE_CLAUDE_HIT_LIMIT: 'default' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(log().map((e) => e.kind), ['session', 'continued'], 'never stopped or restarted');
  assert.doesNotMatch(r.stderr, /continues on/);
});

test('when every account is out, the conversation continues on your API keys', async () => {
  setup({ withWork: false, withKeys: true });
  const r = await run({ FAKE_CLAUDE_HIT_LIMIT: 'default' });
  assert.equal(r.code, 0, r.stderr);
  const events = log();
  assert.deepEqual(events.map((e) => e.kind), ['session', 'session'], 'Main was stopped, not left to continue');
  const onKeys = events[1];
  assert.match(onKeys.helperOutput, /sk-ant-api03-test-ok-/, 'runs on the working key');
  assert.deepEqual(onKeys.args.slice(-3), ['--resume', events[0].session, CONTINUE]);
  assert.match(r.stderr, /continues on API key "Personal"/);
});

test('when a key placed before an account runs out, the conversation continues on that account', async () => {
  setup({ withWork: false, withKeys: false });
  vault.update((v) => { v.keys = [keys.newEntry(testKey('spent'), 'Personal', 1)]; });
  process.env.FAKE_API_SPENT_FILE = limitedFile;
  const [personal] = vault.load().keys;
  config.update((c) => (c.order = [`key:${personal.id}`, 'account:default']));
  try {
    const r = await run({ FAKE_CLAUDE_HIT_LIMIT: 'keys' });
    assert.equal(r.code, 0, r.stderr);
    const events = log();
    assert.deepEqual(events.map((e) => e.kind), ['session', 'session']);
    assert.match(events[0].helperOutput, /sk-ant-api03-test-spent-/, 'started on the key, as ordered');
    assert.equal(events[1].account, 'default');
    assert.deepEqual(events[1].args.slice(-3), ['--resume', events[0].session, CONTINUE]);
    assert.match(r.stderr, /API key "Personal" reached its limit, so this conversation continues on Main account/);
  } finally {
    config.update((c) => delete c.order);
    delete process.env.FAKE_API_SPENT_FILE;
  }
});

test('when nothing is free yet, it keeps looking and moves the conversation as soon as a line frees up', async () => {
  setup({ withWork: true, withKeys: false });
  config.update((c) => { c.accountRecheckMinutes = 0; });
  fs.writeFileSync(limitedFile, `${path.basename(work.configDir)}\n`);
  // Work gets its usage back a moment after Main runs out.
  setTimeout(() => fs.writeFileSync(limitedFile, 'default\n'), 1500);
  const r = await run({ FAKE_CLAUDE_HIT_LIMIT: 'default', FAKE_CLAUDE_WAIT_MS: '15000', CLAUDE_NONSTOP_RECHECK_MS: '400' });
  config.update((c) => { c.accountRecheckMinutes = 10; });
  assert.equal(r.code, 0, r.stderr);
  const events = log();
  assert.deepEqual(events.map((e) => `${e.kind}:${e.account === 'default' ? 'main' : 'work'}`), ['session:main', 'session:work']);
  assert.deepEqual(events[1].args.slice(-3), ['--resume', events[0].session, CONTINUE]);
});

test('`claude -p` runs are left alone', () => {
  assert.equal(supervise.supervisable(['-p', 'hi']), false);
  assert.equal(supervise.supervisable(['--print', 'hi']), false);
});
