'use strict';

// Keeps an interactive Claude Code session going across limits, without changing how
// Claude Code works. It relies only on documented Claude Code features:
//
//   - The StopFailure hook tells claude-nonstop the moment a turn stops on a usage limit
//     or a used-up key (https://code.claude.com/docs/en/hooks#stopfailure).
//   - claude-nonstop then looks for the next line with usage left: your next account,
//     then your API keys. If there is one, it reopens the same conversation on it with
//     `claude --resume <session> "Continue where you left off."`, so the work carries on
//     by itself and it stays the same chat, with the same history.
//   - With nothing else left on a claude.ai account, Claude Code's own automatic continue
//     waits in the open session and picks the task up again when the limit resets
//     (autoContinueAtUsageLimit, on by default). On API keys, which Claude Code doesn't
//     wait for, claude-nonstop waits instead and reopens the conversation as soon as an
//     account or a key has usage again.
//   - In Automatic mode, a session that ended up on API keys goes back to an account higher
//     in your order once it has usage again: at the end of a turn, so nothing is cut off,
//     the same conversation reopens there. A line you plugged the cable into stays put.
//
// The hooks run in the background and only append one line to a file this process reads.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const config = require('./config');
const vault = require('./vault');
const keys = require('./keys');
const relay = require('./relay');
const accounts = require('./accounts');
const state = require('./state');
const claude = require('./claude');
const { log, ensureHome } = require('./files');

const CONTINUE_PROMPT = 'Continue where you left off.';
const LIMIT_ERRORS = 'rate_limit|billing_error|authentication_failed|invalid_request';

const say = (message) => process.stderr.write(`claude-nonstop: ${message}\n`);
const shellQuote = (s) => (process.platform === 'win32' ? `"${s}"` : `'${String(s).replace(/'/g, `'\\''`)}'`);

// ---------------------------------------------------------------- the hook

// `claude-nonstop hook`: run by Claude Code. Appends the event to the supervisor's file
// and prints nothing (UserPromptSubmit output would otherwise reach Claude).
async function hook() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const file = process.env.CLAUDE_NONSTOP_EVENTS;
  if (!file) return 0;
  try {
    const data = JSON.parse(input);
    const entry = {
      event: data.hook_event_name,
      session: data.session_id || null,
      error: data.error || null,
      message: [data.last_assistant_message, data.error_details].filter(Boolean).join(' · '),
      at: Date.now(),
    };
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {}
  return 0;
}

function hookSettings() {
  const run = { type: 'command', command: `${shellQuote(process.execPath)} ${shellQuote(paths.APP_SCRIPT)} hook`, async: true, timeout: 30 };
  return {
    SessionStart: [{ hooks: [run] }],
    UserPromptSubmit: [{ hooks: [run] }],
    Stop: [{ hooks: [run] }],
    StopFailure: [{ matcher: LIMIT_ERRORS, hooks: [run] }],
  };
}

// ---------------------------------------------------------------- arguments

// Claude Code flags that take a value, so the value isn't mistaken for a prompt.
const VALUE_FLAGS = new Set([
  '--agent', '--agents', '--append-subagent-system-prompt', '--append-subagent-system-prompt-file', '--append-system-prompt',
  '--append-system-prompt-file', '--channels', '--dangerously-load-development-channels', '--effort', '--fallback-model',
  '--from-pr', '--input-format', '--json-schema', '--max-budget-usd', '--max-turns', '--model', '--name', '-n', '--output-format',
  '--permission-mode', '--permission-prompt-tool', '--plugin-url', '--session-id', '--setting-sources', '--settings',
  '--system-prompt', '--system-prompt-file', '--system-prompt-snapshot', '--teammate-mode',
]);
// Flags that take every value up to the next flag.
const LIST_FLAGS = new Set(['--add-dir', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--betas', '--tools', '--mcp-config', '--plugin-dir']);
// Flags with an optional value.
const OPTIONAL_FLAGS = new Set(['--resume', '-r', '--debug', '--worktree', '-w', '--remote-control', '--rc']);
// Flags that pick a conversation; reopening replaces them with --resume <session>.
const CONVERSATION_FLAGS = new Set(['--resume', '-r', '--continue', '-c', '--session-id', '--fork-session', '--from-pr', '--teleport']);

// Splits Claude Code's arguments into flags (kept, with their values) and positional words
// (the prompt).
function parseArgs(args) {
  const flags = [];
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { words.push(...args.slice(i + 1)); break; }
    if (!a.startsWith('-') || a === '-') { words.push(a); continue; }
    const [name] = a.split('=');
    const group = [a];
    if (!a.includes('=')) {
      if (VALUE_FLAGS.has(name) && i + 1 < args.length) group.push(args[++i]);
      else if (LIST_FLAGS.has(name)) while (i + 1 < args.length && !args[i + 1].startsWith('-')) group.push(args[++i]);
      else if (OPTIONAL_FLAGS.has(name) && i + 1 < args.length && !args[i + 1].startsWith('-')) group.push(args[++i]);
    }
    flags.push({ name, group });
  }
  return { flags, words };
}

// The arguments that reopen this session's conversation, and ask Claude to carry on unless
// `prompt` is null (the turn had finished, so there's nothing to carry on with).
function resumeArgs(args, session, prompt = CONTINUE_PROMPT) {
  const kept = parseArgs(args).flags.filter((f) => !CONVERSATION_FLAGS.has(f.name)).flatMap((f) => f.group);
  return [...kept, '--resume', session, ...(prompt ? [prompt] : [])];
}

// Adds our settings (the hooks, and the key helper when used) to any --settings the user
// passed, so neither is lost.
function withSettings(args, extra) {
  const { flags, words } = parseArgs(args);
  let merged = { ...extra };
  const rest = [];
  for (const f of flags) {
    if (f.name !== '--settings') { rest.push(...f.group); continue; }
    const raw = f.group[0].includes('=') ? f.group[0].slice(f.group[0].indexOf('=') + 1) : f.group[1];
    let theirs = {};
    try { theirs = JSON.parse(raw.trim().startsWith('{') ? raw : fs.readFileSync(raw, 'utf8')); } catch {}
    const hooks = { ...(theirs.hooks || {}) };
    for (const [event, entries] of Object.entries(extra.hooks || {})) hooks[event] = [...(hooks[event] || []), ...entries];
    merged = { ...theirs, ...extra, hooks };
  }
  return ['--settings', JSON.stringify(merged), ...rest, ...words];
}

// Interactive sessions in a terminal are supervised; `claude -p` and piped runs aren't.
function supervisable(args) {
  if (parseArgs(args).flags.some((f) => f.name === '-p' || f.name === '--print')) return false;
  if (process.env.CLAUDE_NONSTOP_SUPERVISE) return process.env.CLAUDE_NONSTOP_SUPERVISE === '1';
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// ---------------------------------------------------------------- lines

const describe = (line) => {
  if (line.kind === 'account') return line.account.label;
  if (line.keys.length === 1) return `API key "${line.keys[0].label}"`;
  return `your API keys ${line.keys.map((k) => `"${k.label}"`).join(', ')}`;
};

// Two lines are the same if they're the same account, or groups sharing a key.
const sameLine = (a, b) =>
  a.kind === b.kind && (a.kind === 'account' ? a.account.id === b.account.id : a.keys.some((k) => b.keys.some((x) => x.id === k.id)));

function recentlyLimited(account, cfg) {
  const r = state.load().accounts[account.id];
  return Boolean(r && !r.ok && accounts.isLimitReason(r.reason) && Date.now() - r.at < cfg.accountRecheckMinutes * 60000);
}

// A group's keys that are still in use and not waiting out a cooldown. The gateway marks a
// key used up the moment it fails.
function freshKeys(group, cfg) {
  const ids = new Set(group.keys.map((k) => k.id));
  return relay.keyOrder(cfg, vault.load().keys).filter((k) => ids.has(k.id) && !state.isCoolingDown(k.id, cfg.cooldownMinutes));
}

// The next line with usage, in your relay order, other than the one that just stopped.
// `liveKeyCheck` tests keys for real instead of trusting their cooldowns, and then also
// counts the stopped group of keys once one of them works again.
async function findNext(line, { cfg, bin, mode, liveKeyCheck = false }) {
  const candidates = relay
    .groups(cfg, vault.load().keys)
    .filter((g) => !sameLine(g, line) && (g.kind === 'account' ? mode !== 'api' : mode !== 'sub'));
  const probes = await Promise.all(candidates.map((g) => (g.kind === 'account' && !recentlyLimited(g.account, cfg) ? accounts.probe(g.account, bin) : null)));
  for (const [i, g] of candidates.entries()) {
    if (g.kind === 'account') {
      if (probes[i] && probes[i].ok) return g;
      continue;
    }
    const fresh = freshKeys(g, cfg);
    if (fresh.length && (!liveKeyCheck || (await keys.pick(fresh, cfg)))) return g;
  }
  if (line.kind === 'keys' && liveKeyCheck) {
    const fresh = freshKeys(line, cfg);
    if (fresh.length && (await keys.pick(fresh, cfg))) return { kind: 'keys', keys: fresh };
  }
  return null;
}

// For a session on API keys: the first account above them in your order that has usage
// again. Automatic mode only; with the cable plugged in, your pick stays put. Read fresh
// each time, so plugging the cable in or out mid-session counts.
async function higherAccount(line, { bin, mode }) {
  const cfg = config.load();
  if (line.kind !== 'keys' || cfg.pinned || mode === 'api') return null;
  const groups = relay.groups(cfg, vault.load().keys);
  const here = groups.findIndex((g) => sameLine(g, line));
  for (const g of groups.slice(0, Math.max(here, 0))) {
    if (g.kind !== 'account' || recentlyLimited(g.account, cfg)) continue;
    if ((await accounts.probe(g.account, bin)).ok) return g;
  }
  return null;
}

// Whether the stopped turn really ran out of usage (and not, say, a passing rate limit).
async function confirmLimit(line, event, { cfg, bin }) {
  if (line.kind === 'account') {
    const r = await accounts.probe(line.account, bin);
    return r.ok ? null : r.reason || event.message || 'its usage limit';
  }
  // Without the gateway nothing marks a key used up as it fails, so test what's left.
  const fresh = freshKeys(line, cfg);
  if (fresh.length && (await keys.pick(fresh, cfg))) return null;
  return `${line.keys.length > 1 ? 'every one of its keys is' : 'it is'} used up`;
}

// ---------------------------------------------------------------- one session

function eventsReader(file) {
  let offset = 0;
  return () => {
    try {
      const size = fs.statSync(file).size;
      if (size <= offset) return [];
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset = size;
      return buf.toString('utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch {
      return [];
    }
  };
}

// Runs Claude Code once. Resolves { code } when it exits by itself, or { next, session,
// why } after stopping it to move the conversation to another line.
function runOnce(bin, args, env, ctx) {
  return new Promise((resolve) => {
    let started;
    try {
      started = claude.spawnInteractive(bin, args, env);
    } catch (err) {
      say(`could not start Claude Code: ${err.message}`);
      resolve({ code: 1 });
      return;
    }
    const read = eventsReader(ctx.events);
    let session = null;
    let pending = null;
    let busy = false;
    let moving = false;
    let gone = false;
    let timer = null;
    // Look again every 2 minutes at first, then every 5 (tests shorten it).
    const recheckDelay = () => Number(process.env.CLAUDE_NONSTOP_RECHECK_MS) || (Date.now() - pending.at < 10 * 60000 ? 2 : 5) * 60000;
    // On API keys, an account higher in your order that has usage again, found in the
    // background every 5 minutes (tests shorten it) and moved to when a turn ends.
    let upgrade = null;
    let lookTimer = null;
    const lookDelay = () => Number(process.env.CLAUDE_NONSTOP_UPGRADE_MS) || 5 * 60000;
    async function lookUp() {
      try {
        const found = await higherAccount(ctx.line, ctx);
        if (!moving && !gone) upgrade = found;
      } catch (err) {
        log(`session: looking for an account with usage failed: ${err.message}`);
      }
      if (!moving && !gone) lookTimer = setTimeout(lookUp, lookDelay());
    }
    if (ctx.line.kind === 'keys') lookTimer = setTimeout(lookUp, lookDelay());

    async function recover() {
      if (busy || !pending || moving) return;
      busy = true;
      try {
        if (!pending.why) {
          // First look: confirm it's a real limit, and find where to go, at the same time.
          const [why, next] = await Promise.all([confirmLimit(ctx.line, pending, ctx), findNext(ctx.line, ctx)]);
          if (!pending) return;
          if (!why) { pending = null; return; }
          pending.why = why;
          if (ctx.line.kind === 'account') state.recordAccount(ctx.line.account.id, { ok: false, reason: why });
          log(`session: ${describe(ctx.line)} stopped (${why})`);
          if (next) return move(next);
        } else {
          const next = await findNext(ctx.line, { ...ctx, liveKeyCheck: ctx.line.kind === 'keys' });
          if (!pending) return;
          if (next) return move(next);
        }
        timer = setTimeout(recover, recheckDelay());
      } catch (err) {
        log(`session: recovery failed: ${err.message}`);
      } finally {
        busy = false;
      }
    }

    async function move(next, { up = false } = {}) {
      // If you quit Claude Code while the next line was being found, leave it closed.
      if (!session || gone) return;
      moving = true;
      clearInterval(poll);
      clearTimeout(timer);
      clearTimeout(lookTimer);
      await claude.stopInteractive(started);
      resolve({ next, session, why: up ? null : pending.why, up });
    }

    const poll = setInterval(() => {
      for (const e of read()) {
        if (e.session) session = e.session;
        if (e.event === 'UserPromptSubmit' || e.event === 'Stop') {
          // You typed, Claude Code's own automatic continue ran, or a turn finished: the
          // session is moving again, so there's nothing to recover.
          pending = null;
          clearTimeout(timer);
          // A turn just ended, so nothing is cut off: go back up if an account has usage again.
          if (e.event === 'Stop' && upgrade && !moving && !config.load().pinned) move(upgrade, { up: true });
        } else if (e.event === 'StopFailure') {
          pending = { at: e.at, error: e.error, message: e.message, why: null };
          clearTimeout(timer);
          recover();
        }
      }
    }, 250);

    started.exited.then((code) => {
      gone = true;
      clearTimeout(lookTimer);
      if (moving) return;
      clearInterval(poll);
      clearTimeout(timer);
      resolve({ code });
    });
  });
}

// ---------------------------------------------------------------- the loop

// Runs Claude Code on `line`, moving the conversation along the relay as lines run out.
// `prepare(line)` returns { env, settings } for a line, or null if it can't be used.
async function run({ bin, args, cfg, mode, line, prepare }) {
  ensureHome();
  const dir = path.join(paths.HOME, 'run');
  fs.mkdirSync(dir, { recursive: true });
  const events = path.join(dir, `${process.pid}.jsonl`);
  fs.writeFileSync(events, '');
  const moves = [];
  let runArgs = args;
  try {
    for (;;) {
      const prepared = await prepare(line);
      if (!prepared) return 1;
      const fullArgs = claude.withoutRootBypass(withSettings(runArgs, { ...(prepared.settings || {}), hooks: hookSettings() }));
      const env = { ...prepared.env, CLAUDE_NONSTOP_EVENTS: events };
      const result = await runOnce(bin, fullArgs, env, { events, line, cfg, bin, mode });
      if (!result.next) return result.code;
      moves.push(Date.now());
      if (moves.filter((t) => Date.now() - t < 10 * 60000).length > 6) {
        say('stopped moving the conversation: every line keeps running out. Check `claude-nonstop status`.');
        return 1;
      }
      if (result.up) say(`${describe(result.next)} has usage again, so this conversation moves back to it.`);
      else say(`${describe(line)} reached its limit, so this conversation continues on ${describe(result.next)}.`);
      log(`session: moving ${result.session} from ${describe(line)} to ${describe(result.next)}${result.up ? ' (back up)' : ''}`);
      line = result.next;
      runArgs = resumeArgs(args, result.session, result.up ? null : CONTINUE_PROMPT);
    }
  } finally {
    fs.rmSync(events, { force: true });
  }
}

module.exports = { run, hook, supervisable, resumeArgs, withSettings, parseArgs, hookSettings, findNext, CONTINUE_PROMPT };
