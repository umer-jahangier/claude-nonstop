'use strict';

// Non-secret settings, editable in the web UI. Accounts here are only a label and a
// Claude Code config folder; their logins stay in Claude Code's own credential store.

const paths = require('./paths');
const { readJson, writeJson } = require('./files');

const DEFAULTS = {
  port: 43117,
  cooldownMinutes: 30, // a used-up key is re-checked after this long, in case you topped it up
  accountRecheckMinutes: 10, // an account that hit its limit is skipped this long before re-checking
  helperTtlMs: 120000, // how often a CLI session without the gateway asks for a key again
  probeModel: 'claude-haiku-5-5', // cheapest model, used for the 1-token key checks
  upstream: 'https://api.anthropic.com',
  autoUpdate: true, // the gateway installs new releases by itself
  desktopStrictSandbox: false, // keep the desktop app's Code sessions to an allowlist of sites
  desktopConnectors: [], // MCP servers the desktop app lists as connectors in third-party mode
  desktopAccount: 'default', // the account the desktop app signs in to with Claude.ai
  desktopAlerts: true, // say when to switch the desktop app between that account and API keys
};

const DEFAULT_ACCOUNT = { id: 'default', label: 'Main account', kind: 'default', enabled: true };

function load() {
  const saved = readJson(paths.CONFIG, {});
  const cfg = { ...DEFAULTS, ...saved };
  cfg.accounts = Array.isArray(saved.accounts) && saved.accounts.length ? saved.accounts : [{ ...DEFAULT_ACCOUNT }];
  if (process.env.CLAUDE_NONSTOP_PORT) cfg.port = Number(process.env.CLAUDE_NONSTOP_PORT);
  if (process.env.CLAUDE_NONSTOP_UPSTREAM) cfg.upstream = process.env.CLAUDE_NONSTOP_UPSTREAM;
  cfg.upstream = cfg.upstream.replace(/\/+$/, '');
  return cfg;
}

function save(cfg) {
  const saved = readJson(paths.CONFIG, {});
  const out = { ...cfg };
  // Values that came from environment overrides are not written back.
  if (process.env.CLAUDE_NONSTOP_PORT) out.port = saved.port ?? DEFAULTS.port;
  if (process.env.CLAUDE_NONSTOP_UPSTREAM) out.upstream = saved.upstream ?? DEFAULTS.upstream;
  writeJson(paths.CONFIG, out);
}

function update(change) {
  const cfg = load();
  const result = change(cfg);
  save(cfg);
  return result;
}

module.exports = { DEFAULTS, load, save, update };
