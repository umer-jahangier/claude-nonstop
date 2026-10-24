'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const relay = require('../src/relay');
const hosts = require('../src/hosts');

const cfg = (pinned) => ({
  pinned,
  accounts: [
    { id: 'default', enabled: true },
    { id: 'work', enabled: true },
    { id: 'old', enabled: false },
    { id: 'side', enabled: true },
  ],
});
const keyList = [{ id: 'k1' }, { id: 'k2' }, { id: 'k3' }];
const ids = (list) => list.map((x) => x.id);

test('without a pin, the relay runs top to bottom and skips accounts that are off', () => {
  assert.deepEqual(ids(relay.accountOrder(cfg(null))), ['default', 'work', 'side']);
  assert.deepEqual(ids(relay.keyOrder(cfg(null), keyList)), ['k1', 'k2', 'k3']);
});

test('a pinned account goes first, and the rest keep their order behind it', () => {
  assert.deepEqual(ids(relay.accountOrder(cfg({ type: 'account', id: 'side' }))), ['side', 'default', 'work']);
  assert.deepEqual(ids(relay.keyOrder(cfg({ type: 'account', id: 'side' }), keyList)), ['k1', 'k2', 'k3']);
});

test('a pinned key skips the accounts and goes first among the keys', () => {
  assert.deepEqual(relay.accountOrder(cfg({ type: 'key', id: 'k3' })), []);
  assert.deepEqual(ids(relay.keyOrder(cfg({ type: 'key', id: 'k3' }), keyList)), ['k3', 'k1', 'k2']);
});

test('a pin pointing at something removed changes nothing', () => {
  assert.deepEqual(ids(relay.accountOrder(cfg({ type: 'account', id: 'gone' }))), ['default', 'work', 'side']);
  assert.deepEqual(ids(relay.keyOrder(cfg({ type: 'key', id: 'gone' }), keyList)), ['k1', 'k2', 'k3']);
});

test('the server answers only to its own names and ports', () => {
  const ports = new Set([43117, 80]);
  for (const ok of ['claude-nonstop.localhost', 'claude-nonstop.localhost:43117', '127.0.0.1:43117', 'localhost', '[::1]:43117']) {
    assert.equal(hosts.hostAllowed(ok, ports), true, ok);
  }
  for (const bad of ['evil.example', 'claude-nonstop.localhost:8080', 'claude-nonstop.localhost.evil.example', '127.0.0.2:43117', '']) {
    assert.equal(hosts.hostAllowed(bad, ports), false, bad);
  }
  assert.equal(hosts.hostAllowed('claude-nonstop.localhost', new Set([43117])), false);
  assert.equal(hosts.originAllowed(undefined, ports), true);
  assert.equal(hosts.originAllowed('http://claude-nonstop.localhost', ports), true);
  assert.equal(hosts.originAllowed('https://evil.example', ports), false);
  assert.equal(hosts.isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(hosts.isLoopback('192.168.0.14'), false);
});
