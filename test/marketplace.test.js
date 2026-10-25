'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { isolate } = require('./helpers');

isolate();

const marketplace = require('../src/marketplace');

const file = () => marketplace.settingsFile();
const read = () => JSON.parse(fs.readFileSync(file(), 'utf8'));

test('creates settings.json with the official marketplace when there is none', () => {
  fs.rmSync(file(), { force: true });
  assert.equal(marketplace.ensure(), 'added');
  assert.deepEqual(read().extraKnownMarketplaces['claude-plugins-official'], {
    source: { source: 'github', repo: 'anthropics/claude-plugins-official' },
  });
  assert.equal(marketplace.registered(), true);
});

test('keeps every other setting and marketplace', () => {
  const before = {
    theme: 'dark',
    permissions: { allow: ['Bash(ls)'] },
    extraKnownMarketplaces: { mine: { source: { source: 'github', repo: 'me/plugins' } } },
  };
  fs.writeFileSync(file(), JSON.stringify(before));
  assert.equal(marketplace.ensure(), 'added');
  const after = read();
  assert.equal(after.theme, 'dark');
  assert.deepEqual(after.permissions, before.permissions);
  assert.deepEqual(after.extraKnownMarketplaces.mine, before.extraKnownMarketplaces.mine);
  assert.ok(after.extraKnownMarketplaces['claude-plugins-official']);
});

test('leaves an existing entry alone', () => {
  const custom = { extraKnownMarketplaces: { 'claude-plugins-official': { source: { source: 'git', url: 'https://example.com/fork.git' } } } };
  fs.writeFileSync(file(), JSON.stringify(custom));
  assert.equal(marketplace.ensure(), 'present');
  assert.deepEqual(read(), custom);
});

test("doesn't overwrite a settings file it can't parse", () => {
  fs.writeFileSync(file(), '{ "theme": "dark", ');
  assert.equal(marketplace.ensure(), 'unreadable');
  assert.equal(fs.readFileSync(file(), 'utf8'), '{ "theme": "dark", ');
  assert.equal(marketplace.registered(), false);
});

test('writes through a linked settings file so accounts keep sharing it', { skip: process.platform === 'win32' }, () => {
  const real = path.join(path.dirname(file()), 'real-settings.json');
  fs.writeFileSync(real, JSON.stringify({ theme: 'light' }));
  fs.rmSync(file(), { force: true });
  fs.symlinkSync(real, file());
  assert.equal(marketplace.ensure(), 'added');
  assert.ok(fs.lstatSync(file()).isSymbolicLink());
  assert.equal(JSON.parse(fs.readFileSync(real, 'utf8')).theme, 'light');
  assert.ok(JSON.parse(fs.readFileSync(real, 'utf8')).extraKnownMarketplaces['claude-plugins-official']);
  fs.rmSync(file());
});
