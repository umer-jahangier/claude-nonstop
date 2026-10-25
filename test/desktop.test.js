'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isolate } = require('./helpers');

isolate();
const desktop = require('../src/desktop');

const v = { gatewayToken: 'cn_test' };

test("the desktop app's Code sessions aren't held to strict sandbox mode unless you ask", () => {
  assert.equal(desktop.settings({ port: 43117 }, v).coworkEgressAllowedHosts, '["*"]');
  assert.equal('coworkEgressAllowedHosts' in desktop.settings({ port: 43117, desktopStrictSandbox: true }, v), false);
});

test('the built-in browser and desktop extensions stay on in third-party mode', () => {
  const s = desktop.settings({ port: 43117 }, v);
  assert.equal(s.builtinBrowserEnabled, 'true');
  assert.equal(s.isDesktopExtensionEnabled, 'true');
});

test('connectors reach the desktop app as managed MCP servers, and only when there are some', () => {
  assert.equal('managedMcpServers' in desktop.settings({ port: 43117, desktopConnectors: [] }, v), false);
  const entry = desktop.connector('Linear', 'https://mcp.linear.app/mcp');
  assert.deepEqual(entry, { name: 'Linear', transport: 'http', url: 'https://mcp.linear.app/mcp', oauth: true });
  const s = desktop.settings({ port: 43117, desktopConnectors: [entry] }, v);
  assert.deepEqual(JSON.parse(s.managedMcpServers), [entry]);
});

test('a connector needs an https URL and a plain name', () => {
  assert.equal('oauth' in desktop.connector('docs', 'https://example.com/mcp', { oauth: false }), false);
  assert.throws(() => desktop.connector('docs', 'http://example.com/mcp'), /https/);
  assert.throws(() => desktop.connector('docs', 'not a url'), /isn't a URL/);
  assert.throws(() => desktop.connector('', 'https://example.com/mcp'), /name/);
  assert.throws(() => desktop.connector('a<b>', 'https://example.com/mcp'), /name/);
});
