'use strict';

// Says when to switch the Claude desktop app between your Claude.ai account and API keys.
// The app signs in to one Claude.ai account by itself, and claude-nonstop can't move it
// between accounts: subscription sign-ins belong to Anthropic's own apps. What it can do is
// watch that account the way it watches the others, and tell you when a switch helps:
//   'to-keys'     the account hit its limit, and an API key can take over
//   'wait'        the account hit its limit, and no API key can take over either
//   'to-account'  the account has usage again while the app is running on API keys
// The advice shows on the web page, and each new piece of it as a notification.

const { spawn } = require('child_process');
const config = require('./config');
const vault = require('./vault');
const state = require('./state');
const accounts = require('./accounts');
const relay = require('./relay');
const desktop = require('./desktop');
const checks = require('./checks');
const events = require('./events');
const { log } = require('./files');

// The app counts as running on API keys while the gateway has served it in this long.
const ON_KEYS_MS = 30 * 60000;
// While the app is open, its account is checked at most this often (tests shorten it).
const checkEvery = () => Number(process.env.CLAUDE_NONSTOP_DESKTOP_CHECK_MS) || 10 * 60000;

const accountFor = (cfg) => cfg.accounts.find((a) => a.id === (cfg.desktopAccount || 'default')) || null;

// The advice for now, from what's already known; null when there's nothing to switch.
function advice(cfg = config.load(), s = state.load(), now = Date.now()) {
  const account = accountFor(cfg);
  const check = account && s.accounts[account.id];
  if (!check) return null;
  const onKeys = Boolean(s.desktop && now - s.desktop.at < ON_KEYS_MS);
  if (!check.ok && accounts.isLimitReason(check.reason)) {
    // Already on API keys: there's nothing to switch. If those run out too, the page says so.
    if (onKeys) return null;
    const keyFree = relay.keyOrder(cfg, vault.load().keys).some((k) => !state.isCoolingDown(k.id, cfg.cooldownMinutes));
    return { kind: keyFree ? 'to-keys' : 'wait', account: account.label, reason: check.reason };
  }
  // "Switch back" only after the account was seen at its limit: an app you simply run on
  // API keys isn't nagged about an account it never left.
  return check.ok && onKeys && s.desktopLimitedAt ? { kind: 'to-account', account: account.label } : null;
}

function message(a) {
  if (a.kind === 'to-keys') return `${a.account} reached its limit. To keep going in the Claude desktop app, switch it to the third-party option (your API keys) on its sign-in screen.`;
  if (a.kind === 'wait') return `${a.account} reached its limit, and no API key has credit that covers Claude Code. The desktop app can carry on when the limit resets.`;
  return `${a.account} has usage again. Switch the Claude desktop app back to Claude.ai to stop spending API credit.`;
}

const appleString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function notify(text) {
  if (process.env.CLAUDE_NONSTOP_NO_NOTIFY === '1') return;
  const run = (cmd, args) => {
    try {
      spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
    } catch {}
  };
  if (process.platform === 'darwin') run('osascript', ['-e', `display notification ${appleString(text)} with title "claude-nonstop"`]);
  else if (process.platform === 'linux') run('notify-send', ['claude-nonstop', text]);
}

// One look: check the account if its answer is old and the app is open, then save the
// advice and announce it if it changed. Returns the advice.
async function tick({ notifier = notify } = {}) {
  const cfg = config.load();
  const before = state.load().desktopAdvice;
  if (cfg.desktopAlerts === false || !desktop.appInstalled()) {
    if (before) state.setDesktopAdvice(null);
    return null;
  }
  const account = accountFor(cfg);
  const last = account && state.load().accounts[account.id];
  if (account && (!last || Date.now() - last.at > checkEvery()) && desktop.appRunning()) await checks.account(account);
  const now = advice(cfg);
  if (now && now.kind !== 'to-account' && !state.load().desktopLimitedAt) state.setDesktopLimited(Date.now());
  if ((now && now.kind) !== (before && before.kind)) {
    // Once the app has left the keys again after a "switch back", the episode is over.
    if (!now && before && before.kind === 'to-account') state.setDesktopLimited(null);
    state.setDesktopAdvice(now && { ...now, at: Date.now(), said: false });
    events.notify('desktop-advice', { kind: now ? now.kind : null });
    if (now) log(`desktop app: ${now.kind} (${now.account})`);
  }
  // Each piece of advice is said once, and only while the app is open to act on it.
  const current = state.load().desktopAdvice;
  if (current && !current.said && desktop.appRunning()) {
    state.setDesktopAdvice({ ...current, said: true });
    notifier(message(current));
  }
  return now;
}

// Runs in the gateway: a look now and then, and right after any account check finishes.
function start() {
  let running = false;
  const look = () => {
    if (running) return;
    running = true;
    tick()
      .catch((err) => log(`desktop app: advice failed: ${err.message}`))
      .finally(() => (running = false));
  };
  setInterval(look, Math.min(checkEvery(), 60000)).unref();
  events.bus.on('event', (e) => e.type === 'checks' && !e.checking && setTimeout(look, 500).unref());
  look();
}

module.exports = { advice, message, tick, start };
