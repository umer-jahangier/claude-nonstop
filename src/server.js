'use strict';

// The local server: the gateway (/v1/*) and the web UI, on this computer only.
//   127.0.0.1:43117  always; the CLI and the desktop app use this address
//   [::1]:43117      too, since macOS resolves *.localhost names to IPv6 first
//   port 80          when the system allows it, so the web UI opens with no port number:
//                    http://claude.nonstop once setup has added it to the hosts file,
//                    http://claude-nonstop.localhost otherwise
//   port 443         HTTPS with the certificate setup made and this computer trusts
//                    (tls.js), so https://claude.nonstop shows no "Not secure" warning;
//                    plain-http visits to the short names are sent there
// Every connection that doesn't come from this computer is closed before it's read.

const fs = require('fs');
const http = require('http');
const https = require('https');
const paths = require('./paths');
const config = require('./config');
const vault = require('./vault');
const state = require('./state');
const gateway = require('./gateway');
const ui = require('./ui');
const events = require('./events');
const checks = require('./checks');
const hostsfile = require('./hostsfile');
const tls = require('./tls');
const { FRIENDLY_HOST, allowShortNames, hostAllowed, isShortName, isLoopback } = require('./hosts');
const { ensureHome, writeJson, readJson, log } = require('./files');
const pkg = require('../package.json');

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// Settings and the vault are re-read whenever their files change, so keys added from the
// CLI or another process are picked up without a restart.
function createContext() {
  const cache = { vaultAt: -1, cfgAt: -1, vault: null, cfg: null };
  const keyInUse = { desktop: null, sessions: null };
  let desktopNotedAt = 0;
  return {
    ports: null,
    current() {
      if (!cache.vault || mtime(paths.VAULT) !== cache.vaultAt) {
        cache.vault = vault.loadWithTokens();
        cache.vaultAt = mtime(paths.VAULT);
      }
      if (!cache.cfg || mtime(paths.CONFIG) !== cache.cfgAt) {
        cache.cfg = config.load();
        cache.cfgAt = mtime(paths.CONFIG);
      }
      return { cfg: cache.cfg, vault: cache.vault };
    },
    invalidate() {
      cache.vault = null;
      cache.cfg = null;
    },
    // The desktop app and terminal sessions are recorded apart, so the desktop app's key
    // never shows as the line your sessions are on.
    noteKeyInUse(entry, { desktop = false } = {}) {
      const who = desktop ? 'desktop' : 'sessions';
      const changed = keyInUse[who] !== entry.id;
      // The desktop app's "last used" also says it's on API keys right now (see
      // desktopadvice.js), so it's refreshed at most once a minute while requests come in.
      if (desktop && (changed || Date.now() - desktopNotedAt > 60000)) {
        state.setDesktop(entry.label);
        desktopNotedAt = Date.now();
      }
      if (!changed) return;
      keyInUse[who] = entry.id;
      if (!desktop) state.setCurrent(`API key: ${entry.label}`);
      log(`gateway: ${desktop ? 'the desktop app is' : 'sessions are'} using key "${entry.label}"`);
    },
  };
}

function createServer(ctx, tlsOptions = null) {
  const onRequest = (req, res) => {
    const fail = (err) => {
      log(`server error: ${err && err.stack ? err.stack : err}`);
      if (!res.headersSent) gateway.sendError(res, 500, 'api_error', `claude-nonstop: ${err.message}`);
      else res.destroy();
    };
    // Only answer under our own names: this blocks DNS-rebinding tricks from web pages.
    const secure = Boolean(req.socket.encrypted);
    req.secure = secure;
    req.allowedPorts = ctx.ports || new Set([server.address().port]);
    if (!hostAllowed(req.headers.host, req.allowedPorts, secure ? 443 : 80)) {
      gateway.sendError(res, 403, 'permission_error', 'claude-nonstop only answers on this computer');
      return;
    }
    const url = req.url || '/';
    if (!secure && ctx.tlsPort && isShortName(req.headers.host) && url !== '/health' && !url.startsWith('/v1/')) {
      const host = String(req.headers.host).toLowerCase().replace(/:\d+$/, '');
      res.writeHead(308, { location: `https://${host}${ctx.tlsPort === 443 ? '' : `:${ctx.tlsPort}`}${url}` });
      res.end();
      return;
    }
    if (url === '/health') {
      const body = JSON.stringify({ name: 'claude-nonstop', version: pkg.version, pid: process.pid });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    const handler = url.startsWith('/v1/') ? gateway.handle : ui.handle;
    Promise.resolve()
      .then(() => handler(req, res, ctx))
      .catch(fail);
  };
  const server = tlsOptions ? https.createServer(tlsOptions, onRequest) : http.createServer(onRequest);
  // For HTTPS too this fires on the raw connection, before any TLS handshake.
  server.on('connection', (socket) => {
    if (!isLoopback(socket.remoteAddress)) socket.destroy();
  });
  return server;
}

// Resolves with null once listening, or with the error if the address can't be used.
function listen(server, options) {
  return new Promise((resolve) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      resolve(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(null);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options);
  });
}

// Port 80 lets the web UI open without a port number. Windows allows it outright; macOS
// allows it on the all-interfaces address (the loopback check keeps it private); Linux
// allows it once setup has given the private Node runtime that right, and otherwise the
// address carries the port instead.
async function listenLow(ctx, port, tlsOptions = null) {
  if (process.env.CLAUDE_NONSTOP_NO_PORT80 === '1') return null;
  const attempts = [{ port, host: '127.0.0.1' }];
  if (process.platform === 'darwin') attempts.push({ port, host: '::', ipv6Only: false });
  for (const options of attempts) {
    const server = createServer(ctx, tlsOptions);
    if (!(await listen(server, options))) return server;
  }
  return null;
}

async function serve({ port } = {}) {
  ensureHome();
  const ctx = createContext();
  const mainPort = port || ctx.current().cfg.port;
  ctx.ports = new Set([mainPort]);
  const servers = [];

  const main = createServer(ctx);
  const failed = await listen(main, { port: mainPort, host: '127.0.0.1' });
  if (failed) throw failed;
  servers.push(main);

  const ipv6 = createServer(ctx);
  if (!(await listen(ipv6, { port: mainPort, host: '::1', ipv6Only: true }))) servers.push(ipv6);

  const port80 = await listenLow(ctx, 80);
  if (port80) {
    servers.push(port80);
    ctx.ports.add(80);
  }
  const tlsOptions = tls.serverOptions();
  const port443 = tlsOptions ? await listenLow(ctx, 443, tlsOptions) : null;
  if (port443) {
    servers.push(port443);
    ctx.ports.add(443);
  }
  const startedAt = new Date().toISOString();
  let uiUrl = '';
  const publish = () => {
    const short = hostsfile.mapped();
    allowShortNames(short);
    ctx.tlsPort = short && port443 ? 443 : null;
    const next = ctx.tlsPort
      ? `https://${hostsfile.PRIMARY}`
      : `http://${short ? hostsfile.PRIMARY : FRIENDLY_HOST}${port80 ? '' : `:${mainPort}`}`;
    if (next === uiUrl) return;
    uiUrl = next;
    writeJson(paths.SERVER, { pid: process.pid, port: mainPort, uiUrl, version: pkg.version, startedAt });
    log(`claude-nonstop ${pkg.version}: gateway on http://127.0.0.1:${mainPort}, web UI at ${uiUrl}`);
  };
  publish();
  // Setup may add the short names while the server runs; pick them up when it does.
  fs.watchFile(hostsfile.hostsPath(), { interval: 5000 }, publish);

  // Sessions are started by the CLI in other processes; they record the line they chose in
  // state.json, which is watched here so the web UI hears about every new session live.
  let lastCurrent = state.load().current;
  fs.watchFile(paths.STATE, { interval: 1500 }, () => {
    const now = state.load().current;
    if (now && now !== lastCurrent) events.emit('current', { label: now });
    lastCurrent = now;
  });

  // Find out where every account and key stands. The gateway starts at login, so give the
  // network a few seconds to come up first.
  if (process.env.CLAUDE_NONSTOP_NO_STARTUP_CHECK !== '1') {
    setTimeout(() => checks.all(), 5000).unref();
    // Says when to switch the desktop app between your Claude.ai account and API keys.
    setTimeout(() => require('./desktopadvice').start(), 6000).unref();
    // How much of each account's plan is used, refreshed every few minutes.
    setTimeout(() => require('./usage').start(), 7000).unref();
  }

  const stop = (code = 0) => {
    const info = readJson(paths.SERVER, null);
    if (info && info.pid === process.pid) fs.rmSync(paths.SERVER, { force: true });
    for (const server of servers) server.close();
    process.exit(code);
  };
  process.on('SIGTERM', () => stop(0));
  process.on('SIGINT', () => stop(0));

  require('./update').schedule(() => {
    log('restarting on the new version');
    const info = readJson(paths.SERVER, null);
    if (info && info.pid === process.pid) fs.rmSync(paths.SERVER, { force: true });
    for (const server of servers) server.close();
    // Under launchd or systemd, a non-zero exit makes them start the new version.
    if (process.env.CLAUDE_NONSTOP_SUPERVISED === '1') process.exit(75);
    // Otherwise (the Windows startup entry, desktop autostart) start it ourselves.
    setTimeout(() => {
      require('./service').startDetached();
      process.exit(0);
    }, 500);
  });

  return { servers, uiUrl };
}

module.exports = { serve, createServer, createContext };
