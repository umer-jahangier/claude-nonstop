'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { isolate } = require('./helpers');

const { root } = isolate();
process.env.CODEX_HOME = path.join(root, 'codex');
const codex = require('../src/codex');
const vault = require('../src/vault');
const config = require('../src/config');

const file = () => path.join(process.env.CODEX_HOME, 'config.toml');
const read = () => fs.readFileSync(file(), 'utf8');

test('points Codex at the gateway in a fresh configuration, and does nothing the second time', () => {
  fs.rmSync(process.env.CODEX_HOME, { recursive: true, force: true });
  const v = vault.loadWithTokens();
  const cfg = config.load();
  const r = codex.apply(cfg, v);
  assert.equal(r.changed, true);
  const text = read();
  assert.match(text, /^model = "gpt-5\.5"\nmodel_provider = "claude-nonstop"\n/);
  assert.ok(text.includes('[model_providers.claude-nonstop]'));
  assert.ok(text.includes(`base_url = "http://127.0.0.1:${cfg.port}/v1"`));
  assert.ok(text.includes('wire_api = "responses"'));
  assert.ok(text.includes(`experimental_bearer_token = "${v.gatewayToken}"`));
  assert.equal(codex.apply(cfg, v).changed, false);
  assert.equal(codex.status(cfg).wired, true);
});

test('keeps everything else in an existing configuration, and puts the old model lines back on removal', () => {
  fs.rmSync(process.env.CODEX_HOME, { recursive: true, force: true });
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  const before = `# my settings
model = "gpt-5.4"
approval_policy = "never"
model_provider = "openai"

[sandbox_workspace_write]
network_access = true

[model_providers.ollama]
name = "Ollama"
base_url = "http://localhost:11434/v1"

[mcp_servers.github]
command = "github-mcp"
`;
  fs.writeFileSync(file(), before);
  const v = vault.loadWithTokens();
  const cfg = config.load();
  codex.apply(cfg, v);
  const text = read();
  assert.match(text, /^model = "gpt-5\.5"\nmodel_provider = "claude-nonstop"\n\n# my settings\napproval_policy = "never"\n\n\[sandbox_workspace_write\]/);
  assert.ok(text.includes('[model_providers.ollama]\nname = "Ollama"'));
  assert.ok(text.includes('[mcp_servers.github]\ncommand = "github-mcp"'));
  assert.ok(text.trimEnd().endsWith('requires_openai_auth = false'), 'our table goes last');
  assert.equal((text.match(/\[model_providers\.claude-nonstop\]/g) || []).length, 1);

  // Applying again over our own table replaces it rather than adding another.
  config.update((c) => (c.models.openai = 'gpt-5.4'));
  codex.apply(config.load(), v);
  assert.equal((read().match(/\[model_providers\.claude-nonstop\]/g) || []).length, 1);
  assert.match(read(), /^model = "gpt-5\.4"/);

  const r = codex.remove();
  assert.equal(r.changed, true);
  const restored = read();
  assert.match(restored, /^model = "gpt-5\.4"\nmodel_provider = "openai"\n\n# my settings\napproval_policy = "never"/);
  assert.ok(!restored.includes('claude-nonstop'));
  assert.ok(restored.includes('[model_providers.ollama]'));
  assert.equal(codex.status(config.load()).wired, false);
});

test('removal of a configuration we never touched changes nothing', () => {
  fs.rmSync(process.env.CODEX_HOME, { recursive: true, force: true });
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  fs.writeFileSync(file(), 'model = "gpt-5.5"\n');
  assert.equal(codex.remove().changed, false);
  assert.equal(read(), 'model = "gpt-5.5"\n');
});

test('the web UI reports Codex and sets it up with one request', async () => {
  fs.rmSync(process.env.CODEX_HOME, { recursive: true, force: true });
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true }); // Codex's folder counts as installed
  config.update((c) => (c.models = { anthropic: 'claude-sonnet-5-5', openai: 'gpt-5.5' }));
  const ui = require('../src/ui');
  const ctx = require('../src/server').createContext();
  let snap = await ui.route('GET', '/api/state', {}, ctx);
  assert.deepEqual({ installed: snap.codex.installed, wired: snap.codex.wired }, { installed: true, wired: false });
  const r = await ui.route('POST', '/api/codex', {}, ctx);
  assert.equal(r.wired, true);
  snap = await ui.route('GET', '/api/state', {}, ctx);
  assert.equal(snap.codex.wired, true);
  assert.deepEqual(snap.settings.models, { anthropic: 'claude-sonnet-5-5', openai: 'gpt-5.5' });
  // The dropdowns offer each service's names, plus what a ChatGPT account's backend listed.
  assert.ok(snap.settings.modelChoices.anthropic.some(([id]) => id === 'claude-opus-5-5'));
  assert.ok(snap.settings.modelChoices.openai.some(([id, , group]) => id === 'gpt-5.5' && group === 'OpenAI API'));
  config.update((c) => c.accounts.push({ id: 'gpt-test', label: 'Work', kind: 'chatgpt', provider: 'openai', enabled: true }));
  require('../src/state').recordChatgptModels('gpt-test', ['gpt-6.1-sol', 'gpt-5.5']);
  snap = await ui.route('GET', '/api/state', {}, ctx);
  const sol = snap.settings.modelChoices.openai.find(([id]) => id === 'gpt-6.1-sol');
  assert.deepEqual(sol, ['gpt-6.1-sol', 'gpt-6.1-sol', 'ChatGPT: Work']);
  assert.equal(snap.settings.modelChoices.openai.filter(([id]) => id === 'gpt-5.5').length, 1, 'no duplicates');
  config.update((c) => (c.accounts = c.accounts.filter((a) => a.id !== 'gpt-test')));
  // Changing the default OpenAI model updates what Codex asks for.
  await ui.route('PATCH', '/api/settings', { models: { openai: 'gpt-5.4' } }, ctx);
  assert.match(read(), /^model = "gpt-5\.4"/);
  await assert.rejects(ui.route('PATCH', '/api/settings', { models: { openai: 'not a model' } }, ctx));
});
