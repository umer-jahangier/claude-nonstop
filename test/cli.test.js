'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { isolate, startFakeApi, testKey, runCli } = require('./helpers');

isolate();
const vault = require('../src/vault');
const keys = require('../src/keys');

let api;
before(async () => {
  api = await startFakeApi();
  process.env.CLAUDE_NONSTOP_UPSTREAM = api.url;
});
after(() => api.close());

test('prints help and version', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /claude-nonstop ui/);
  const version = await runCli(['--version']);
  assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/);
});

test('the key helper prints the key and nothing else', async () => {
  vault.update((v) => {
    v.keys = [keys.newEntry(testKey('credit'), 'Empty', 1), keys.newEntry(testKey('ok'), 'Personal', 2)];
  });
  const r = await runCli(['key-helper']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `${testKey('ok')}\n`);
  assert.equal(r.stderr, '');
});

test('the key helper fails quietly when no key works', async () => {
  vault.update((v) => {
    v.keys = [keys.newEntry(testKey('invalid'), 'Bad', 1)];
  });
  const r = await runCli(['key-helper']);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('keys add reads a piped key, rejects bad ones, and keys remove forgets it', async () => {
  vault.update((v) => {
    v.keys = [];
  });
  const added = await runCli(['keys', 'add', 'From', 'pipe'], { input: `${testKey('ok')}\n` });
  assert.equal(added.code, 0, added.stderr);
  assert.match(added.stdout, /Saved "From pipe".*works/);
  const bad = await runCli(['keys', 'add'], { input: 'not-a-key\n' });
  assert.equal(bad.code, 1);
  const list = await runCli(['keys']);
  assert.match(list.stdout, /From pipe/);
  assert.ok(!list.stdout.includes(testKey('ok')));
  const removed = await runCli(['keys', 'remove', '1']);
  assert.equal(removed.code, 0);
  assert.equal(vault.load().keys.length, 0);
});

test('status and desktop run on a fresh install', async () => {
  const status = await runCli(['status']);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /accounts and API keys, tried in this order/);
  const desktop = await runCli(['desktop']);
  assert.equal(desktop.code, 0);
  assert.match(desktop.stdout, /Configure Third-Party Inference/);
});
