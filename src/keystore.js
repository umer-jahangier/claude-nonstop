'use strict';

// The vault is encrypted with a random 32-byte key, and that key is kept by your
// operating system: the macOS Keychain, Windows DPAPI (tied to your Windows login),
// or the Linux Secret Service. Machines without one (headless Linux, CI) fall back
// to a file only your user can read.

const crypto = require('crypto');
const fs = require('fs');
const { spawnSync } = require('child_process');
const paths = require('./paths');
const { readJson, writeJson, ensureHome } = require('./files');

const SERVICE = process.env.CLAUDE_NONSTOP_KEYCHAIN_SERVICE || 'claude-nonstop';
const ACCOUNT = 'vault-master-key';

function run(cmd, args, input) {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { ok: !r.error && r.status === 0, out: (r.stdout || '').trim() };
}

// One DPAPI call through Windows PowerShell. Data travels as base64 over stdin and
// stdout, and the script itself is passed encoded, so nothing needs shell quoting.
function dpapi(op, base64) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    '$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    `$out = [Security.Cryptography.ProtectedData]::${op}($data, $null, 'CurrentUser')`,
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], base64);
}

const backends = {
  keychain: {
    label: 'macOS Keychain',
    usable: () => process.platform === 'darwin',
    read() {
      const r = run('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']);
      return r.ok ? r.out : null;
    },
    // `security -i` reads the command from stdin, so the key never shows up in the process list.
    write: (hex) => run('security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w ${hex}\n`).ok,
    remove: () => run('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]),
  },
  dpapi: {
    label: 'Windows DPAPI (tied to your Windows login)',
    usable: () => process.platform === 'win32',
    read() {
      let blob;
      try {
        blob = fs.readFileSync(paths.MASTER_DPAPI_FILE, 'utf8').trim();
      } catch {
        return null;
      }
      const r = dpapi('Unprotect', blob);
      return r.ok ? Buffer.from(r.out, 'base64').toString('utf8') : null;
    },
    write(hex) {
      const r = dpapi('Protect', Buffer.from(hex, 'utf8').toString('base64'));
      if (!r.ok || !r.out) return false;
      ensureHome();
      fs.writeFileSync(paths.MASTER_DPAPI_FILE, `${r.out}\n`, { mode: 0o600 });
      return true;
    },
    remove: () => fs.rmSync(paths.MASTER_DPAPI_FILE, { force: true }),
  },
  'secret-service': {
    label: 'Linux Secret Service (GNOME Keyring or KWallet)',
    usable: () => process.platform === 'linux',
    read() {
      const r = run('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT]);
      return r.ok ? r.out : null;
    },
    write: (hex) => run('secret-tool', ['store', '--label=claude-nonstop vault key', 'service', SERVICE, 'account', ACCOUNT], hex).ok,
    remove: () => run('secret-tool', ['clear', 'service', SERVICE, 'account', ACCOUNT]),
  },
  file: {
    label: 'a file only your user can read (no OS keychain was available)',
    usable: () => true,
    read() {
      try {
        return fs.readFileSync(paths.MASTER_KEY_FILE, 'utf8').trim();
      } catch {
        return null;
      }
    },
    write(hex) {
      ensureHome();
      fs.writeFileSync(paths.MASTER_KEY_FILE, `${hex}\n`, { mode: 0o600 });
      return true;
    },
    remove: () => fs.rmSync(paths.MASTER_KEY_FILE, { force: true }),
  },
};

let cached = null;

function masterKey() {
  if (cached) return cached;
  const info = readJson(paths.KEYSTORE, null);
  if (info && backends[info.backend]) {
    const hex = backends[info.backend].read();
    if (!/^[0-9a-f]{64}$/.test(hex || '')) {
      throw new Error(
        `can't read the vault key from ${backends[info.backend].label}. If that keychain was reset, run \`claude-nonstop reset\` and add your keys again.`,
      );
    }
    cached = Buffer.from(hex, 'hex');
    return cached;
  }
  // First run: use the strongest store that works on this machine and remember the
  // choice, so a later run never looks somewhere else and mistakes the vault for empty.
  const hex = crypto.randomBytes(32).toString('hex');
  const order = process.env.CLAUDE_NONSTOP_KEYSTORE ? [process.env.CLAUDE_NONSTOP_KEYSTORE] : ['keychain', 'dpapi', 'secret-service', 'file'];
  for (const name of order) {
    const backend = backends[name];
    if (backend && backend.usable() && backend.write(hex) && backend.read() === hex) {
      writeJson(paths.KEYSTORE, { backend: name });
      cached = Buffer.from(hex, 'hex');
      return cached;
    }
  }
  throw new Error('could not store the vault key in any credential store');
}

function describe() {
  const info = readJson(paths.KEYSTORE, null);
  return info && backends[info.backend] ? backends[info.backend].label : null;
}

function removeMasterKey() {
  const info = readJson(paths.KEYSTORE, null);
  if (info && backends[info.backend]) backends[info.backend].remove();
  fs.rmSync(paths.KEYSTORE, { force: true });
  cached = null;
}

module.exports = { masterKey, describe, removeMasterKey };
