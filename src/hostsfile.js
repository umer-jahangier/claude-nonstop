'use strict';

// Short addresses for the web UI: http://claude.nonstop and http://claude-nonstop.
// Neither is a real domain, so this computer's hosts file points both names at itself,
// the way a router answers for its own setup page. Changing that file needs administrator
// rights once: setup asks (a password prompt, or one Windows confirmation), and if that's
// declined the UI keeps working at claude-nonstop.localhost, which needs no setup at all.
// On Linux the same prompt also lets the private Node runtime serve port 80, so the
// address carries no port number there either.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const paths = require('./paths');

const NAMES = ['claude.nonstop', 'claude-nonstop'];
const PRIMARY = NAMES[0];
const BEGIN = '# claude-nonstop: short names for its local web page';
const END = '# end claude-nonstop';

function hostsPath() {
  if (process.env.CLAUDE_NONSTOP_HOSTS_FILE) return process.env.CLAUDE_NONSTOP_HOSTS_FILE;
  if (process.platform === 'win32') return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
  return '/etc/hosts';
}

function read() {
  try {
    return fs.readFileSync(hostsPath(), 'utf8');
  } catch {
    return '';
  }
}

// True when every short name points at this computer, whoever added the lines.
function mapped(text = read()) {
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const [address, ...names] = line.replace(/#.*/, '').trim().split(/\s+/);
    if (address === '127.0.0.1') for (const name of names) seen.add(name.toLowerCase());
  }
  return NAMES.every((name) => seen.has(name));
}

function withoutBlock(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const kept = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === BEGIN) inside = true;
    else if (inside && line.trim() === END) inside = false;
    else if (!inside) kept.push(line);
  }
  return kept.join(eol);
}

function withBlock(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const base = withoutBlock(text).replace(/\s+$/, '');
  return `${base}${base ? eol + eol : ''}${BEGIN}${eol}127.0.0.1 ${NAMES.join(' ')}${eol}${END}${eol}`;
}

// The private Node runtime the installers put in ~/.claude-nonstop/runtime. Only that
// copy is given the port-80 right on Linux, never a system-wide node.
function privateNode() {
  const runtime = path.join(paths.HOME, 'runtime');
  return process.execPath.startsWith(runtime + path.sep) ? process.execPath : null;
}

const sh = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const ok = (r) => r && !r.error && r.status === 0;

// Copies `staged` over the hosts file with administrator rights: directly when we already
// have them, otherwise through the system's own prompt.
function writeElevated(staged, { linuxPort80 = false } = {}) {
  const target = hostsPath();
  try {
    fs.copyFileSync(staged, target);
    return true;
  } catch {}
  if (process.platform === 'win32') {
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const inner = `[IO.File]::WriteAllText(${q(target)}, [IO.File]::ReadAllText(${q(staged)})); ipconfig /flushdns | Out-Null`;
    const outer = `$p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${Buffer.from(inner, 'utf16le').toString('base64')}'; exit $p.ExitCode`;
    return ok(spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(outer, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true }));
  }
  let script = `cp ${sh(staged)} ${sh(target)}`;
  if (process.platform === 'darwin') {
    script += ' && ((dscacheutil -flushcache; killall -HUP mDNSResponder) >/dev/null 2>&1 || true)';
    const why = 'claude-nonstop wants to open its web page at the short address claude.nonstop.';
    const apple = `do shell script "${script.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with prompt "${why}" with administrator privileges`;
    if (ok(spawnSync('osascript', ['-e', apple], { stdio: 'ignore' }))) return true;
  } else if (linuxPort80 && privateNode()) {
    script += ` && (setcap cap_net_bind_service=+ep ${sh(privateNode())} >/dev/null 2>&1 || true)`;
  }
  if (ok(spawnSync('sudo', ['-n', 'sh', '-c', script], { stdio: 'ignore' }))) return true;
  if (process.stdin.isTTY) {
    process.stdout.write('claude-nonstop: your password lets it use the short address claude.nonstop (press Ctrl-C to skip).\n');
    if (ok(spawnSync('sudo', ['sh', '-c', script], { stdio: 'inherit' }))) return true;
  }
  if (process.platform === 'linux' && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
    if (ok(spawnSync('pkexec', ['sh', '-c', script], { stdio: 'ignore' }))) return true;
  }
  return false;
}

function stage(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nonstop-'));
  const file = path.join(dir, 'hosts');
  fs.writeFileSync(file, text);
  return { file, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// Adds the names. Resolves to true when they point here afterwards.
function install() {
  if (mapped()) return true;
  if (process.env.CLAUDE_NONSTOP_NO_HOSTS === '1') return false;
  const staged = stage(withBlock(read()));
  try {
    writeElevated(staged.file, { linuxPort80: true });
  } finally {
    staged.done();
  }
  return mapped();
}

// Takes our lines back out, leaving anything else in the file alone.
function uninstall() {
  const text = read();
  if (!text.includes(BEGIN)) return true;
  const staged = stage(withoutBlock(text).replace(/\s+$/, '') + (text.includes('\r\n') ? '\r\n' : '\n'));
  try {
    writeElevated(staged.file);
  } finally {
    staged.done();
  }
  return !read().includes(BEGIN);
}

module.exports = { NAMES, PRIMARY, hostsPath, mapped, withBlock, withoutBlock, install, uninstall };
