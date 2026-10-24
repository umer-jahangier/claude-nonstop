'use strict';

// Runs a short script with administrator rights through the system's own prompt: the
// macOS password dialog, one Windows confirmation, or sudo / pkexec on Linux. claude-nonstop
// gathers everything it changes outside your home folder into a single call of this.

const { spawnSync } = require('child_process');

const ok = (r) => Boolean(r && !r.error && r.status === 0);
const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

function run({ sh, ps, why }) {
  if (process.platform === 'win32') {
    if (!ps) return true;
    const inner = Buffer.from(`$ErrorActionPreference = 'Stop'; ${ps}`, 'utf16le').toString('base64');
    // Start-Process shows the UAC prompt; declining it throws, so the exit code says whether it ran.
    const outer = `try { $p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${inner}'; exit $p.ExitCode } catch { exit 1 }`;
    return ok(spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(outer, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true }));
  }
  if (!sh) return true;
  const script = `set -e\n${sh}`;
  if (process.platform === 'darwin') {
    const escaped = script.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const apple = `do shell script "${escaped}" with prompt "${why.replace(/"/g, "'")}" with administrator privileges`;
    if (ok(spawnSync('osascript', ['-e', apple], { stdio: 'ignore' }))) return true;
  }
  if (ok(spawnSync('sudo', ['-n', 'sh', '-c', script], { stdio: 'ignore' }))) return true;
  if (process.stdin.isTTY) {
    process.stdout.write(`claude-nonstop: ${why} Your password is needed once (press Ctrl-C to skip).\n`);
    if (ok(spawnSync('sudo', ['sh', '-c', script], { stdio: 'inherit' }))) return true;
  }
  if (process.platform === 'linux' && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
    if (ok(spawnSync('pkexec', ['sh', '-c', script], { stdio: 'ignore' }))) return true;
  }
  return false;
}

module.exports = { run, shQuote, psQuote };
