'use strict';

// The local server: the gateway (/v1/*) and the web UI, on this computer only.
//   127.0.0.1:43117  always; the CLI and the desktop app use this address
//   [::1]:43117      too, since macOS resolves *.localhost names to IPv6 first
//   port 80          when the system allows it, so the web UI opens with no port number:
//                    http://claude.nonstop once setup has added it to the hosts file,
//                    http://claude-nonstop.localhost otherwise
// Every connection that doesn't come from this computer is closed before it's read.

const fs = require('fs');
const http = require('http');
const paths = require('./paths');
const config = require('./config');
const vault = require('./vault');
const state = require('./state');
const gateway = require('./gateway');
const ui = require('./ui');
const events = require('./events');
const hostsfile = require('./hostsfile');
const { FRIENDLY_HOST, allowShortNames, hostAllowed, isLoopback } = require('./hosts');
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
  let keyInUse = null;
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
    noteKeyInUse(entry) {
      if (keyInUse === entry.id) return;
      keyInUse = entry.id;
      state.setCurrent(`API key: ${entry.label}`);
      log(`gateway: using key "${entry.label}"`);
    },
  };
}

function createServer(ctx) {
  const server = http.createServer((req, res) => {
    const fail = (err) => {
      log(`server error: ${err && err.stack ? err.stack : err}`);
      if (!res.headersSent) gateway.sendError(res, 500, 'api_error', `claude-nonstop: ${err.message}`);
      else res.destroy();
    };
    // Only answer under our own names: this blocks DNS-rebinding tricks from web pages.
    req.allowedPorts = ctx.ports || new Set([server.address().port]);
    if (!hostAllowed(req.headers.host, req.allowedPorts)) {
      gateway.sendError(res, 403, 'permission_error', 'claude-nonstop only answers on this computer');
      return;
    }
    const url = req.url || '/';
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
  });
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
async function listenOnPort80(ctx) {
  if (process.env.CLAUDE_NONSTOP_NO_PORT80 === '1') return null;
  const attempts = [{ port: 80, host: '127.0.0.1' }];
  if (process.platform === 'darwin') attempts.push({ port: 80, host: '::', ipv6Only: false });
  for (const options of attempts) {
    const server = createServer(ctx);
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

  const port80 = await listenOnPort80(ctx);
  if (port80) {
    servers.push(port80);
    ctx.ports.add(80);
  }
  const startedAt = new Date().toISOString();
  let uiUrl = '';
  const publish = () => {
    const short = hostsfile.mapped();
    allowShortNames(short);
    const next = `http://${short ? hostsfile.PRIMARY : FRIENDLY_HOST}${port80 ? '' : `:${mainPort}`}`;
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
