'use strict';

// Subscription accounts. The first is your normal Claude Code login. Each extra one
// is its own Claude Code config folder (CLAUDE_CONFIG_DIR, the documented way to stay
// signed in to several accounts). Signing in always goes through Claude Code's own
// `claude auth login`, and the login stays in Claude Code's credential store.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('./paths');
const claude = require('./claude');
const state = require('./state');
const { readJson, writeJson, ensureHome } = require('./files');

// Linked from your main config folder, so every account shares one history, one set of
// settings, plugins and skills, and `claude -c` resumes a conversation from any account.
const SHARED_DIRS = ['projects', 'file-history', 'todos', 'plans', 'shell-snapshots', 'agents', 'commands', 'skills', 'plugins', 'output-styles', 'hooks'];
const ALWAYS_SHARED = new Set(['projects', 'file-history', 'todos']);
const SHARED_FILES = ['settings.json', 'CLAUDE.md', 'keybindings.json'];
// Copied once into a new account so it skips onboarding and keeps your MCP servers and trusted folders.
const SEEDED_SETTINGS = ['hasCompletedOnboarding', 'theme', 'mcpServers', 'projects', 'editorMode', 'autoUpdates'];

const mainConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const mainStateFile = () =>
  process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');

function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// macOS and Linux link the shared files. Windows needs admin rights for file links, so
// it copies them instead and refreshes the copies before every launch.
function syncSharedFiles(dir) {
  const main = mainConfigDir();
  for (const name of SHARED_FILES) {
    const src = path.join(main, name);
    const dst = path.join(dir, name);
    if (!fs.existsSync(src)) continue;
    try {
      if (process.platform === 'win32') fs.copyFileSync(src, dst);
      else if (!exists(dst)) fs.symlinkSync(src, dst);
    } catch {}
  }
}

function linkShared(dir) {
  const main = mainConfigDir();
  for (const name of SHARED_DIRS) {
    const src = path.join(main, name);
    const dst = path.join(dir, name);
    if (exists(dst)) continue;
    if (!exists(src)) {
      if (!ALWAYS_SHARED.has(name)) continue;
      fs.mkdirSync(src, { recursive: true });
    }
    // Directory junctions need no admin rights on Windows.
    fs.symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir');
  }
  syncSharedFiles(dir);
}

function seedSettings(dir) {
  const main = readJson(mainStateFile(), {});
  const seed = {};
  for (const name of SEEDED_SETTINGS) if (name in main) seed[name] = main[name];
  writeJson(path.join(dir, '.claude.json'), seed);
}

function createProfile(label) {
  ensureHome();
  const id = `acct-${crypto.randomBytes(4).toString('hex')}`;
  const configDir = path.join(paths.PROFILES, id);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  linkShared(configDir);
  seedSettings(configDir);
  return { id, label, kind: 'profile', configDir, enabled: true };
}

// The environment Claude Code runs with for an account.
function env(account, base = process.env) {
  const out = { ...base };
  delete out.ANTHROPIC_API_KEY;
  delete out.ANTHROPIC_AUTH_TOKEN;
  if (account.kind === 'profile') {
    out.CLAUDE_CONFIG_DIR = account.configDir;
    delete out.CLAUDE_CODE_OAUTH_TOKEN;
  }
  return out;
}

const PROBE_ARGS = [
  '-p',
  'Reply with OK',
  '--model',
  'haiku',
  '--output-format',
  'json',
  '--no-session-persistence',
  '--strict-mcp-config',
  '--settings',
  '{"disableAllHooks":true}',
];

function lastLine(text) {
  return String(text || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
}

function parseJsonOutput(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {}
  }
  return null;
}

// Does this account have usage left right now? One tiny Haiku request against its plan,
// run from claude-nonstop's own folder so it loads no project config and leaves no
// conversation behind for `claude -c` to pick up.
async function probe(account, bin) {
  ensureHome();
  const r = await claude.capture(bin, PROBE_ARGS, { env: env(account), cwd: paths.HOME, timeoutMs: 120000 });
  const parsed = parseJsonOutput(r.stdout);
  const result =
    parsed && parsed.is_error === false
      ? { ok: true, reason: '' }
      : { ok: false, reason: (parsed && String(parsed.result || '')) || lastLine(r.stderr) || lastLine(r.stdout) || `claude exited with code ${r.code}` };
  state.recordAccount(account.id, result);
  return result;
}

const isLimitReason = (reason) => /limit/i.test(reason || '');

function findEmail(value) {
  if (!value || typeof value !== 'object') return null;
  for (const [k, v] of Object.entries(value)) {
    if (/email/i.test(k) && typeof v === 'string' && v.includes('@')) return v;
    const nested = findEmail(v);
    if (nested) return nested;
  }
  return null;
}

async function status(account, bin) {
  const r = await claude.capture(bin, ['auth', 'status', '--json'], { env: env(account), cwd: paths.HOME, timeoutMs: 30000 });
  const parsed = parseJsonOutput(r.stdout);
  if (!parsed) return { loggedIn: false, email: null, error: lastLine(r.stderr) || lastLine(r.stdout) };
  return { loggedIn: Boolean(parsed.loggedIn), email: findEmail(parsed), method: parsed.authMethod || null };
}

const LOGIN_ARGS = ['auth', 'login', '--claudeai'];

function logout(account, bin) {
  return claude.capture(bin, ['auth', 'logout'], { env: env(account), cwd: paths.HOME, timeoutMs: 30000 });
}

// Deletes an extra account: signs it out (which revokes its login), removes the links to
// your shared history without touching what they point at, then removes its folder.
async function remove(account, bin) {
  if (account.kind !== 'profile') throw new Error('the main account can only be turned off, not removed');
  const rel = path.relative(paths.PROFILES, account.configDir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('refusing to delete a folder outside claude-nonstop profiles');
  if (bin) await logout(account, bin);
  if (fs.existsSync(account.configDir)) {
    for (const name of fs.readdirSync(account.configDir)) {
      const p = path.join(account.configDir, name);
      if (!isLink(p)) continue;
      try {
        fs.unlinkSync(p);
      } catch {
        fs.rmdirSync(p); // Windows junctions
      }
    }
    fs.rmSync(account.configDir, { recursive: true, force: true });
  }
  state.forgetAccount(account.id);
}

module.exports = {
  mainConfigDir,
  createProfile,
  syncSharedFiles,
  env,
  probe,
  status,
  remove,
  logout,
  isLimitReason,
  LOGIN_ARGS,
  PROBE_ARGS,
};
