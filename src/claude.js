'use strict';

// Finding and starting the real, unmodified Claude Code binary on every platform.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('./paths');

const isWin = process.platform === 'win32';

function isExecutable(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (!isWin) fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const samePath = (a, b) => (isWin ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

function findClaude() {
  if (process.env.CLAUDE_NONSTOP_CLAUDE) return process.env.CLAUDE_NONSTOP_CLAUDE;
  const exts = isWin ? ['.exe', '.cmd', '.bat'] : [''];
  const ownShims = path.join(paths.HOME, 'shims');
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter);
  // Installs that a shell alias points at, which aren't on PATH.
  dirs.push(path.join(os.homedir(), '.claude', 'local'), path.join(os.homedir(), '.local', 'bin'));
  for (const rawDir of dirs) {
    const dir = rawDir.replace(/^"(.*)"$/, '$1');
    // claude-nonstop's own `claude` shim must never be mistaken for Claude Code.
    if (!dir || samePath(dir, ownShims)) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `claude${ext}`);
      if (!isExecutable(candidate)) continue;
      if (ext === '.cmd') {
        // npm's claude.cmd only forwards to the bundled claude.exe, so run that directly.
        const exe = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
        if (isExecutable(exe)) return exe;
      }
      return candidate;
    }
  }
  return null;
}

// Windows can't start a .cmd file without cmd.exe, which re-parses the command line.
// This quotes and escapes each argument the same way cross-spawn does.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeForCmd(arg) {
  let s = String(arg)
    .replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
    .replace(/(?=(\\+?)?)\1$/, '$1$1');
  s = `"${s}"`;
  // Escaped twice: once for cmd.exe, once for the batch file that forwards %*.
  return s.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}

function command(bin, args) {
  if (isWin && /\.(cmd|bat)$/i.test(bin)) {
    const line = [bin.replace(CMD_META, '^$1'), ...args.map(escapeForCmd)].join(' ');
    return { file: process.env.comspec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } };
  }
  return { file: bin, args, options: {} };
}

function exitCodeOf(code, signal) {
  if (typeof code === 'number') return code;
  return signal ? 128 + (os.constants.signals[signal] || 1) : 1;
}

// Runs Claude Code in this terminal and resolves with its exit code. Ctrl-C belongs to
// Claude Code, so this process ignores it while Claude Code runs.
function runInteractive(bin, args, env) {
  return new Promise((resolve) => {
    const c = command(bin, args);
    let child;
    try {
      child = spawn(c.file, c.args, { ...c.options, env, stdio: 'inherit' });
    } catch (err) {
      process.stderr.write(`claude-nonstop: could not start Claude Code: ${err.message}\n`);
      resolve(1);
      return;
    }
    const ignore = () => {};
    const forwardTerm = () => child.kill('SIGTERM');
    const forwardHup = () => child.kill('SIGHUP');
    process.on('SIGINT', ignore);
    process.on('SIGTERM', forwardTerm);
    process.on('SIGHUP', forwardHup);
    const done = (code) => {
      process.removeListener('SIGINT', ignore);
      process.removeListener('SIGTERM', forwardTerm);
      process.removeListener('SIGHUP', forwardHup);
      resolve(code);
    };
    child.on('error', (err) => {
      process.stderr.write(`claude-nonstop: could not start Claude Code: ${err.message}\n`);
      done(1);
    });
    child.on('exit', (code, signal) => done(exitCodeOf(code, signal)));
  });
}

// Like runInteractive, but hands back the child too, so a supervisor can stop it.
function spawnInteractive(bin, args, env) {
  const c = command(bin, args);
  const child = spawn(c.file, c.args, { ...c.options, env, stdio: 'inherit' });
  const ignore = () => {};
  const forwardTerm = () => child.kill('SIGTERM');
  const forwardHup = () => child.kill('SIGHUP');
  process.on('SIGINT', ignore);
  process.on('SIGTERM', forwardTerm);
  process.on('SIGHUP', forwardHup);
  const exited = new Promise((resolve) => {
    const done = (code) => {
      process.removeListener('SIGINT', ignore);
      process.removeListener('SIGTERM', forwardTerm);
      process.removeListener('SIGHUP', forwardHup);
      resolve(code);
    };
    child.on('error', (err) => {
      process.stderr.write(`claude-nonstop: could not start Claude Code: ${err.message}\n`);
      done(1);
    });
    child.on('exit', (code, signal) => done(exitCodeOf(code, signal)));
  });
  return { child, exited };
}

// Ends a Claude Code session started with spawnInteractive, then puts the terminal back
// the way a normal exit would leave it (in case Claude Code had no chance to).
async function stopInteractive({ child, exited }) {
  if (isWin) {
    // Takes Claude Code down with anything it started, e.g. when cmd.exe launched it.
    require('child_process').spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(timer);
  }
  await exited;
  if (process.stdout.isTTY) {
    // Leave the alternate screen, and turn off mouse, focus, paste and keyboard modes.
    process.stdout.write('\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[<u\x1b[0m\x1b[?25h\r\n');
  }
  if (process.stdin.isTTY) {
    if (isWin) {
      try { process.stdin.setRawMode(false); } catch {}
    } else {
      require('child_process').spawnSync('stty', ['sane'], { stdio: 'inherit' });
    }
  }
}

// Starts Claude Code with piped output; returns the child process.
function start(bin, args, { env, cwd } = {}) {
  const c = command(bin, args);
  return spawn(c.file, c.args, { ...c.options, env, cwd, windowsHide: true });
}

// Runs Claude Code to completion and collects its output. Never rejects.
function capture(bin, args, { env, cwd, timeoutMs = 60000, input = '' } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = start(bin, args, { env, cwd });
    } catch (err) {
      resolve({ code: 1, stdout: '', stderr: err.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      stderr += `\ntimed out after ${Math.round(timeoutMs / 1000)}s`;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      stderr += err.message;
      finish(1);
    });
    child.on('close', (code, signal) => finish(exitCodeOf(code, signal)));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// Claude Code 2.1.234 added automatic continue after a usage limit, which a single
// account relies on to pick work up again at the reset.
const MIN_VERSION = [2, 1, 234];

async function version(bin) {
  const r = await capture(bin, ['--version'], { timeoutMs: 20000 });
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(r.stdout || '');
  return m ? m.slice(1).map(Number) : null;
}

function atLeast(v, min = MIN_VERSION) {
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}

module.exports = { findClaude, command, runInteractive, spawnInteractive, stopInteractive, start, capture, version, atLeast, MIN_VERSION };
