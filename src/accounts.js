'use strict';

// Subscription accounts. The first is your normal Claude Code login. Each extra Claude
// account is its own Claude Code config folder (CLAUDE_CONFIG_DIR, the documented way to
// stay signed in to several accounts). Signing in always goes through Claude Code's own
// `claude auth login`, and the login stays in Claude Code's credential store.
//
// A ChatGPT account (kind 'chatgpt', provider 'openai') is signed in the way Codex does it
// (openai-auth.js) and its sign-in lives in the vault. It's checked with one tiny request.

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

const isChatgpt = (account) => account && account.kind === 'chatgpt';
const isGemini = (account) => account && account.kind === 'gemini';
// An account with no Claude Code sign-in: its requests go through the gateway.
const notClaude = (account) => isChatgpt(account) || isGemini(account);
const serviceName = (account) => (isChatgpt(account) ? 'ChatGPT' : isGemini(account) ? 'Gemini' : 'Claude');

// A Gemini account: a Google sign-in in the vault (google-auth.js), used through Code Assist.
function createGemini(label) {
  ensureHome();
  return { id: `gem-${crypto.randomBytes(4).toString('hex')}`, label, kind: 'gemini', provider: 'gemini', enabled: true };
}

// Does a Gemini account have usage left? Code Assist's quota readout says, per model, without
// spending any; a tiny request answers when the readout isn't available.
async function probeGemini(account, cfg = require('./config').load()) {
  const googleAuth = require('./google-auth');
  const providers = require('./providers');
  const record = (result) => {
    state.recordAccount(account.id, result);
    return result;
  };
  let creds;
  try {
    creds = await googleAuth.current(account.id);
  } catch (err) {
    return record({ ok: false, reason: `sign-in could not be renewed: ${err.message}` });
  }
  if (!creds) return record({ ok: false, reason: 'not signed in' });
  let buckets = null;
  try {
    buckets = await googleAuth.quota(creds);
  } catch {}
  if (buckets && Object.keys(buckets).length) {
    const wanted = (cfg.models && cfg.models.gemini) || providers.gemini.defaultModel;
    const pick = buckets[wanted] ? wanted : Object.keys(buckets).find((m) => /pro/.test(m)) || Object.keys(buckets)[0];
    const b = buckets[pick];
    state.recordUsage(account.id, { session: { pct: b.pct, resetsAt: b.resetsAt }, model: pick, at: Date.now() });
    const left = Object.values(buckets).some((x) => x.pct < 100);
    return record(left ? { ok: true, reason: '' } : { ok: false, reason: `usage limit reached: every Gemini model is at its quota${b.resetsAt ? ` until ${new Date(b.resetsAt).toLocaleString()}` : ''}` });
  }
  const { request } = require('./http');
  const body = JSON.stringify({ model: providers.gemini.probeModel, project: creds.projectId, request: { contents: [{ role: 'user', parts: [{ text: 'Reply with OK' }] }], generationConfig: { maxOutputTokens: 8 } } });
  const r = await request(`${googleAuth.codeAssist()}:generateContent`, { method: 'POST', headers: { authorization: `Bearer ${creds.accessToken}`, 'content-type': 'application/json', 'user-agent': googleAuth.userAgent(), 'content-length': Buffer.byteLength(body) }, body, timeoutMs: 60000 });
  const detail = providers.gemini.errorMessage(r.body) || (r.status ? `HTTP ${r.status}` : r.body);
  if (r.status >= 200 && r.status < 300) return record({ ok: true, reason: '' });
  if (r.status === 429) return record({ ok: false, reason: `usage limit reached: ${detail}` });
  if (r.status === 401 || r.status === 403) return record({ ok: false, reason: `sign-in refused: ${detail}` });
  return record({ ok: false, reason: detail });
}

// A ChatGPT account: no config folder, its sign-in is in the vault (openai-auth.js).
function createChatgpt(label) {
  ensureHome();
  return { id: `gpt-${crypto.randomBytes(4).toString('hex')}`, label, kind: 'chatgpt', provider: 'openai', enabled: true };
}

// Does a ChatGPT account have usage left right now? One tiny request to the Codex backend.
async function probeChatgpt(account, cfg = require('./config').load()) {
  const openaiAuth = require('./openai-auth');
  const providers = require('./providers');
  const { request } = require('./http');
  let creds;
  try {
    creds = await openaiAuth.current(account.id);
  } catch (err) {
    const result = { ok: false, reason: `sign-in could not be renewed: ${err.message}` };
    state.recordAccount(account.id, result);
    return result;
  }
  if (!creds) {
    const result = { ok: false, reason: 'not signed in' };
    state.recordAccount(account.id, result);
    return result;
  }
  const wanted = (cfg.models && cfg.models.openai) || providers.openai.defaultModel;
  const model = await require('./chatgpt-models').pick(wanted, account.id, creds, cfg, { force: true });
  const body = JSON.stringify({ model, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply with OK' }] }], instructions: 'Reply with OK.', store: false, stream: true, max_output_tokens: 16 });
  const r = await request(`${providers.openai.chatgptUpstream(cfg)}/responses`, {
    method: 'POST',
    headers: { ...providers.openai.accountHeaders(creds), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    body,
    timeoutMs: 60000,
  });
  const detail = providers.openai.errorMessage(r.body) || (r.status ? `HTTP ${r.status}` : r.body);
  let result;
  if (r.status >= 200 && r.status < 300) result = { ok: true, reason: '' };
  else if (r.status === 429) result = { ok: false, reason: `usage limit reached: ${detail}` };
  else if (r.status === 401 || r.status === 403) result = { ok: false, reason: `sign-in refused: ${detail}` };
  else result = { ok: false, reason: detail };
  state.recordAccount(account.id, result);
  const u = providers.openai.usageFromHeaders(r.headers || {});
  if (u) state.recordUsage(account.id, { ...u, at: Date.now() });
  return result;
}

// The environment Claude Code runs with for an account.
function env(account, base = process.env) {
  const out = { ...base };
  delete out.ANTHROPIC_API_KEY;
  delete out.ANTHROPIC_AUTH_TOKEN;
  delete out.ANTHROPIC_BASE_URL;
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

// Claude Code prints JSON either pretty-printed across many lines (`auth status`) or as
// one line, sometimes after other output. Try the whole text, then the last {...} block,
// then each line from the end.
function parseJsonOutput(stdout) {
  const text = String(stdout || '').trim();
  const attempts = [text];
  const start = text.lastIndexOf('\n{');
  if (start >= 0) attempts.push(text.slice(start + 1));
  attempts.push(...text.split(/\r?\n/).reverse());
  for (const candidate of attempts) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object') return value;
    } catch {}
  }
  return null;
}

// Does this account have usage left right now? One tiny Haiku request against its plan,
// run from claude-nonstop's own folder so it loads no project config and leaves no
// conversation behind for `claude -c` to pick up.
async function probe(account, bin) {
  if (isChatgpt(account)) return probeChatgpt(account);
  if (isGemini(account)) return probeGemini(account);
  ensureHome();
  // User settings may point Claude Code at the gateway, and on a root server they may
  // force bypass-permissions. A probe has to reach this account's own sign-in.
  const args = claude.withoutRootBypass([...PROBE_ARGS, '--setting-sources', 'project,local']);
  const r = await claude.capture(bin, args, { env: env(account), cwd: paths.HOME, timeoutMs: 120000 });
  const parsed = parseJsonOutput(r.stdout);
  const result =
    parsed && parsed.is_error === false
      ? { ok: true, reason: '' }
      : { ok: false, reason: (parsed && String(parsed.result || '')) || lastLine(r.stderr) || lastLine(r.stdout) || `claude exited with code ${r.code}` };
  state.recordAccount(account.id, result);
  return result;
}

// A plan limit (session, weekly, usage): not a passing "rate limit" on a burst of requests.
const isLimitReason = (reason) => /usage limit|session limit|weekly limit|limit reached|hit your|out of (extra )?usage/i.test(reason || '') && !/would exceed your account's rate limit/i.test(reason || '');

// A refusal that won't pass by itself: the account's organization turned Claude Code off for
// subscription seats, or the sign-in is no longer accepted. Such an account isn't used until a
// check finds it working again.
const isBlockedReason = (reason) => /disabled Claude subscription access|organization has disabled|ask your admin to enable|not (allowed|permitted) to use Claude Code|sign-in refused|OAuth session expired and could not be refreshed/i.test(reason || '');

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
  if (isGemini(account)) {
    const creds = require('./google-auth').stored(account.id);
    return { loggedIn: Boolean(creds), email: creds ? creds.email : null, method: 'google', plan: creds ? creds.tier : null };
  }
  if (isChatgpt(account)) {
    const creds = require('./openai-auth').stored(account.id);
    return { loggedIn: Boolean(creds), email: creds ? creds.email : null, method: 'chatgpt', plan: creds ? creds.plan : null };
  }
  ensureHome();
  const r = await claude.capture(bin, ['auth', 'status', '--json'], { env: env(account), cwd: paths.HOME, timeoutMs: 30000 });
  // Without Claude Code there's no telling whether the account is signed in, so don't say it isn't.
  if (r.notStarted) return { loggedIn: null, email: null, error: lastLine(r.stderr) };
  const parsed = parseJsonOutput(r.stdout);
  if (!parsed) return { loggedIn: false, email: null, error: lastLine(r.stderr) || lastLine(r.stdout) };
  return { loggedIn: Boolean(parsed.loggedIn), email: findEmail(parsed), method: parsed.authMethod || null };
}

const LOGIN_ARGS = ['auth', 'login', '--claudeai'];

function logout(account, bin) {
  ensureHome();
  return claude.capture(bin, ['auth', 'logout'], { env: env(account), cwd: paths.HOME, timeoutMs: 30000 });
}

// Deletes an extra account: signs it out (which revokes its login), removes the links to
// your shared history without touching what they point at, then removes its folder.
async function remove(account, bin) {
  if (notClaude(account)) {
    require(isGemini(account) ? './google-auth' : './openai-auth').forget(account.id);
    state.forgetAccount(account.id);
    return;
  }
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
  createChatgpt,
  isChatgpt,
  probeChatgpt,
  createGemini,
  isGemini,
  probeGemini,
  notClaude,
  serviceName,
  syncSharedFiles,
  env,
  probe,
  status,
  remove,
  logout,
  isLimitReason,
  isBlockedReason,
  parseJsonOutput,
  LOGIN_ARGS,
  PROBE_ARGS,
};
