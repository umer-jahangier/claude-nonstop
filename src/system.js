'use strict';

// Everything claude-nonstop changes outside your home folder, gathered into one admin
// prompt so an install asks only once:
//   - the hosts-file lines for claude.nonstop and claude-nonstop
//   - on Linux, the right for its private Node runtime to serve ports 80 and 443
//   - on Windows and Linux, the Claude desktop app's managed settings
// Anything already in place is skipped, so running setup again asks nothing.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const paths = require('./paths');
const hostsfile = require('./hostsfile');
const desktop = require('./desktop');
const elevate = require('./elevate');

const WHY = 'claude-nonstop wants to open its web page at the short address claude.nonstop and set up the Claude desktop app.';

function writable(file) {
  try {
    fs.accessSync(file, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function stage(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nonstop-'));
  const file = path.join(dir, 'staged');
  fs.writeFileSync(file, text);
  return { file, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// Linux keeps ports below 1024 for root; this lets only claude-nonstop's own Node use them.
function portRightNeeded() {
  if (process.platform !== 'linux') return null;
  const runtime = path.join(paths.HOME, 'runtime');
  if (!process.execPath.startsWith(runtime + path.sep)) return null;
  const r = spawnSync('getcap', [process.execPath], { encoding: 'utf8' });
  return r.stdout && r.stdout.includes('cap_net_bind_service') ? null : process.execPath;
}

function hostsStep(text, sh, ps, cleanups) {
  const target = hostsfile.hostsPath();
  if (writable(target)) {
    fs.writeFileSync(target, text);
    return;
  }
  const staged = stage(text);
  cleanups.push(staged.done);
  sh.push(`cp ${elevate.shQuote(staged.file)} ${elevate.shQuote(target)}`);
  if (process.platform === 'darwin') sh.push('(dscacheutil -flushcache; killall -HUP mDNSResponder) >/dev/null 2>&1 || true');
  ps.push(`[IO.File]::WriteAllText(${elevate.psQuote(target)}, [IO.File]::ReadAllText(${elevate.psQuote(staged.file)}))`, 'ipconfig /flushdns | Out-Null');
}

function managedStep(change, sh, ps, cleanups) {
  if (!change) return;
  if (change.ps) ps.push(change.ps);
  if (change.sh) {
    const staged = change.file ? stage(change.file.text) : null;
    if (staged) cleanups.push(staged.done);
    sh.push(change.sh(staged && staged.file));
  }
}

function runAll(sh, ps, cleanups) {
  const needed = process.platform === 'win32' ? ps.length > 0 : sh.length > 0;
  try {
    return needed ? elevate.run({ sh: sh.join('\n'), ps: ps.join('; '), why: WHY }) : true;
  } finally {
    cleanups.forEach((done) => done());
  }
}

// Puts everything in place. `desktopSettings` (from desktop.settings) also sets up the
// desktop app; leave it out to skip that.
function apply({ hosts = true, desktopSettings = null } = {}) {
  const sh = [];
  const ps = [];
  const cleanups = [];
  const hostsText = hosts && process.env.CLAUDE_NONSTOP_NO_HOSTS !== '1' ? hostsfile.desired(true) : null;
  if (hostsText !== null) hostsStep(hostsText, sh, ps, cleanups);
  const node = portRightNeeded();
  if (node) sh.push(`setcap cap_net_bind_service=+ep ${elevate.shQuote(node)} || true`);
  if (desktopSettings) managedStep(desktop.managedChange(desktopSettings), sh, ps, cleanups);
  const ran = runAll(sh, ps, cleanups);
  return { ran, hosts: hostsfile.mapped(), desktop: Boolean(desktopSettings) && desktop.applied(desktopSettings, { fresh: true }) };
}

// Takes our hosts-file lines and the desktop app's managed settings back out.
function remove() {
  const sh = [];
  const ps = [];
  const cleanups = [];
  const hostsText = hostsfile.desired(false);
  if (hostsText !== null) hostsStep(hostsText, sh, ps, cleanups);
  managedStep(desktop.managedRemoval(), sh, ps, cleanups);
  const ran = runAll(sh, ps, cleanups);
  return { ran, hosts: !hostsfile.read().includes(hostsfile.BEGIN) };
}

module.exports = { apply, remove };
