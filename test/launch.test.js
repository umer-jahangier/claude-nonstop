'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { spawn } = require('child_process');
const { isolate, installFakeClaude, startFakeApi, testKey, freePort, runCli, readFakeLog, BIN, call } = require('./helpers');

const { root } = isolate();
const fakeClaude = installFakeClaude(root);
const vault = require('../src/vault');
const keys = require('../src/keys');
const config = require('../src/config');
const accounts = require('../src/accounts');
const state = require('../src/state');

let api;
let env;
let profile;

before(async () => {
  api = await startFakeApi();
  env = { CLAUDE_NONSTOP_CLAUDE: fakeClaude, CLAUDE_NONSTOP_UPSTREAM: api.url, CLAUDE_NONSTOP_PORT: String(await freePort()) };
  Object.assign(process.env, env);
  profile = accounts.createProfile('Work');
  config.update((c) => c.accounts.push(profile));
  vault.update((v) => {
    v.keys = [keys.newEntry(testKey('credit'), 'Empty', 1), keys.newEntry(testKey('ok'), 'Personal', 2)];
  });
});
after(() => api.close());

const sessions = () => readFakeLog().filter((e) => e.kind === 'session');
const reset = () => {
  fs.rmSync(process.env.FAKE_CLAUDE_LOG, { force: true });
  state.clearCooldowns();
};

test('starts on the main account when it has usage left', async () => {
  reset();
  const r = await runCli(['run', 'fix the bug'], { env });
  assert.equal(r.code, 0, r.stderr);
  const [s] = sessions();
  assert.equal(s.account, 'default');
  assert.deepEqual(s.args, ['fix the bug']);
  assert.equal(s.env.ANTHROPIC_API_KEY, null);
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, null);
  assert.match(r.stderr, /using Main account/);
});

test('moves to the next account when the main one hit its limit', async () => {
  reset();
  const r = await runCli(['run'], { env: { ...env, FAKE_CLAUDE_LIMITED: 'default' } });
  assert.equal(r.code, 0, r.stderr);
  const [s] = sessions();
  assert.equal(s.account, profile.id);
  assert.equal(s.env.CLAUDE_CONFIG_DIR, profile.configDir);
  assert.match(r.stderr, /hit your session limit/);
});

test('remembers a limited account for a while instead of checking it every launch', async () => {
  fs.rmSync(process.env.FAKE_CLAUDE_LOG, { force: true });
  await runCli(['run'], { env: { ...env, FAKE_CLAUDE_LIMITED: 'default' } });
  const probes = readFakeLog().filter((e) => e.kind === 'probe');
  assert.deepEqual(probes.map((p) => p.account), [profile.id]);
});

test('falls back to API keys through the key helper, skipping a used-up key', async () => {
  reset();
  const r = await runCli(['run', '-c'], { env: { ...env, FAKE_CLAUDE_LIMITED: 'all' } });
  assert.equal(r.code, 0, r.stderr);
  const [s] = sessions();
  assert.equal(s.helperError, undefined, s.helperError);
  // The helper printed exactly the working key, run through the system shell like Claude Code does.
  assert.equal(s.helperOutput, `${testKey('ok')}\n`);
  assert.equal(s.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS, '120000');
  assert.equal(s.args.at(-1), '-c');
  assert.match(r.stderr, /using API key "Personal"/);
});

test('uses the gateway when it is running, so keys switch mid-session', async () => {
  reset();
  const server = spawn(process.execPath, [BIN, 'serve'], { env: { ...process.env, ...env }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await call(`http://127.0.0.1:${env.CLAUDE_NONSTOP_PORT}/health`)).status === 200) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const r = await runCli(['--api'], { env });
    assert.equal(r.code, 0, r.stderr);
    const [s] = sessions();
    assert.equal(s.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${env.CLAUDE_NONSTOP_PORT}`);
    assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, 'set');
    assert.ok(!s.args.includes('--settings'));
  } finally {
    server.kill();
  }
});

test('--sub refuses to fall back to keys', async () => {
  reset();
  const r = await runCli(['--sub'], { env: { ...env, FAKE_CLAUDE_LIMITED: 'all' } });
  assert.equal(r.code, 1);
  assert.equal(sessions().length, 0);
});

test('passes Claude Code subcommands and --version straight through', async () => {
  reset();
  await runCli(['run', 'mcp', 'list'], { env });
  await runCli(['run', '--version'], { env });
  const log = readFakeLog();
  assert.equal(log.filter((e) => e.kind === 'probe').length, 0);
  assert.deepEqual(sessions().map((s) => s.args), [['mcp', 'list'], ['--version']]);
});

test("keeps Claude Code's exit code", async () => {
  reset();
  const r = await runCli(['run'], { env: { ...env, FAKE_CLAUDE_EXIT: '7' } });
  assert.equal(r.code, 7);
});

test('a pinned account is tried first', async () => {
  reset();
  config.update((c) => (c.pinned = { type: 'account', id: profile.id }));
  try {
    const r = await runCli(['run'], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readFakeLog().filter((e) => e.kind === 'probe').map((e) => e.account), [profile.id]);
    assert.equal(sessions()[0].account, profile.id);
  } finally {
    config.update((c) => (c.pinned = null));
  }
});

test('a pinned API key goes before every account', async () => {
  reset();
  config.update((c) => (c.pinned = { type: 'key', id: keys.fingerprint(testKey('ok')) }));
  try {
    const r = await runCli(['run'], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFakeLog().filter((e) => e.kind === 'probe').length, 0);
    assert.equal(sessions()[0].helperOutput, `${testKey('ok')}\n`);
  } finally {
    config.update((c) => (c.pinned = null));
  }
});

test('says what to do when every key is used up', async () => {
  reset();
  vault.update((v) => {
    v.keys = [keys.newEntry(testKey('credit'), 'Empty', 1)];
  });
  const r = await runCli(['--api'], { env });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /"Empty" is used up right now/);
});

test('a key placed before the accounts is used first, and paused lines are skipped', async () => {
  reset();
  vault.update((v) => {
    v.keys = [keys.newEntry(testKey('credit'), 'Empty', 1), keys.newEntry(testKey('ok'), 'Personal', 2)];
  });
  const [empty, personal] = vault.load().keys;
  config.update((c) => {
    c.order = [`key:${personal.id}`, 'account:default', `key:${empty.id}`];
  });
  try {
    let r = await runCli(['run'], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFakeLog().filter((e) => e.kind === 'probe').length, 0, 'no account was asked first');
    assert.equal(sessions()[0].helperOutput, `${testKey('ok')}\n`);

    reset();
    config.update((c) => (c.pausedKeys = [personal.id]));
    r = await runCli(['run'], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(sessions()[0].account, 'default', 'the paused key was passed over');
  } finally {
    config.update((c) => {
      delete c.order;
      delete c.pausedKeys;
    });
  }
});
