'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isolate, testKey } = require('./helpers');

isolate();
const config = require('../src/config');
const vault = require('../src/vault');
const keys = require('../src/keys');
const state = require('../src/state');
const advisor = require('../src/desktopadvice');

const LIMIT = "You've hit your session limit · resets 7pm";
const cfg = () => config.load();

function setup({ main, desktopAt = null, keyUsedUp = false }) {
  state.clearCooldowns();
  vault.update((v) => {
    v.keys = [keys.newEntry(testKey('ok'), 'Personal', 1)];
  });
  if (main) state.recordAccount('default', main);
  if (keyUsedUp) state.recordKey(vault.load().keys[0].id, { verdict: 'used-up', status: 400, detail: 'Your credit balance is too low' });
  if (desktopAt) state.setDesktop('Personal');
}

test('says to switch the desktop app to API keys when its account hits its limit and a key can take over', () => {
  setup({ main: { ok: false, reason: LIMIT } });
  const a = advisor.advice(cfg());
  assert.equal(a.kind, 'to-keys');
  assert.equal(a.account, 'Main account');
  assert.match(advisor.message(a), /Main account reached its limit.*third-party option/);
});

test("says when no key can take over either, instead of sending you to keys that won't work", () => {
  setup({ main: { ok: false, reason: LIMIT }, keyUsedUp: true });
  assert.equal(advisor.advice(cfg()).kind, 'wait');
});

test('says to switch back once the account has usage again while the app is on API keys', () => {
  setup({ main: { ok: true, reason: '' }, desktopAt: Date.now() });
  const a = advisor.advice(cfg());
  assert.equal(a.kind, 'to-account');
  assert.match(advisor.message(a), /has usage again.*back to Claude\.ai/);
});

test("has nothing to say while the account has usage and the app isn't on API keys", () => {
  setup({ main: { ok: true, reason: '' } });
  const s = state.load();
  assert.equal(advisor.advice(cfg(), { ...s, desktop: null }), null);
  assert.equal(advisor.advice(cfg(), { ...s, desktop: { label: 'Personal', at: Date.now() - 2 * 3600000 } }), null, 'an hour-old use of the gateway is not "on API keys"');
});

test('watches the account you chose for the desktop app', () => {
  setup({ main: { ok: true, reason: '' } });
  config.update((c) => {
    c.accounts.push({ id: 'acct-work', label: 'Work', kind: 'profile', configDir: '/nowhere', enabled: true });
    c.desktopAccount = 'acct-work';
  });
  state.recordAccount('acct-work', { ok: false, reason: LIMIT });
  assert.equal(advisor.advice(cfg()).account, 'Work');
  config.update((c) => {
    c.desktopAccount = 'default';
  });
});
