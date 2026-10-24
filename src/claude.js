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

module.exports = { findClaude, command, runInteractive, start, capture };
