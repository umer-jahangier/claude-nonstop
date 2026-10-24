'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { isolate, installFakeClaude } = require('./helpers');

const { root } = isolate();
const fakeClaude = installFakeClaude(root);
const accounts = require('../src/accounts');

test('reads the pretty-printed JSON that `claude auth status --json` prints', () => {
  const real = '{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "apiProvider": "firstParty"\n}\n';
  assert.equal(accounts.parseJsonOutput(real).loggedIn, true);
  assert.equal(accounts.parseJsonOutput('{"type":"result","is_error":false}').is_error, false);
  assert.equal(accounts.parseJsonOutput('a warning first\n{\n  "loggedIn": false\n}').loggedIn, false);
  assert.equal(accounts.parseJsonOutput('not json at all'), null);
});

test('reports a signed-in account as signed in, with its email', async () => {
  const main = { id: 'default', label: 'Main account', kind: 'default', enabled: true };
  const status = await accounts.status(main, fakeClaude);
  assert.deepEqual([status.loggedIn, status.email], [true, 'default@example.com']);
});

test("doesn't call an account signed out when Claude Code can't be started", async () => {
  const main = { id: 'default', label: 'Main account', kind: 'default', enabled: true };
  const status = await accounts.status(main, path.join(root, 'uninstalled', 'claude'));
  assert.equal(status.loggedIn, null);
  assert.match(status.error, /Claude Code wasn't found/);
});

test('reports a signed-out account as signed out', async () => {
  process.env.FAKE_CLAUDE_SIGNED_OUT = 'default';
  try {
    const status = await accounts.status({ id: 'default', label: 'Main', kind: 'default', enabled: true }, fakeClaude);
    assert.equal(status.loggedIn, false);
  } finally {
    delete process.env.FAKE_CLAUDE_SIGNED_OUT;
  }
});
