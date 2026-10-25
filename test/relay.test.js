'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const relay = require('../src/relay');
const hosts = require('../src/hosts');

const cfg = (pinned, extra = {}) => ({
  pinned,
  accounts: [
    { id: 'default', enabled: true },
    { id: 'work', enabled: true },
    { id: 'old', enabled: false },
    { id: 'side', enabled: true },
  ],
  ...extra,
});
const keyList = [{ id: 'k1' }, { id: 'k2' }, { id: 'k3' }];
const ids = (list) => list.map((x) => x.id);
const flat = (groups) => groups.map((g) => (g.kind === 'account' ? g.account.id : `[${ids(g.keys).join(',')}]`));

test('without an order of your own, accounts come first, then keys, skipping paused ones', () => {
  assert.deepEqual(ids(relay.accountOrder(cfg(null))), ['default', 'work', 'side']);
  assert.deepEqual(ids(relay.keyOrder(cfg(null), keyList)), ['k1', 'k2', 'k3']);
  assert.deepEqual(flat(relay.groups(cfg(null), keyList)), ['default', 'work', 'side', '[k1,k2,k3]']);
});

test('accounts and keys can be mixed in any order, and keys next to each other form a group', () => {
  const mixed = cfg(null, { order: ['account:side', 'key:k2', 'key:k3', 'account:default', 'key:k1', 'account:work'] });
  assert.deepEqual(flat(relay.groups(mixed, keyList)), ['side', '[k2,k3]', 'default', '[k1]', 'work']);
  assert.deepEqual(ids(relay.keyOrder(mixed, keyList)), ['k2', 'k3', 'k1']);
});

test('a paused key stays in the list but is never used', () => {
  const paused = cfg(null, { order: ['key:k1', 'account:default', 'key:k2'], pausedKeys: ['k1'] });
  assert.deepEqual(relay.lines(paused, keyList).map((l) => l.item.id), ['k1', 'default', 'k2', 'work', 'old', 'side', 'k3']);
  assert.deepEqual(flat(relay.groups(paused, keyList)), ['default', '[k2]', 'work', 'side', '[k3]']);
  assert.equal(relay.isPaused(paused, 'key', { id: 'k1' }), true);
});

test('new lines and old configs fill in at the end, and removed ones drop out', () => {
  const partial = cfg(null, { order: ['key:k3', 'account:gone', 'account:work'] });
  assert.deepEqual(relay.lines(partial, keyList).map((l) => l.item.id), ['k3', 'work', 'default', 'old', 'side', 'k1', 'k2']);
});

test('a pinned line goes first, whatever it is, and the rest keep their order behind it', () => {
  assert.deepEqual(flat(relay.groups(cfg({ type: 'account', id: 'side' }), keyList)), ['side', 'default', 'work', '[k1,k2,k3]']);
  assert.deepEqual(flat(relay.groups(cfg({ type: 'key', id: 'k3' }), keyList)), ['[k3]', 'default', 'work', 'side', '[k1,k2]']);
  assert.deepEqual(ids(relay.keyOrder(cfg({ type: 'key', id: 'k3' }), keyList)), ['k3', 'k1', 'k2']);
});

test('a pin pointing at something removed changes nothing', () => {
  assert.deepEqual(ids(relay.accountOrder(cfg({ type: 'account', id: 'gone' }))), ['default', 'work', 'side']);
  assert.deepEqual(ids(relay.keyOrder(cfg({ type: 'key', id: 'gone' }), keyList)), ['k1', 'k2', 'k3']);
});

test('moving a line steps over accounts and keys alike; a new order must name every line', () => {
  assert.deepEqual(relay.moved(cfg(null), keyList, 'key', 'k1', 'up'), ['account:default', 'account:work', 'account:old', 'key:k1', 'account:side', 'key:k2', 'key:k3']);
  assert.deepEqual(relay.moved(cfg(null), keyList, 'account', 'default', 'up').slice(0, 2), ['account:default', 'account:work'], 'already at the top');
  assert.equal(relay.moved(cfg(null), keyList, 'key', 'nope', 'up'), null);
  const all = relay.lines(cfg(null), keyList).map((l) => relay.lineId(l.type, l.item.id));
  assert.equal(relay.validOrder(cfg(null), keyList, [...all].reverse()), true);
  assert.equal(relay.validOrder(cfg(null), keyList, all.slice(1)), false);
  assert.equal(relay.validOrder(cfg(null), keyList, [...all.slice(1), all[1]]), false);
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
