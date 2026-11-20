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

test('a token connector: added from the catalog by name, and `connectors headers` prints only the header for the app', async () => {
  process.env.CLAUDE_NONSTOP_GH_TOKEN = '';
  try {
    let r = await runCli(['connectors', 'add', 'github']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /access token.*--token/s);
    r = await runCli(['connectors', 'add', 'GitHub', '--token', 'github_pat_CLITOKEN0123456789']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /signs in with your token/);
    r = await runCli(['connectors', 'headers', 'GitHub']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { Authorization: `Bearer ${require('../src/vault').loadWithTokens().gatewayToken}` });
    r = await runCli(['connectors', 'catalog', 'linear']);
    assert.match(r.stdout, /Linear/);
    r = await runCli(['connectors', 'remove', 'github']);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(['connectors', 'headers', 'GitHub']);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
  } finally {
    delete process.env.CLAUDE_NONSTOP_GH_TOKEN;
  }
});
