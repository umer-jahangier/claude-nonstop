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
const state = require('./state');
const claude = require('./claude');
const keystore = require('./keystore');
const desktop = require('./desktop');
const service = require('./service');
const shell = require('./shell');
const { sameToken, readBody } = require('./gateway');
const hosts = require('./hosts');
const events = require('./events');
const checks = require('./checks');
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

function move(list, id, direction) {
  const i = list.findIndex((item) => item.id === id);
  const j = direction === 'up' ? i - 1 : i + 1;
  if (i < 0) throw httpError(404, 'not found');
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}

// ---------------------------------------------------------------- state

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
    claudeFound: Boolean(claude.findClaude()),
    checking: checks.checking(),
    accounts: cfg.accounts.map((a) => ({
      id: a.id,
      label: a.label,
      kind: a.kind,
      enabled: a.enabled !== false,
      lastCheck: s.accounts[a.id] || null,
    })),
    keys: v.keys.map((k) => ({
      id: k.id,
      label: k.label,
      masked: keys.mask(k.key),
      addedAt: k.addedAt,
      lastCheck: s.keys[k.id] || null,
      coolingDown: state.isCoolingDown(k.id, cfg.cooldownMinutes),
    })),
    pinned: cfg.pinned || null,
    settings: { cooldownMinutes: cfg.cooldownMinutes, accountRecheckMinutes: cfg.accountRecheckMinutes },
    traffic: events.stats(),
    shell: shell.status(),
    service: service.status(),
    desktop: { ...desktop.status(desktop.settings(cfg, v)), platform: process.platform, steps: desktop.STEPS, baseUrl: `http://127.0.0.1:${cfg.port}` },
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
  return { id: entry.id, check: await checks.key(entry) };
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
}

function removeKey(id) {
  vault.update((v) => {
    v.keys = v.keys.filter((k) => k.id !== id);
  });
  state.forgetKey(id);
  unpinIf('key', id);
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
    // Find out straight away whether the newly signed-in account has usage left.
    if (job.ok) checks.account(account, bin);
  });
  // A sign-in left open in the browser is abandoned after 15 minutes.
  setTimeout(() => {
    if (!job.done) child.kill();
  }, 15 * 60000).unref();
  return job;
}

function jobView(id) {
  const job = jobs.get(id);
  if (!job) throw httpError(404, 'That sign-in is no longer running.');
  const url = (job.output.match(/https:\/\/\S+/) || [null])[0];
  return { done: job.done, ok: job.ok, output: job.output.trim().split('\n').slice(-12).join('\n'), url };
}

function jobInput(id, text) {
  const job = jobs.get(id);
  if (!job || job.done) throw httpError(404, 'That sign-in is no longer running.');
  job.child.stdin.write(`${String(text || '').trim()}\n`);
}

function addAccount(body) {
  const bin = requireClaude();
  const cfg = config.load();
  const account = accounts.createProfile(clean(body.label) || `Account ${cfg.accounts.length + 1}`);
  config.update((c) => c.accounts.push(account));
  log(`added account "${account.label}"`);
  return { id: account.id, job: startLogin(account, bin).id };
}

function loginAccount(id) {
  return { job: startLogin(findAccount(id), requireClaude()).id };
}

async function accountStatuses() {
  const bin = claude.findClaude();
  if (!bin) return {};
  const list = config.load().accounts;
  const results = await Promise.all(list.map((a) => accounts.status(a, bin)));
  return Object.fromEntries(list.map((a, i) => [a.id, results[i]]));
}

function checkAccount(id) {
  return checks.account(findAccount(id), requireClaude());
}

// The page asks for this whenever it opens; anything with a clear answer from the last
// few minutes is left alone. Returns at once: the page hears when each check ends.
function startChecks() {
  checks.all({ freshMs: 5 * 60000 });
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
  if (account.kind !== 'profile') throw httpError(400, 'The main account is your normal Claude Code login. Turn it off instead.');
  await accounts.remove(account, claude.findClaude());
  config.update((c) => {
    c.accounts = c.accounts.filter((a) => a.id !== id);
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
  });
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
  if (area === 'keys') {
    if (method === 'POST' && !id) return addKey(body);
    if (method === 'POST' && id === 'check-all') return checkAllKeys();
    if (method === 'POST' && action === 'check') return checkKey(id);
    if (method === 'POST' && action === 'move') return vault.update((v) => move(v.keys, id, body.direction));
    if (method === 'PATCH' && id) return editKey(id, body);
    if (method === 'DELETE' && id) return removeKey(id);
  }
  if (area === 'accounts') {
    if (method === 'GET' && id === 'status') return accountStatuses();
    if (method === 'POST' && !id) return addAccount(body);
    if (method === 'POST' && action === 'login') return loginAccount(id);
    if (method === 'POST' && action === 'check') return checkAccount(id);
    if (method === 'POST' && action === 'move') return config.update((c) => move(c.accounts, id, body.direction));
    if (method === 'PATCH' && id) return editAccount(id, body);
    if (method === 'DELETE' && id) return removeAccount(id);
  }
  if (area === 'jobs' && id) {
    if (method === 'GET') return jobView(id);
    if (method === 'POST' && action === 'input') return jobInput(id, body.text);
  }
  if (area === 'desktop' && method === 'POST' && !id) return desktopSetup(ctx);
  if (area === 'desktop' && method === 'POST' && id === 'reveal') return desktop.reveal();
  if (area === 'desktop' && method === 'POST' && id === 'auto') return desktopAuto();
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
    json(res, err.status || 500, { error: err.message });
  }
}

module.exports = { handle };
