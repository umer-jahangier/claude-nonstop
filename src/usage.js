'use strict';

// How much of each account's plan is used: the session (its 5-hour window) and the week,
// as percentages with the time each resets, from the same endpoint Claude Code's /usage
// reads. Claude Code keeps an account's sign-in token in that account's config folder (a
// .credentials.json file, or on a Mac an item in the login keychain), and claude-nonstop
// reads it from there to ask. API keys have no such readout: Anthropic shows a key's
// credit only in the Console, so a key's line shows its last test instead.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('./config');
const state = require('./state');
const events = require('./events');
const { request } = require('./http');
const { log } = require('./files');

const OAUTH_BETA = 'oauth-2025-04-20';
const usageUrl = (cfg) => process.env.CLAUDE_NONSTOP_USAGE_URL || `${cfg.upstream}/api/oauth/usage`;

// The keychain item Claude Code keeps an account's token in: one per config folder, named
// after the folder's path (the main account, with no folder of its own, uses the plain name).
function keychainService(configDir) {
  const suffix = configDir ? `-${crypto.createHash('sha256').update(String(configDir)).digest('hex').slice(0, 8)}` : '';
  return `Claude Code-credentials${suffix}`;
}

const configDirOf = (account) => (account.kind === 'profile' ? account.configDir : process.env.CLAUDE_CONFIG_DIR || null);

// The account's current sign-in token, or null when there's none to be found.
function readCredentials(account) {
  const dir = configDirOf(account);
  const file = path.join(dir || path.join(os.homedir(), '.claude'), '.credentials.json');
  let raw = null;
  try {
    if (fs.existsSync(file)) raw = fs.readFileSync(file, 'utf8');
    else if (process.platform === 'darwin') {
      const r = spawnSync('security', ['find-generic-password', '-s', keychainService(dir), '-w'], { encoding: 'utf8', windowsHide: true });
      if (r.status === 0) raw = r.stdout;
    }
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const o = JSON.parse(raw).claudeAiOauth;
    return o && o.accessToken ? { token: o.accessToken, expiresAt: Number(o.expiresAt) || 0 } : null;
  } catch {
    return null;
  }
}

// Reset times come with microseconds, which Date can't read; milliseconds are plenty.
const when = (iso) => (iso ? Date.parse(String(iso).replace(/(\.\d{3})\d+/, '$1')) || null : null);
const window = (v) => (v && typeof v.utilization === 'number' ? { pct: Math.max(0, Math.min(100, Math.round(v.utilization))), resetsAt: when(v.resets_at) } : null);

// The windows worth showing: the session and the week always, plus any per-model week.
function parse(body) {
  const j = JSON.parse(body);
  const out = { session: window(j.five_hour), week: window(j.seven_day) };
  for (const [key, name] of [
    ['seven_day_opus', 'opus'],
    ['seven_day_sonnet', 'sonnet'],
  ]) {
    const w = window(j[key]);
    if (w) out[name] = w;
  }
  if (!out.session && !out.week) throw new Error('no usage in the answer');
  return out;
}

function resetsIn(at, now = Date.now()) {
  if (!at) return '';
  const min = Math.max(0, Math.round((at - now) / 60000));
  if (min < 60) return ` (resets in ${min} min)`;
  const [big, small, unit, rest] = min < 24 * 60 ? [Math.floor(min / 60), min % 60, 'h', 'min'] : [Math.floor(min / 1440), Math.floor((min % 1440) / 60), 'd', 'h'];
  return ` (resets in ${big} ${unit}${small ? ` ${small} ${rest}` : ''})`;
}

// One line a person can read: "Session 6% (resets in 2 h) · Week 75% (resets in 1 d)".
function describe(u, now = Date.now()) {
  if (!u) return '';
  const parts = [];
  if (u.session) parts.push(`Session ${u.session.pct}%${resetsIn(u.session.resetsAt, now)}`);
  if (u.week) parts.push(`Week ${u.week.pct}%${resetsIn(u.week.resetsAt, now)}`);
  if (u.opus) parts.push(`Opus ${u.opus.pct}%`);
  if (u.sonnet) parts.push(`Sonnet ${u.sonnet.pct}%`);
  return parts.join(' · ');
}

// Asks once for one account and records the answer. A failure keeps the last good numbers
// and notes why they're old. Returns what was recorded.
async function refresh(account, cfg = config.load()) {
  const before = state.load().usage[account.id] || null;
  const keep = (error) => {
    const next = before && before.session ? { ...before, error } : { error, at: Date.now() };
    state.recordUsage(account.id, next);
    return next;
  };
  const creds = readCredentials(account);
  if (!creds) return keep('no sign-in token found');
  if (creds.expiresAt && creds.expiresAt < Date.now()) return keep('sign-in token expired; it renews with the next account check');
  let r;
  try {
    r = await request(usageUrl(cfg), {
      headers: { authorization: `Bearer ${creds.token}`, 'anthropic-beta': OAUTH_BETA, accept: 'application/json', 'user-agent': 'claude-nonstop' },
      timeoutMs: 15000,
    });
  } catch (err) {
    return keep(err.message);
  }
  if (r.status === 401) return keep('sign-in no longer accepted; sign in again');
  if (r.status !== 200) return keep(`HTTP ${r.status}`);
  let parsed;
  try {
    parsed = parse(r.body);
  } catch (err) {
    return keep(err.message);
  }
  const next = { ...parsed, at: Date.now() };
  state.recordUsage(account.id, next);
  events.notify('usage', { id: account.id });
  return next;
}

// Refreshes every account that's in use and whose numbers are older than `freshMs`.
function refreshAll({ freshMs = 0 } = {}) {
  const cfg = config.load();
  const s = state.load();
  const due = cfg.accounts.filter((a) => a.enabled !== false && !(s.usage[a.id] && s.usage[a.id].at && Date.now() - s.usage[a.id].at < freshMs));
  return Promise.all(due.map((a) => refresh(a, cfg).catch((err) => log(`usage: ${a.label}: ${err.message}`))));
}

// Runs in the gateway: fresh numbers every few minutes, cheaply (one small request each).
function start() {
  const every = Number(process.env.CLAUDE_NONSTOP_USAGE_EVERY_MS) || 5 * 60000;
  setInterval(() => refreshAll({ freshMs: every - 30000 }), every).unref();
  refreshAll();
}

module.exports = { keychainService, readCredentials, parse, describe, refresh, refreshAll, start };
