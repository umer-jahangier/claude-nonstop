'use strict';

// Makes plain `claude` go through claude-nonstop in your terminals.
//   macOS / Linux: a small marked block in your zsh, bash and fish startup files.
//   Windows: a claude.cmd shim in a folder placed first on your user PATH, which works
//   in cmd, PowerShell and Git Bash without touching PowerShell's script policy.
// `claude-nonstop shell uninstall` removes all of it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('./paths');
const winpath = require('./winpath');

const START = '# >>> claude-nonstop >>>';
const END = '# <<< claude-nonstop <<<';
const SHIMS = path.join(paths.HOME, 'shims');

function posixBlock(binDir) {
  const lines = [START, '# Plain `claude` tries your subscription accounts first, then your API keys.'];
  if (binDir) lines.push(`case ":$PATH:" in *":${binDir}:"*) ;; *) export PATH="${binDir}:$PATH" ;; esac`);
  // The unalias runs on its own line so an existing `alias claude=...` can't capture the
  // function definition that follows.
  lines.push('if command -v claude-nonstop >/dev/null 2>&1; then unalias claude 2>/dev/null; fi');
  lines.push('if command -v claude-nonstop >/dev/null 2>&1; then function claude { claude-nonstop run "$@"; }; fi');
  lines.push(END);
  return lines.join('\n');
}

function fishBlock(binDir) {
  const lines = [START];
  if (binDir) lines.push(`contains -- "${binDir}" $PATH; or set -gx PATH "${binDir}" $PATH`);
  lines.push('if type -q claude-nonstop', '    function claude', '        claude-nonstop run $argv', '    end', 'end', END);
  return lines.join('\n');
}

function stripBlock(text) {
  const pattern = new RegExp(`\\n?${START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`, 'g');
  return text.replace(pattern, '\n').replace(/\n{3,}$/, '\n\n');
}

function posixTargets() {
  const home = os.homedir();
  const shellName = path.basename(process.env.SHELL || '');
  const targets = [];
  const zshrc = path.join(process.env.ZDOTDIR || home, '.zshrc');
  if (fs.existsSync(zshrc) || shellName === 'zsh') targets.push({ file: zshrc, kind: 'posix' });
  const bashrc = path.join(home, '.bashrc');
  if (fs.existsSync(bashrc) || shellName === 'bash') targets.push({ file: bashrc, kind: 'posix' });
  // macOS opens bash as a login shell, which reads .bash_profile instead of .bashrc.
  const bashProfile = path.join(home, '.bash_profile');
  if (process.platform === 'darwin' && fs.existsSync(bashProfile)) targets.push({ file: bashProfile, kind: 'posix' });
  const fishDir = path.join(home, '.config', 'fish');
  if (fs.existsSync(fishDir) || shellName === 'fish') targets.push({ file: path.join(fishDir, 'conf.d', 'claude-nonstop.fish'), kind: 'fish' });
  return targets;
}

// Runs on the same Node.js as claude-nonstop itself (its own private copy when installed
// by the installer), so the shortcut keeps working whatever Node the user has, if any.
function windowsShim() {
  return `@echo off\r\n"${process.execPath}" "${paths.APP_SCRIPT}" run %*\r\n`;
}

function install({ binDir } = {}) {
  if (process.platform === 'win32') {
    fs.mkdirSync(SHIMS, { recursive: true });
    fs.writeFileSync(path.join(SHIMS, 'claude.cmd'), windowsShim());
    winpath.addToUserPath(SHIMS);
    return [`${path.join(SHIMS, 'claude.cmd')} (first on your user PATH)`];
  }
  const changed = [];
  for (const target of posixTargets()) {
    const block = target.kind === 'fish' ? fishBlock(binDir) : posixBlock(binDir);
    const before = fs.existsSync(target.file) ? fs.readFileSync(target.file, 'utf8') : '';
    const base = stripBlock(before).replace(/\s*$/, '');
    const after = target.kind === 'fish' ? `${block}\n` : `${base ? `${base}\n\n` : ''}${block}\n`;
    if (after !== before) {
      fs.mkdirSync(path.dirname(target.file), { recursive: true });
      fs.writeFileSync(target.file, after);
    }
    changed.push(target.file);
  }
  return changed;
}

function uninstall() {
  if (process.platform === 'win32') {
    fs.rmSync(SHIMS, { recursive: true, force: true });
    try {
      winpath.removeFromUserPath(SHIMS);
    } catch {}
    return [SHIMS];
  }
  const changed = [];
  for (const target of posixTargets()) {
    if (!fs.existsSync(target.file)) continue;
    if (target.kind === 'fish') {
      fs.rmSync(target.file, { force: true });
      changed.push(target.file);
      continue;
    }
    const before = fs.readFileSync(target.file, 'utf8');
    const after = stripBlock(before);
    if (after !== before) {
      fs.writeFileSync(target.file, after);
      changed.push(target.file);
    }
  }
  return changed;
}

function status() {
  if (process.platform === 'win32') return { installed: fs.existsSync(path.join(SHIMS, 'claude.cmd')) };
  return {
    installed: posixTargets().some((t) => fs.existsSync(t.file) && fs.readFileSync(t.file, 'utf8').includes(START)),
  };
}

module.exports = { install, uninstall, status, SHIMS, posixBlock, stripBlock };
