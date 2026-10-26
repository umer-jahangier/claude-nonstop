'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { isolate } = require('./helpers');

isolate();

const clients = require('../src/clients');
const vault = require('../src/vault');
const config = require('../src/config');
const claude = require('../src/claude');

const file = () => clients.settingsFile();
const read = () => JSON.parse(fs.readFileSync(file(), 'utf8'));

test('points every Claude Code install at the gateway, then uninstall puts settings back', () => {
  fs.writeFileSync(file(), JSON.stringify({
    theme: 'dark',
    env: { DISABLE_AUTOUPDATER: '1', ANTHROPIC_BASE_URL: 'https://example.invalid' },
    permissions: { defaultMode: 'bypassPermissions', allow: ['Bash(ls)'] },
  }));
  const wired = clients.apply();
  assert.equal(wired.ok, true);
  assert.equal(wired.changed, true);
  const after = read();
  assert.equal(after.theme, 'dark');
  assert.equal(after.env.DISABLE_AUTOUPDATER, '1');
  assert.equal(after.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${config.load().port}`);
  assert.equal(after.env.ANTHROPIC_AUTH_TOKEN, vault.loadWithTokens().gatewayToken);
  assert.deepEqual(after.permissions.allow, ['Bash(ls)']);
  if (claude.isRoot()) assert.equal(after.permissions.defaultMode, 'default');
  else assert.equal(after.permissions.defaultMode, 'bypassPermissions');
  assert.equal(clients.apply().changed, false);

  assert.equal(clients.remove().ok, true);
  const restored = read();
  assert.equal(restored.env.ANTHROPIC_BASE_URL, 'https://example.invalid');
  assert.equal(restored.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(restored.env.DISABLE_AUTOUPDATER, '1');
  if (claude.isRoot()) assert.equal(restored.permissions.defaultMode, 'bypassPermissions');
});

test('writes through a linked settings file', { skip: process.platform === 'win32' }, () => {
  const real = path.join(path.dirname(file()), 'real-settings.json');
  fs.writeFileSync(real, JSON.stringify({ theme: 'light' }));
  fs.rmSync(file(), { force: true });
  fs.symlinkSync(real, file());
  assert.equal(clients.apply().ok, true);
  assert.ok(fs.lstatSync(file()).isSymbolicLink());
  const after = JSON.parse(fs.readFileSync(real, 'utf8'));
  assert.equal(after.theme, 'light');
  assert.equal(after.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${config.load().port}`);
  fs.rmSync(file());
});

test("doesn't overwrite a settings file it can't parse", () => {
  fs.writeFileSync(file(), '{ "theme": ');
  assert.equal(clients.apply().ok, false);
  assert.equal(fs.readFileSync(file(), 'utf8'), '{ "theme": ');
});
