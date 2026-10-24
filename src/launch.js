'use strict';

// Starting Claude Code on the first subscription account with usage left, then on
// API keys: through the local gateway when it's running (keys switch mid-request),
// otherwise through Claude Code's apiKeyHelper (keys switch every couple of minutes).
// Interactive sessions are then supervised (supervise.js): when a line runs out mid-way,
// the same conversation moves on to the next line and carries on by itself.

const paths = require('./paths');
const config = require('./config');
const vault = require('./vault');
const keys = require('./keys');
const relay = require('./relay');
const accounts = require('./accounts');
const state = require('./state');
const claude = require('./claude');
const supervise = require('./supervise');
const { request } = require('./http');
const { log, ensureHome } = require('./files');

// Claude Code subcommands that don't start a session run as-is, with no account picking.
const PASSTHROUGH = new Set([
  'agents',
  'auth',
  'auto-mode',
  'doctor',
  'gateway',
  'install',
  'mcp',
  'plugin',
  'plugins',
  'project',
  'setup-token',
  'ultrareview',
  'update',
  'upgrade',
]);
const INFO_FLAGS = new Set(['-v', '--version', '-h', '--help']);

const say = (message) => process.stderr.write(`claude-nonstop: ${message}\n`);

const startsSession = (args) => !(PASSTHROUGH.has(args[0]) || args.some((a) => INFO_FLAGS.has(a)));

function minutesAgo(at) {
  const m = Math.max(0, Math.round((Date.now() - at) / 60000));
  return m === 0 ? 'just now' : `${m} min ago`;
}

const gatewayUrl = (cfg) => `http://127.0.0.1:${cfg.port}`;

async function gatewayRunning(cfg) {
  const r = await request(`${gatewayUrl(cfg)}/health`, { timeoutMs: 1000 });
  if (r.status !== 200) return false;
  try {
    return JSON.parse(r.body).name === 'claude-nonstop';
  } catch {
    return false;
  }
}

function shellQuote(s) {
  return process.platform === 'win32' ? `"${s}"` : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// The command Claude Code runs to get a key: this same program, in key-helper mode.
function helperCommand() {
  return `${shellQuote(process.execPath)} ${shellQuote(paths.APP_SCRIPT)} key-helper`;
}

async function firstAccountWithUsage(cfg, bin) {
  for (const account of relay.accountOrder(cfg)) {
    const recent = state.load().accounts[account.id];
    if (recent && !recent.ok && accounts.isLimitReason(recent.reason) && Date.now() - recent.at < cfg.accountRecheckMinutes * 60000) {
      say(`${account.label}: ${recent.reason} (checked ${minutesAgo(recent.at)})`);
      continue;
    }
    say(`checking ${account.label}...`);
    const result = await accounts.probe(account, bin);
    if (result.ok) return account;
    say(`${account.label}: ${result.reason}`);
  }
  return null;
}

// The first line a session starts on: an account with usage left, or else the API keys.
async function firstLine(cfg, bin, mode) {
  if (mode !== 'api') {
    const account = await firstAccountWithUsage(cfg, bin);
    if (account) {
      say(`using ${account.label} (subscription)`);
      return { kind: 'account', account };
    }
    if (mode === 'sub') {
      say('no subscription account has usage left right now');
      return null;
    }
    say('no subscription account has usage left, switching to API keys');
  }
  if (!vault.load().keys.length) {
    say('no API keys saved yet. Add some with `claude-nonstop ui` (or `claude-nonstop keys add`).');
    return null;
  }
  return { kind: 'keys' };
}

// The environment (and settings) that run Claude Code on a line, or null if it can't be used.
async function prepareLine(line, cfg, first) {
  if (line.kind === 'account') {
    const { account } = line;
    log(`launch: ${account.label}`);
    state.setCurrent(account.label);
    if (account.kind === 'profile') accounts.syncSharedFiles(account.configDir);
    return { env: accounts.env(account) };
  }
  const v = vault.loadWithTokens();
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  if (await gatewayRunning(cfg)) {
    env.ANTHROPIC_BASE_URL = gatewayUrl(cfg);
    env.ANTHROPIC_AUTH_TOKEN = v.gatewayToken;
    if (first) say('using your API keys through the local gateway (it switches keys mid-session)');
    log('launch: API keys through the gateway');
    state.setCurrent('API keys (gateway)');
    return { env };
  }
  const entry = await keys.pick(relay.keyOrder(cfg, v.keys), cfg);
  if (!entry) {
    say('every API key is used up right now. Top one up or add another with `claude-nonstop ui`.');
    return null;
  }
  if (first) say(`using API key "${entry.label}"`);
  log(`launch: API key "${entry.label}" through the key helper`);
  env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS = String(cfg.helperTtlMs);
  return { env, settings: { apiKeyHelper: helperCommand() } };
}

async function launch(args, { mode = 'auto' } = {}) {
  const bin = claude.findClaude();
  if (!bin) {
    say("can't find Claude Code (the `claude` command). Install it from https://code.claude.com/docs/en/setup");
    return 1;
  }
  if (!startsSession(args)) return claude.runInteractive(bin, args, process.env);
  ensureHome();
  const cfg = config.load();
  const line = await firstLine(cfg, bin, mode);
  if (!line) return 1;
  let first = true;
  const prepare = async (l) => {
    const prepared = await prepareLine(l, cfg, first);
    first = false;
    return prepared;
  };
  if (supervise.supervisable(args)) return supervise.run({ bin, args, cfg, mode, line, prepare });
  const prepared = await prepare(line);
  if (!prepared) return 1;
  return claude.runInteractive(bin, prepared.settings ? ['--settings', JSON.stringify(prepared.settings), ...args] : args, prepared.env);
}

// apiKeyHelper mode: print the first working key and nothing else (Claude Code rejects
// a helper that prints anything besides the key). Problems go to the log file.
async function keyHelper() {
  try {
    const cfg = config.load();
    const entry = await keys.pick(relay.keyOrder(cfg, vault.load().keys), cfg);
    if (!entry) {
      log('key helper: no working API key left');
      return 1;
    }
    process.stdout.write(`${entry.key}\n`);
    return 0;
  } catch (err) {
    log(`key helper failed: ${err.message}`);
    return 1;
  }
}

module.exports = { launch, keyHelper, startsSession, helperCommand, gatewayRunning, gatewayUrl };
