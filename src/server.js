'use strict';

// One local server on 127.0.0.1 for both the gateway (/v1/*) and the web UI.

const fs = require('fs');
const http = require('http');
const paths = require('./paths');
const config = require('./config');
const vault = require('./vault');
const state = require('./state');
const gateway = require('./gateway');
const ui = require('./ui');
const { ensureHome, writeJson, log } = require('./files');
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
    // Only answer under the names we serve: this blocks DNS-rebinding tricks from web pages.
    const { port } = server.address();
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      gateway.sendError(res, 403, 'permission_error', 'claude-nonstop only answers on 127.0.0.1');
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
  return server;
}

async function serve({ port } = {}) {
  ensureHome();
  const ctx = createContext();
  const listenPort = port || ctx.current().cfg.port;
  const server = createServer(ctx);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', resolve);
  });
  writeJson(paths.SERVER, { pid: process.pid, port: listenPort, startedAt: new Date().toISOString() });
  log(`gateway and web UI listening on http://127.0.0.1:${listenPort}`);
  const stop = () => {
    try {
      const info = JSON.parse(fs.readFileSync(paths.SERVER, 'utf8'));
      if (info.pid === process.pid) fs.rmSync(paths.SERVER, { force: true });
    } catch {}
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return server;
}

module.exports = { serve, createServer, createContext };
