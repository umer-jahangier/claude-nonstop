'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { isolate } = require('./helpers');

isolate();
const desktop = require('../src/desktop');
const { carriesCredential } = require('../src/connectorcheck');

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

test("the official connector directory is listed as a plugin marketplace, and it's valid", () => {
  const [market] = JSON.parse(desktop.settings({ port: 43117 }, v).allowedPluginMarketplaces);
  assert.deepEqual(market, { source: 'github', repo: 'umer-jahangier/claude-nonstop', path: 'connectors', expectedName: 'nonstop-connectors' });
  const root = path.join(__dirname, '..', market.path);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.equal(manifest.name, market.expectedName);
  assert.ok(manifest.plugins.length > 400, 'the whole directory, not a sample');
  for (const p of manifest.plugins) {
    const servers = JSON.parse(fs.readFileSync(path.join(root, p.source, '.mcp.json'), 'utf8')).mcpServers;
    for (const s of Object.values(servers)) {
      assert.match(s.url, /^https:\/\//, p.name);
      assert.equal(carriesCredential(s.url), false, `${p.name}'s address carries a credential`);
      // Claude Code drops a server whose oauth isn't an object.
      if ('oauth' in s) assert.deepEqual(s.oauth, { mode: 'dcr' }, p.name);
    }
    assert.doesNotMatch(p.name, /^(claude|anthropics?)-/, `${p.name} is a reserved name`);
  }
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
