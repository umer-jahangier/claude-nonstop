'use strict';

// SSH sessions in the Claude desktop app. In third-party mode a session on a server runs
// Claude Code there, and that Claude Code sends its requests to the gateway URL the app
// was given. The app refuses the session when that URL is loopback (127.0.0.1 would be the
// server itself), and it opens its own SSH connections with ClearAllForwardings=yes, so a
// RemoteForward in ~/.ssh/config never reaches it.
//
// So the gateway keeps its own reverse tunnel to each server you name: the server's
// 127.0.0.1:43118 leads back to this computer's 127.0.0.1:43118, where the gateway answers
// over HTTPS (server.js). The desktop app is given https://claude.nonstop:43118, which is
// not a loopback name to it, and on both machines that name points at 127.0.0.1: here
// through the hosts file setup made, on the server through a line `ssh add` puts in its
// /etc/hosts. The server also trusts the certificate authority that signed the gateway's
// certificate. Its private key was thrown away when it signed that one certificate
// (tls.js), so trusting it on the server lets it vouch for nothing else.
//
// Requests through a tunnel still need the gateway token, which only the desktop app has.

const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const config = require('./config');
const tls = require('./tls');
const hostsfile = require('./hostsfile');
const paths = require('./paths');
const { log, writeJson } = require('./files');

const MARK = '# claude-nonstop gateway tunnel';
// Names that ssh would read as an option, or that need a shell to mean anything, are refused.
const validHost = (host) => typeof host === 'string' && /^[A-Za-z0-9_.@:[\]-]{1,253}$/.test(host) && !host.startsWith('-');

// Whether the desktop app can be given the tunnel address: the gateway has its trusted
// certificate and this computer resolves the short name.
function available() {
  return Boolean(tls.serverOptions()) && hostsfile.mapped();
}

const gatewayUrl = (cfg) => `https://${hostsfile.PRIMARY}:${cfg.sshTunnelPort}`;

// Whether the desktop app should be given the tunnel address instead of 127.0.0.1.
const inUse = (cfg) => Boolean(cfg.sshTunnelPort) && cfg.sshHosts.length > 0 && available();

// The script run on the server (as root, or through sudo without a password): the hosts
// line and the certificate authority in the system trust store, for the common layouts.
function prepareScript(caPem, remove = false) {
  const hostsLine = `127.0.0.1 ${hostsfile.PRIMARY}  ${MARK}`;
  return `set -e
if [ "$(id -u)" = 0 ]; then S=""; elif sudo -n true 2>/dev/null; then S="sudo -n"; else echo "NEEDS_ROOT"; exit 3; fi
$S sed -i.bak '/${MARK}$/d' /etc/hosts 2>/dev/null || true
${remove ? '' : `echo '${hostsLine}' | $S tee -a /etc/hosts >/dev/null`}
if [ -d /etc/pki/ca-trust/source/anchors ]; then A=/etc/pki/ca-trust/source/anchors/claude-nonstop.pem; U="update-ca-trust"
elif [ -d /usr/local/share/ca-certificates ]; then A=/usr/local/share/ca-certificates/claude-nonstop.crt; U="update-ca-certificates"
elif [ -d /etc/ca-certificates/trust-source/anchors ]; then A=/etc/ca-certificates/trust-source/anchors/claude-nonstop.pem; U="trust extract-compat"
else echo "NO_TRUST_STORE"; exit 4; fi
${remove ? '$S rm -f "$A"' : `$S tee "$A" >/dev/null <<'CLAUDE_NONSTOP_CA'
${caPem.trim()}
CLAUDE_NONSTOP_CA`}
$S $U >/dev/null 2>&1 || true
echo OK
`;
}

function runOnHost(host, script) {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '--', host, 'sh -s'], { input: script, encoding: 'utf8', timeout: 60000 });
  const output = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.error) return { ok: false, why: r.error.message };
  if (/NEEDS_ROOT/.test(output)) return { ok: false, why: 'the SSH user there is not root and has no password-free sudo, so /etc/hosts and the trust store can\'t be changed' };
  if (/NO_TRUST_STORE/.test(output)) return { ok: false, why: 'no system certificate trust store was found there' };
  if (r.status !== 0 || !/\bOK\b/.test(output)) return { ok: false, why: output.split('\n').slice(-3).join(' ') || `ssh exited with ${r.status}` };
  return { ok: true };
}

function prepare(host) {
  if (!validHost(host)) return { ok: false, why: `${host} isn't a host name ssh can use` };
  const ca = tls.FILES.ca;
  if (!fs.existsSync(ca)) return { ok: false, why: 'the gateway has no HTTPS certificate yet: run `claude-nonstop setup` first' };
  return runOnHost(host, prepareScript(fs.readFileSync(ca, 'utf8')));
}

function unprepare(host) {
  if (!validHost(host)) return { ok: false, why: `${host} isn't a host name ssh can use` };
  return runOnHost(host, prepareScript('', true));
}

// ---------------------------------------------------------------- tunnels

const tunnels = new Map(); // host -> { child, state, since, retry, timer }

// The CLI runs in another process, so the tunnels' state is kept in a file for it.
const save = () => {
  try {
    writeJson(paths.SSH_STATUS, { tunnels: status() });
  } catch {}
};

function open(host, port) {
  const t = tunnels.get(host) || { retry: 0 };
  tunnels.set(host, t);
  t.state = 'connecting';
  t.since = Date.now();
  save();
  const child = spawn('ssh', [
    '-N', '-T',
    '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=15',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
    '-R', `127.0.0.1:${port}:127.0.0.1:${port}`,
    '--', host,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  t.child = child;
  let err = '';
  child.stderr.on('data', (d) => { err = `${err}${d}`.slice(-2000); });
  // ssh says nothing once the tunnel is up, so a connection still open after a few seconds is.
  const upTimer = setTimeout(() => {
    if (t.child === child) {
      t.state = 'up';
      t.retry = 0;
      save();
      log(`ssh: tunnel to ${host} is up (the desktop app's SSH sessions there reach the gateway)`);
    }
  }, 5000);
  child.on('exit', (code) => {
    clearTimeout(upTimer);
    if (t.child !== child) return;
    t.child = null;
    if (t.stopped) return;
    const why = err.trim().split('\n').pop() || `ssh exited with ${code}`;
    t.state = 'down';
    t.why = why;
    save();
    const wait = Math.min(60000, 5000 * 2 ** Math.min(t.retry++, 4));
    log(`ssh: tunnel to ${host} closed (${why}); reopening in ${Math.round(wait / 1000)}s`);
    t.timer = setTimeout(() => open(host, port), wait);
    t.timer.unref();
  });
}

function close(host) {
  const t = tunnels.get(host);
  if (!t) return;
  t.stopped = true;
  clearTimeout(t.timer);
  if (t.child) t.child.kill();
  tunnels.delete(host);
  save();
}

// Opens a tunnel to every configured host and closes the rest; run again when settings change.
function reconcile(cfg = config.load()) {
  const want = new Set(cfg.sshTunnelPort ? cfg.sshHosts.filter(validHost) : []);
  for (const host of [...tunnels.keys()]) if (!want.has(host)) close(host);
  for (const host of want) if (!tunnels.has(host)) open(host, cfg.sshTunnelPort);
}

function stopAll() {
  for (const host of [...tunnels.keys()]) close(host);
}

function status() {
  return [...tunnels.entries()].map(([host, t]) => ({ host, state: t.state, why: t.state === 'down' ? t.why : '', since: t.since }));
}

module.exports = { MARK, validHost, available, inUse, gatewayUrl, prepare, unprepare, prepareScript, reconcile, stopAll, status };
