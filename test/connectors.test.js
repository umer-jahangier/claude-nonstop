'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isolate, runCli } = require('./helpers');

isolate();
const config = require('../src/config');

test('connectors can be added, listed, replaced and removed from the command line', async () => {
  let r = await runCli(['connectors']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /No connectors yet/);

  r = await runCli(['connectors', 'add', 'Linear', 'https://mcp.linear.app/mcp']);
  assert.equal(r.code, 0, r.stderr);
  r = await runCli(['connectors', 'add', 'linear', 'https://mcp.linear.app/sse', '--no-oauth']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(config.load().desktopConnectors, [{ name: 'linear', transport: 'http', url: 'https://mcp.linear.app/sse' }]);

  r = await runCli(['connectors']);
  assert.match(r.stdout, /linear {2}https:\/\/mcp\.linear\.app\/sse {2}\(no sign-in\)/);

  r = await runCli(['connectors', 'remove', 'LINEAR']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(config.load().desktopConnectors, []);
});

test('bad connectors are refused without changing the list', async () => {
  let r = await runCli(['connectors', 'add', 'plain', 'http://example.com/mcp']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /https/);
  r = await runCli(['connectors', 'add', 'only-a-name']);
  assert.equal(r.code, 1);
  r = await runCli(['connectors', 'remove', 'missing']);
  assert.equal(r.code, 1);
  assert.deepEqual(config.load().desktopConnectors, []);
});
