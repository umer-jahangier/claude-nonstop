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
const { KEYS_HEADER } = require('./gateway');
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

// Whether an account has usage left, trusting a recent limit for a while instead of asking.
async function hasUsage(account, cfg, bin) {
  const recent = state.load().accounts[account.id];
  if (recent && !recent.ok && accounts.isLimitReason(recent.reason) && Date.now() - recent.at < cfg.accountRecheckMinutes * 60000) {
    say(`${account.label}: ${recent.reason} (checked ${minutesAgo(recent.at)})`);
    return false;
  }
  say(`checking ${account.label}...`);
  const result = await accounts.probe(account, bin);
  if (!result.ok) say(`${account.label}: ${result.reason}`);
  return result.ok;
}

const keyNames = (list) => list.map((k) => `"${k.label}"`).join(', ');

// The first line a session starts on, walking your relay order: an account with usage left,
// or a group of keys that aren't all used up. `--sub` skips keys and `--api` skips accounts.
// When nothing has usage right now, the session still starts on the first line, so it can
// carry on by itself the moment something frees up.
async function firstLine(cfg, bin, mode) {
  const all = relay.groups(cfg, vault.load().keys);
  const relayed = all.filter((g) => (g.kind === 'account' ? mode !== 'api' : mode !== 'sub'));
  if (!relayed.length) {
    if (mode === 'sub') say('no subscription account is on. Turn one on in `claude-nonstop ui`.');
    else if (!vault.load().keys.length) say('no API keys saved yet. Add some with `claude-nonstop ui` (or `claude-nonstop keys add`).');
    else say('every line is paused. Turn one back on in `claude-nonstop ui`.');
    return null;
  }
  for (const g of relayed) {
    if (g.kind === 'account') {
      if (await hasUsage(g.account, cfg, bin)) {
        say(`using ${g.account.label} (subscription)`);
        return g;
      }
    } else if (g.keys.some((k) => !state.isCoolingDown(k.id, cfg.cooldownMinutes))) {
      return g;
    } else {
      say(`API key${g.keys.length > 1 ? 's' : ''} ${keyNames(g.keys)}: used up`);
    }
  }
  if (mode === 'sub') {
    say('no subscription account has usage left right now');
    return null;
  }
  if (relayed.every((g) => g.kind === 'keys')) {
    say('every API key is used up right now. Top one up or add another with `claude-nonstop ui`.');
    return null;
  }
  const first = relayed.find((g) => g.kind === 'account');
  say(`nothing has usage left right now, so this session starts on ${first.account.label} and carries on by itself as soon as a line frees up`);
  return first;
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
  // The group as it is now: keys removed or paused since the session started are left out.
  const ids = new Set(line.keys.map((k) => k.id));
  const group = relay.keyOrder(cfg, v.keys).filter((k) => ids.has(k.id));
  if (!group.length) {
    say('those API keys were paused or removed. Turn one back on in `claude-nonstop ui`.');
    return null;
  }
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  if (await gatewayRunning(cfg)) {
    env.ANTHROPIC_BASE_URL = gatewayUrl(cfg);
    env.ANTHROPIC_AUTH_TOKEN = v.gatewayToken;
    // Claude Code sends these headers with every request (a documented setting); the
    // gateway uses only the keys named here, in your order.
    const header = `${KEYS_HEADER}: ${group.map((k) => k.id).join(',')}`;
    env.ANTHROPIC_CUSTOM_HEADERS = env.ANTHROPIC_CUSTOM_HEADERS ? `${env.ANTHROPIC_CUSTOM_HEADERS}\n${header}` : header;
    if (first) say(`using API key${group.length > 1 ? 's' : ''} ${keyNames(group)} through the local gateway${group.length > 1 ? ' (it switches between them mid-session)' : ''}`);
    log(`launch: API keys ${keyNames(group)} through the gateway`);
    state.setCurrent(`API key: ${group[0].label}`);
    return { env };
  }
  const entry = await keys.pick(group, cfg);
  if (!entry) {
    say(`API key${group.length > 1 ? 's' : ''} ${keyNames(group)} ${group.length > 1 ? 'are' : 'is'} used up right now. Top one up or add another with \`claude-nonstop ui\`.`);
    return null;
  }
  if (first) say(`using API key "${entry.label}"`);
  log(`launch: API key "${entry.label}" through the key helper`);
  env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS = String(cfg.helperTtlMs);
  env.CLAUDE_NONSTOP_KEYS = group.map((k) => k.id).join(',');
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
    // A session names the group of keys it runs on; Claude Code passes its environment on.
    const named = (process.env.CLAUDE_NONSTOP_KEYS || '').split(',').filter(Boolean);
    const order = relay.keyOrder(cfg, vault.load().keys);
    const entry = await keys.pick(named.length ? order.filter((k) => named.includes(k.id)) : order, cfg);
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

module.exports = { launch, keyHelper, firstLine, prepareLine, startsSession, helperCommand, gatewayRunning, gatewayUrl };
