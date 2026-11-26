'use strict';

// The web UI and its JSON API, served next to the gateway on 127.0.0.1.
// Opening it takes the UI token: `claude-nonstop ui` passes it once in the URL, which is
// swapped for an HttpOnly cookie. Every API call also needs a custom header that other
// websites can't send cross-site, so pages you visit can't drive it.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('./paths');
const config = require('./config');
const vault = require('./vault');
const keys = require('./keys');
const accounts = require('./accounts');
const usage = require('./usage');
const state = require('./state');
const claude = require('./claude');
const keystore = require('./keystore');
const desktop = require('./desktop');
const service = require('./service');
const shell = require('./shell');
const { sameToken, readBody } = require('./gateway');
const openaiAuth = require('./openai-auth');
const providers = require('./providers');
const codex = require('./codex');
const hosts = require('./hosts');
const events = require('./events');
const checks = require('./checks');
const relay = require('./relay');
const { log } = require('./files');
const pkg = require('../package.json');

const PAGE = path.join(__dirname, 'ui', 'index.html');
const jobs = new Map();

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function html(res, status, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function messagePage(title, text) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>claude-nonstop</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 ui-sans-serif,system-ui,sans-serif;background:Canvas;color:CanvasText;padding:16px}main{max-width:32rem}h1{font-size:1.25rem;margin:0 0 .5rem}code{font:0.95em ui-monospace,SFMono-Regular,Menlo,monospace;padding:.1em .35em;border-radius:4px;background:color-mix(in srgb,CanvasText 8%,transparent)}</style></head>
<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
}

function cookieToken(req) {
  const match = String(req.headers.cookie || '').match(/(?:^|;\s*)cn_ui=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function originAllowed(req) {
  return hosts.originAllowed(req.headers.origin, req.allowedPorts || new Set([req.socket.localPort]));
}

async function readJsonBody(req) {
  const raw = await readBody(req, 1024 * 1024);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw httpError(400, 'invalid JSON');
  }
}

const clean = (value, max = 60) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
// Strips terminal colour and cursor codes from Claude Code's output.
const stripAnsi = (text) => String(text).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r/g, '');

function requireClaude() {
  const bin = claude.findClaude();
  if (!bin) throw httpError(400, "Claude Code isn't installed on this computer (no `claude` command found).");
  return bin;
}

function findAccount(id) {
  const account = config.load().accounts.find((a) => a.id === id);
  if (!account) throw httpError(404, 'That account no longer exists.');
  return account;
}

// ---------------------------------------------------------------- state

// What the Default models dropdowns offer: each service's own names, plus whatever each
// ChatGPT account's backend listed last (those are the only names it takes).
function modelChoices(cfg, s) {
  const models = require('./models');
  const openai = models.list('openai').map(([id, name]) => [id, name, 'OpenAI']);
  const seen = new Set(openai.map((m) => m[0]));
  for (const a of cfg.accounts) {
    if (a.kind !== 'chatgpt') continue;
    const listed = (s.chatgptModels || {})[a.id];
    for (const slug of (listed && listed.slugs) || []) if (!seen.has(slug) && seen.add(slug)) openai.push([slug, slug, `ChatGPT: ${a.label}`]);
  }
  return { anthropic: models.list('anthropic').map(([id, name]) => [id, name, 'Claude']), openai, gemini: models.list('gemini').map(([id, name]) => [id, name, 'Gemini']) };
}

function snapshot(ctx) {
  const { cfg, vault: v } = ctx.current();
  const s = state.load();
  return {
    version: pkg.version,
    platform: process.platform,
    keystore: keystore.describe(),
    gatewayUrl: `http://127.0.0.1:${cfg.port}`,
    current: s.current,
    currentAt: s.currentAt,
    inUse: s.inUse,
    desktopKey: s.desktop,
    desktopAdvice: s.desktopAdvice && { ...s.desktopAdvice, text: require('./desktopadvice').message(s.desktopAdvice) },
    claudeFound: Boolean(claude.findClaude()),
    checking: checks.checking(),
    accounts: cfg.accounts.map((a) => ({
      id: a.id,
      label: a.label,
      kind: a.kind,
      provider: a.provider || 'anthropic',
      enabled: a.enabled !== false,
      lastCheck: s.accounts[a.id] || null,
      usage: s.usage[a.id] ? { ...s.usage[a.id], text: usage.describe(s.usage[a.id]) } : null,
    })),
    keys: v.keys.map((k) => ({
      id: k.id,
      label: k.label,
      masked: keys.mask(k.key),
      provider: k.provider || 'anthropic',
      addedAt: k.addedAt,
      lastCheck: s.keys[k.id] || null,
      coolingDown: state.isCoolingDown(k.id, cfg.cooldownMinutes),
      enabled: !relay.isPaused(cfg, 'key', k),
    })),
    // Your relay order, accounts and keys mixed, as "account:<id>" / "key:<id>".
    order: relay.lines(cfg, v.keys).map((l) => relay.lineId(l.type, l.item.id)),
    pinned: cfg.pinned || null,
    settings: { cooldownMinutes: cfg.cooldownMinutes, accountRecheckMinutes: cfg.accountRecheckMinutes, models: cfg.models, modelChoices: modelChoices(cfg, s), codexAuthFound: Boolean(openaiAuth.readCodexAuth()), geminiCliFound: Boolean(require('./google-auth').readGeminiCli()), desktopStrictSandbox: Boolean(cfg.desktopStrictSandbox), desktopConnectors: (cfg.desktopConnectors || []).map((e) => ({ ...e, signIn: require('./connectorcatalog').describeAuth(e, v) })), desktopAccount: cfg.desktopAccount || 'default', desktopAlerts: cfg.desktopAlerts !== false },
    traffic: events.stats(),
    shell: shell.status(),
    service: service.status(),
    desktop: { ...desktop.status(desktop.settings(cfg, v)), platform: process.platform, steps: desktop.STEPS, baseUrl: `http://127.0.0.1:${cfg.port}` },
    codex: { installed: codex.installed(), ...codex.status(cfg) },
  };
}

// ---------------------------------------------------------------- keys

async function addKey(body) {
  const key = String(body.key || '').trim();
  const problem = keys.problemWith(key);
  if (problem) throw httpError(400, `Can't save it: ${problem}`);
  const entry = vault.update((v) => {
    const id = keys.fingerprint(key);
    if (v.keys.some((k) => k.id === id)) throw httpError(409, 'That key is already saved.');
    const created = keys.newEntry(key, clean(body.label), v.keys.length + 1);
    v.keys.push(created);
    return created;
  });
  log(`added API key "${entry.label}"`);
  const check = await checks.key(entry);
  // A new key may read a provider's model list the others couldn't.
  if (check && check.verdict !== 'used-up') require('./models').refresh({ force: true }).catch(() => {});
  return { id: entry.id, check };
}

async function checkKey(id) {
  const entry = vault.load().keys.find((k) => k.id === id);
  if (!entry) throw httpError(404, 'That key no longer exists.');
  const result = await checks.key(entry);
  events.emit('check', { label: entry.label, verdict: result.verdict, status: result.status });
  return result;
}

async function checkAllKeys() {
  const cfg = config.load();
  const results = {};
  for (const entry of vault.load().keys) results[entry.id] = await checks.key(entry, cfg);
  return results;
}

function editKey(id, body) {
  vault.update((v) => {
    const entry = v.keys.find((k) => k.id === id);
    if (!entry) throw httpError(404, 'That key no longer exists.');
    const label = clean(body.label);
    if (label) entry.label = label;
  });
  if (typeof body.enabled === 'boolean') pauseKey(id, !body.enabled);
}

// A paused key stays saved but is never used, by sessions or the desktop app.
function pauseKey(id, paused) {
  config.update((c) => {
    const rest = (c.pausedKeys || []).filter((k) => k !== id);
    c.pausedKeys = paused ? [...rest, id] : rest;
  });
  log(`${paused ? 'paused' : 'resumed'} an API key`);
}

// Moves a line one place up or down in your relay order, past accounts and keys alike.
function moveLine(type, id, direction) {
  const all = vault.load().keys;
  config.update((c) => {
    const order = relay.moved(c, all, type, id, direction);
    if (!order) throw httpError(404, 'That line no longer exists.');
    c.order = order;
  });
}

// A whole new order, from dragging a line in the web UI.
function setOrder(body) {
  const all = vault.load().keys;
  config.update((c) => {
    if (!relay.validOrder(c, all, body.order)) throw httpError(409, 'The list changed in the meantime. Try again.');
    c.order = body.order;
  });
}

function removeKey(id) {
  vault.update((v) => {
    v.keys = v.keys.filter((k) => k.id !== id);
  });
  state.forgetKey(id);
  unpinIf('key', id);
  config.update((c) => {
    c.pausedKeys = (c.pausedKeys || []).filter((k) => k !== id);
    if (c.order) c.order = c.order.filter((l) => l !== relay.lineId('key', id));
  });
  log('removed an API key');
}

// ---------------------------------------------------------------- accounts

function startLogin(account, bin) {
  const id = crypto.randomBytes(8).toString('hex');
  const child = claude.start(bin, accounts.LOGIN_ARGS, { env: accounts.env(account), cwd: paths.HOME });
  const job = { id, accountId: account.id, output: '', done: false, ok: false, child };
  jobs.set(id, job);
  const append = (data) => {
    job.output = (job.output + stripAnsi(data)).slice(-20000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.stdin.on('error', () => {});
  child.on('error', (err) => {
    append(`\n${err.message}`);
    job.done = true;
  });
  child.on('close', (code) => {
    job.done = true;
    job.ok = code === 0;
    state.forgetAccount(account.id);
    log(`sign-in for "${account.label}" ${job.ok ? 'finished' : `ended with code ${code}`}`);
    // Find out straight away whether the newly signed-in account has usage left, and bring
    // its cloud sessions here so nothing it worked on is left behind.
    if (job.ok) {
      checks.account(account, bin);
      startImport(account);
    }
  });
  // A sign-in left open in the browser is abandoned after 15 minutes.
  setTimeout(() => {
    if (!job.done) child.kill();
  }, 15 * 60000).unref();
  return job;
}

// A ChatGPT sign-in: OpenAI's page opens in the browser; this computer catches the redirect
// (openai-auth.js). The job's output carries the address, so the page can show the link.
function startChatgptLogin(account) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = { id, accountId: account.id, output: '', done: false, ok: false, child: null, chatgpt: true };
  jobs.set(id, job);
  openaiAuth.startLogin(account.id).then((login) => {
    job.output = `Sign in to ChatGPT in the browser window that opened.\n${login.url}\n`;
    job.cancel = login.cancel;
    openBrowser(login.url);
    return login.done;
  }).then((creds) => {
    job.done = true;
    job.ok = true;
    job.output += `\nSigned in${creds.email ? ` as ${creds.email}` : ''}${creds.plan ? ` (${creds.plan})` : ''}.\n`;
    state.forgetAccount(account.id);
    log(`sign-in for "${account.label}" finished`);
    checks.account(account, null);
  }).catch((err) => {
    job.done = true;
    job.ok = false;
    job.output += `\n${err.message}\n`;
    log(`sign-in for "${account.label}" failed: ${err.message}`);
  });
  return job;
}

// Signs in to a Google account for Gemini: Google's own page, caught by google-auth.js.
function startGeminiLogin(account) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = { id, accountId: account.id, output: '', done: false, ok: false, child: null, chatgpt: true };
  jobs.set(id, job);
  require('./google-auth').startLogin(account.id).then((login) => {
    job.output = `Sign in with Google in the browser window that opened.\n${login.url}\n`;
    job.cancel = login.cancel;
    openBrowser(login.url);
    return login.done;
  }).then((creds) => {
    job.done = true;
    job.ok = true;
    job.output += `\nSigned in${creds.email ? ` as ${creds.email}` : ''}${creds.tier ? ` (${creds.tier})` : ''}.\n`;
    state.forgetAccount(account.id);
    log(`sign-in for "${account.label}" finished`);
    checks.account(account, null);
    require('./models').refresh({ force: true }).catch(() => {});
  }).catch((err) => {
    job.done = true;
    job.ok = false;
    job.output += `\n${err.message}\n`;
    log(`sign-in for "${account.label}" failed: ${err.message}`);
  });
  return job;
}

function openBrowser(url) {
  const opts = { detached: true, stdio: 'ignore', windowsHide: true };
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  try {
    const cmd = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
    const child = spawn(cmd[0], cmd[1], opts);
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- cloud sessions

// One import per account at a time, kept in memory for the page to follow.
const imports = new Map();

function startImport(account) {
  const running = imports.get(account.id);
  if (running && !running.done) return running;
  const job = { accountId: account.id, done: false, index: 0, total: 0, title: '', counts: {}, error: null, startedAt: Date.now() };
  imports.set(account.id, job);
  require('./cloudsessions').importAny(account, {
    onProgress: (p) => Object.assign(job, { index: p.index, total: p.total, title: p.title }),
  }).then((results) => {
    for (const r of results) job.counts[r.outcome] = (job.counts[r.outcome] || 0) + 1;
    job.total = results.length;
    job.failed = results.filter((r) => r.outcome === 'failed').map((r) => ({ title: r.title, why: r.why }));
    job.codex = results.codex || null;
    if ((job.counts.imported || 0) + (job.counts.updated || 0) > 0) desktopImportWanted = true;
  }).catch((err) => {
    job.error = err.message;
    log(`imports: ${account.label}: ${err.message}`);
  }).finally(() => {
    job.done = true;
    events.notify('imports', { id: account.id });
    // Once every running import is done, open the desktop app's Import page (one click there).
    if (desktopImportWanted && [...imports.values()].every((j) => j.done)) {
      desktopImportWanted = false;
      if (config.load().openDesktopImport !== false) setTimeout(() => require('./cloudsessions').openDesktopImport(), 1500);
    }
  });
  return job;
}
let desktopImportWanted = false;

function importView(id) {
  const job = imports.get(id);
  return job ? { ...job } : { done: true, idle: true };
}

function importAccountSessions(id) {
  const account = findAccount(id);
  return importView(startImport(account).accountId);
}

// Brings every switched-on account's cloud sessions (and Codex tasks) here at once.
function importAllSessions() {
  const list = require('./cloudsessions').importable().filter((a) => a.enabled !== false);
  for (const a of list) startImport(a);
  return { accounts: list.map((a) => a.id) };
}

// Merges the chats picked in the page into one new chat, then hands it to Codex and opens the
// desktop app's Import page so it can be added there too.
async function mergeChatsNow(body) {
  const merge = require('./merge');
  const m = merge.mergeChats({ target: body.target || null, sources: Array.isArray(body.sources) ? body.sources : [], folder: body.folder || null, title: body.title || null });
  const codex = await merge.shareMerged(m);
  if (config.load().openDesktopImport !== false) setTimeout(() => require('./cloudsessions').openDesktopImport(), 800);
  log(`merge: ${m.sources.length} chat(s) into "${m.title}" in ${m.folder}`);
  return { title: m.title, folder: m.folder, sessionId: m.sessionId, codex };
}

function jobView(id) {
  const job = jobs.get(id);
  if (!job) throw httpError(404, 'That sign-in is no longer running.');
  const url = (job.output.match(/https:\/\/\S+/) || [null])[0];
  return { done: job.done, ok: job.ok, output: job.output.trim().split('\n').slice(-12).join('\n'), url, chatgpt: Boolean(job.chatgpt) };
}

function jobInput(id, text) {
  const job = jobs.get(id);
  if (!job || job.done) throw httpError(404, 'That sign-in is no longer running.');
  if (!job.child) throw httpError(400, 'This sign-in finishes in the browser; there is no code to paste.');
  job.child.stdin.write(`${String(text || '').trim()}\n`);
}

function addAccount(body) {
  const cfg = config.load();
  const label = clean(body.label) || `Account ${cfg.accounts.length + 1}`;
  if (body.service === 'gemini' || body.service === 'google') {
    const account = accounts.createGemini(label);
    config.update((c) => c.accounts.push(account));
    log(`added Gemini account "${account.label}"`);
    if (body.importGemini) {
      try {
        const creds = require('./google-auth').importGeminiCli(account.id);
        checks.account(account, null);
        return { id: account.id, imported: true, email: creds.email };
      } catch (err) {
        config.update((c) => (c.accounts = c.accounts.filter((a) => a.id !== account.id)));
        throw httpError(400, `${err.message[0].toUpperCase()}${err.message.slice(1)}`);
      }
    }
    return { id: account.id, job: startGeminiLogin(account).id };
  }
  if (body.service === 'chatgpt' || body.service === 'openai') {
    const account = accounts.createChatgpt(label);
    config.update((c) => c.accounts.push(account));
    log(`added ChatGPT account "${account.label}"`);
    if (body.importCodex) {
      try {
        const creds = openaiAuth.importCodexAuth(account.id);
        checks.account(account, null);
        return { id: account.id, imported: true, email: creds.email, plan: creds.plan };
      } catch (err) {
        config.update((c) => (c.accounts = c.accounts.filter((a) => a.id !== account.id)));
        throw httpError(400, `${err.message[0].toUpperCase()}${err.message.slice(1)}`);
      }
    }
    return { id: account.id, job: startChatgptLogin(account).id };
  }
  const bin = requireClaude();
  const account = accounts.createProfile(label);
  config.update((c) => c.accounts.push(account));
  log(`added account "${account.label}"`);
  return { id: account.id, job: startLogin(account, bin).id };
}

function loginAccount(id) {
  const account = findAccount(id);
  if (accounts.isChatgpt(account)) return { job: startChatgptLogin(account).id };
  if (accounts.isGemini(account)) return { job: startGeminiLogin(account).id };
  return { job: startLogin(account, requireClaude()).id };
}

async function accountStatuses() {
  const bin = claude.findClaude();
  const list = config.load().accounts.filter((a) => bin || accounts.notClaude(a));
  const results = await Promise.all(list.map((a) => accounts.status(a, bin)));
  return Object.fromEntries(list.map((a, i) => [a.id, results[i]]));
}

function checkAccount(id) {
  const account = findAccount(id);
  return checks.account(account, accounts.notClaude(account) ? null : requireClaude());
}

// The page asks for this whenever it opens; anything with a clear answer from the last
// few minutes is left alone. Returns at once: the page hears when each check ends.
function startChecks() {
  checks.all({ freshMs: 5 * 60000 });
  usage.refreshAll({ freshMs: 60000 }).catch(() => null);
  return { checking: checks.checking() };
}

function editAccount(id, body) {
  config.update((c) => {
    const account = c.accounts.find((a) => a.id === id);
    if (!account) throw httpError(404, 'That account no longer exists.');
    const label = clean(body.label);
    if (label) account.label = label;
    if (typeof body.enabled === 'boolean') account.enabled = body.enabled;
  });
}

async function removeAccount(id) {
  const account = findAccount(id);
  if (account.kind !== 'profile' && !accounts.notClaude(account)) throw httpError(400, 'The main account is your normal Claude Code login. Turn it off instead.');
  await accounts.remove(account, claude.findClaude());
  config.update((c) => {
    c.accounts = c.accounts.filter((a) => a.id !== id);
    if (c.order) c.order = c.order.filter((l) => l !== relay.lineId('account', id));
  });
  unpinIf('account', id);
  log(`removed account "${account.label}"`);
}

// ---------------------------------------------------------------- the rope

// Plugging the rope into a line pins it: see relay.js for what that changes.
function setPin(body) {
  const type = body.type === 'key' ? 'key' : body.type === 'account' ? 'account' : null;
  const id = String(body.id || '');
  if (!type) throw httpError(400, 'Pin an account or an API key.');
  if (type === 'key' && !vault.load().keys.some((k) => k.id === id)) throw httpError(404, 'That key no longer exists.');
  config.update((c) => {
    if (type === 'account') {
      const account = c.accounts.find((a) => a.id === id);
      if (!account) throw httpError(404, 'That account no longer exists.');
      account.enabled = true;
    } else {
      c.pausedKeys = (c.pausedKeys || []).filter((k) => k !== id);
    }
    c.pinned = { type, id };
  });
  log(`rope plugged into ${type} ${id}`);
  events.emit('pin', { pinType: type, id });
}

function unpinIf(type, id) {
  config.update((c) => {
    if (c.pinned && c.pinned.type === type && c.pinned.id === id) c.pinned = null;
  });
}

// ---------------------------------------------------------------- settings & desktop

function editSettings(body) {
  config.update((c) => {
    for (const name of ['cooldownMinutes', 'accountRecheckMinutes']) {
      if (body[name] === undefined) continue;
      const n = Number(body[name]);
      if (!Number.isInteger(n) || n < 1 || n > 1440) throw httpError(400, 'Use a whole number of minutes between 1 and 1440.');
      c[name] = n;
    }
    if (body.models && typeof body.models === 'object') {
      for (const id of ['anthropic', 'openai', 'gemini']) {
        if (typeof body.models[id] !== 'string') continue;
        const model = body.models[id].trim();
        if (!model || model.length > 80 || !/^[\w.:/-]+$/.test(model)) throw httpError(400, 'Give a model name, like claude-sonnet-5-5 or gpt-5.5.');
        c.models = { ...c.models, [id]: model };
      }
    }
    if (typeof body.desktopStrictSandbox === 'boolean') c.desktopStrictSandbox = body.desktopStrictSandbox;
    if (typeof body.desktopAlerts === 'boolean') c.desktopAlerts = body.desktopAlerts;
    if (body.desktopAccount !== undefined) {
      if (!c.accounts.some((a) => a.id === body.desktopAccount)) throw httpError(400, 'That account no longer exists.');
      c.desktopAccount = body.desktopAccount;
    }
  });
  // Codex is told the model it should ask for; keep it current.
  if (body.models && codex.status(config.load()).wired) {
    try {
      codex.apply(config.load(), vault.loadWithTokens());
    } catch (err) {
      log(`codex: couldn't update its model: ${err.message}`);
    }
  }
  // A different account (or alerts turned off) changes the advice: work it out again now.
  if (body.desktopAccount !== undefined || body.desktopAlerts !== undefined) {
    state.setDesktopAdvice(null);
    require('./desktopadvice').tick().catch(() => {});
  }
}

const sentence = (m) => `${m[0].toUpperCase()}${m.slice(1)}${/[.!?]$/.test(m) ? '' : '.'}`;

async function addConnector(body) {
  try {
    return await require('./connectorcatalog').add({ slug: body.slug, name: body.name, url: body.url, token: body.token, client: body.client, noAuth: body.oauth === false, oauth: body.oauth === true });
  } catch (err) {
    const e = httpError(400, sentence(err.message));
    if (err.code === 'needs-token') e.needsToken = true;
    if (err.code) e.details = { need: err.code, redirect: err.redirect, clientUrl: err.clientUrl };
    throw e;
  }
}

// Starts a connector's sign-in in the browser; the page watches the connectors list for it.
async function connectConnector(name, body) {
  const cat = require('./connectorcatalog');
  let login;
  try {
    login = await cat.connect(name, { client: body.client });
  } catch (err) {
    const e = httpError(400, sentence(err.message));
    if (err.code) e.details = { need: err.code, redirect: err.redirect };
    if (err.code === 'app-sign-in') e.status = 409;
    throw e;
  }
  openBrowser(login.url);
  login.done.then(() => events.notify('connectors', { name })).catch(() => {});
  return { url: login.url };
}

async function testConnector(name) {
  return require('./connectorcatalog').test(name);
}

function removeConnector(name) {
  require('./connectorcatalog').remove(name);
  return { ok: true };
}

function connectorCatalog() {
  const cat = require('./connectorcatalog');
  return { connectors: cat.catalog(), gh: Boolean(cat.ghToken()), clients: Object.keys(vault.load().oauthClients || {}), redirect: require('./mcpauth').redirectUri() };
}

// Runs `claude-nonstop desktop --quiet` in its own process: the system's admin prompt can
// stay open for a while, and the gateway must keep serving meanwhile.
function desktopAuto() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [paths.APP_SCRIPT, 'desktop', '--quiet'], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => resolve({ ok: false }));
    child.on('exit', (code) => resolve({ ok: code === 0 }));
  });
}

function desktopSetup(ctx) {
  const { cfg, vault: v } = ctx.current();
  const file = desktop.write(cfg, v);
  return { file, settings: desktop.settings(cfg, v) };
}

async function route(method, pathname, body, ctx) {
  const [, area, id, action] = pathname.split('/').filter(Boolean);
  if (area === 'state' && method === 'GET') return snapshot(ctx);
  if (area === 'checks' && method === 'POST' && !id) return startChecks();
  if (area === 'order' && method === 'PUT') return setOrder(body);
  if (area === 'keys') {
    if (method === 'POST' && !id) return addKey(body);
    if (method === 'POST' && id === 'check-all') return checkAllKeys();
    if (method === 'POST' && action === 'check') return checkKey(id);
    if (method === 'POST' && action === 'move') return moveLine('key', id, body.direction);
    if (method === 'PATCH' && id) return editKey(id, body);
    if (method === 'DELETE' && id) return removeKey(id);
  }
  if (area === 'accounts') {
    if (method === 'GET' && id === 'status') return accountStatuses();
    if (method === 'POST' && !id) return addAccount(body);
    if (method === 'POST' && action === 'login') return loginAccount(id);
    if (method === 'POST' && action === 'check') return checkAccount(id);
    if (method === 'POST' && action === 'import') return importAccountSessions(id);
    if (method === 'GET' && action === 'import') return importView(id);
    if (method === 'POST' && action === 'move') return moveLine('account', id, body.direction);
    if (method === 'PATCH' && id) return editAccount(id, body);
    if (method === 'DELETE' && id) return removeAccount(id);
  }
  if (area === 'imports' && method === 'POST' && !id) return importAllSessions();
  if (area === 'chats' && method === 'GET' && !id) return { chats: require('./merge').listChats() };
  if (area === 'merge' && method === 'POST' && !id) return mergeChatsNow(body);
  if (area === 'jobs' && id) {
    if (method === 'GET') return jobView(id);
    if (method === 'POST' && action === 'input') return jobInput(id, body.text);
  }
  if (area === 'desktop' && method === 'POST' && !id) return desktopSetup(ctx);
  if (area === 'codex' && method === 'POST' && !id) {
    const { cfg, vault: v } = ctx.current();
    const r = codex.apply(cfg, v);
    log(`codex ${r.changed ? 'set up' : 'already set up'} in ${r.file}`);
    return { ...r, wired: codex.status(cfg).wired };
  }
  if (area === 'desktop' && method === 'POST' && id === 'reveal') return desktop.reveal();
  if (area === 'desktop' && method === 'POST' && id === 'auto') return desktopAuto();
  if (area === 'connectors' && method === 'GET' && id === 'catalog') return connectorCatalog();
  if (area === 'connectors' && method === 'POST' && !id) return addConnector(body);
  if (area === 'connectors' && method === 'POST' && id && action === 'connect') return connectConnector(decodeURIComponent(id), body);
  if (area === 'connectors' && method === 'POST' && id && action === 'test') return testConnector(decodeURIComponent(id));
  if (area === 'connectors' && method === 'DELETE' && id) return removeConnector(decodeURIComponent(id));
  if (area === 'settings' && method === 'PATCH') return editSettings(body);
  if (area === 'pin' && method === 'PUT') return setPin(body);
  if (area === 'pin' && method === 'DELETE') {
    config.update((c) => (c.pinned = null));
    events.emit('pin', { pinType: null });
    return { ok: true };
  }
  if (area === 'cooldowns' && method === 'DELETE') return state.clearCooldowns();
  throw httpError(404, 'unknown request');
}

function streamEvents(req, res) {
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  for (const event of events.recent()) send({ ...event, backlog: true });
  events.bus.on('event', send);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    events.bus.removeListener('event', send);
  });
}

async function handle(req, res, ctx) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const { vault: v } = ctx.current();
  if (url.pathname === '/auth') {
    if (!sameToken(url.searchParams.get('t'), v.uiToken)) {
      html(res, 403, messagePage('This link has expired', 'Run <code>claude-nonstop ui</code> in a terminal to open the web UI.'));
      return;
    }
    res.writeHead(302, {
      ...SECURITY_HEADERS,
      'set-cookie': `cn_ui=${encodeURIComponent(v.uiToken)}; HttpOnly; SameSite=Strict; Path=/${req.secure ? '; Secure' : ''}`,
      location: '/',
    });
    res.end();
    return;
  }
  const signedIn = sameToken(cookieToken(req), v.uiToken);
  if (url.pathname === '/') {
    if (!signedIn) {
      html(res, 401, messagePage('Open claude-nonstop from your terminal', 'Run <code>claude-nonstop ui</code>. It opens this page with a one-time link, so only you can manage your keys.'));
      return;
    }
    html(res, 200, fs.readFileSync(PAGE, 'utf8'));
    return;
  }
  // The live stream: EventSource can't send custom headers, so it needs only the cookie.
  // It's read-only, and a SameSite=Strict cookie never reaches it from another site.
  if (url.pathname === '/api/events') {
    if (!signedIn || !originAllowed(req)) {
      json(res, 403, { error: 'Not allowed. Reopen the UI with `claude-nonstop ui`.' });
      return;
    }
    streamEvents(req, res);
    return;
  }
  if (!url.pathname.startsWith('/api/')) {
    json(res, 404, { error: 'not found' });
    return;
  }
  if (!signedIn || req.headers['x-claude-nonstop'] !== '1' || !originAllowed(req)) {
    json(res, 403, { error: 'Not allowed. Reopen the UI with `claude-nonstop ui`.' });
    return;
  }
  try {
    const body = req.method === 'GET' ? {} : await readJsonBody(req);
    const result = await route(req.method, url.pathname, body, ctx);
    ctx.invalidate();
    json(res, 200, result === undefined ? { ok: true } : result);
  } catch (err) {
    ctx.invalidate();
    json(res, err.status || 500, { error: err.message, ...(err.needsToken ? { needsToken: true } : {}), ...(err.details || {}) });
  }
}

module.exports = { handle, route };
