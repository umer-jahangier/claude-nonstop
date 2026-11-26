'use strict';

// Connectors that sign in with an access token reach their server through the gateway, at
// /mcp/<connector name>. The desktop app authenticates with the gateway token (from the
// headers helper); the gateway swaps in the connector's own token, so that token never
// reaches the app. On the way back each answer is made valid for the app: its MCP host
// rejects a whole tool result whose structuredContent isn't an object (GitHub's list tools
// send an array), so such a structuredContent is dropped. The same data is in the result's
// text content, which is what the model reads anyway.

const { Readable } = require('stream');
const config = require('./config');
const { log } = require('./files');

const FORWARD = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const BACK = ['content-type', 'mcp-session-id', 'cache-control'];
const MAX_BODY = 16 * 1024 * 1024;

const plainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Fixes one JSON-RPC message (or batch) in place. Returns true when it changed anything.
function fixMessage(msg, name) {
  if (Array.isArray(msg)) return msg.map((m) => fixMessage(m, name)).some(Boolean);
  const r = msg && msg.result;
  if (r && typeof r === 'object' && 'structuredContent' in r && !plainObject(r.structuredContent)) {
    delete r.structuredContent;
    log(`connectors: ${name}: dropped a tool result's structuredContent that wasn't an object (its text content is kept)`);
    return true;
  }
  return false;
}

function fixJson(text, name) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return text;
  }
  return fixMessage(msg, name) ? JSON.stringify(msg) : text;
}

// Rewrites an event stream line by line: only `data:` lines carry messages.
function fixStream(body, res, name) {
  let rest = '';
  const decoder = new TextDecoder();
  const line = (l) => (l.startsWith('data:') ? `data: ${fixJson(l.slice(5).trimStart(), name)}` : l);
  body.on('data', (chunk) => {
    rest += decoder.decode(chunk, { stream: true });
    const parts = rest.split('\n');
    rest = parts.pop();
    if (parts.length) res.write(`${parts.map((l) => line(l.replace(/\r$/, ''))).join('\n')}\n`);
  });
  body.on('end', () => {
    rest += decoder.decode();
    if (rest) res.write(line(rest));
    res.end();
  });
  body.on('error', () => res.destroy());
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const deny = (res, status, message) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: `claude-nonstop: ${message}` } }));
};

async function handle(req, res, ctx) {
  const gateway = require('./gateway');
  const cat = require('./connectorcatalog');
  const { vault } = ctx.current();
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!gateway.sameToken(given, vault.gatewayToken)) return deny(res, 401, 'missing or invalid gateway token');
  let name;
  try {
    name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice('/mcp/'.length));
  } catch {
    return deny(res, 404, 'no such connector');
  }
  const entry = (config.load().desktopConnectors || []).find((e) => e.name.toLowerCase() === name.toLowerCase());
  if (!entry || !cat.viaGateway(entry)) return deny(res, 404, `there is no connector called ${name} that goes through the gateway`);
  const auth = await cat.upstreamAuth(entry, vault);
  if (!auth) return deny(res, 401, cat.authOf(entry) === 'oauth' ? `${entry.name} isn't connected yet: open claude-nonstop (Apps → Connectors) and click Connect next to it` : `${entry.name} has no access token: add it again with one`);

  const headers = { authorization: auth, 'user-agent': 'claude-nonstop' };
  for (const h of FORWARD) if (req.headers[h]) headers[h] = req.headers[h];
  let body;
  try {
    body = ['GET', 'HEAD', 'DELETE'].includes(req.method) ? undefined : await readBody(req);
  } catch {
    return deny(res, 413, 'request too large');
  }
  const ctl = new AbortController();
  res.on('close', () => ctl.abort());
  let up;
  try {
    up = await fetch(entry.url, { method: req.method, headers, body, signal: ctl.signal, redirect: 'manual' });
    // A sign-in that ran out early: renewed once, and the request sent again.
    if (up.status === 401 && cat.authOf(entry) === 'oauth') {
      const again = await cat.upstreamAuth(entry, vault, { force: true });
      if (again) {
        await up.text().catch(() => {});
        up = await fetch(entry.url, { method: req.method, headers: { ...headers, authorization: again }, body, signal: ctl.signal, redirect: 'manual' });
      }
    }
  } catch (err) {
    if (res.destroyed) return;
    return deny(res, 502, `couldn't reach ${new URL(entry.url).host} (${err.message})`);
  }
  if (up.status === 401 || up.status === 403) {
    // The app can't sign in on a gateway connector itself: say where to fix it, and don't
    // pass the service's sign-in hints on.
    await up.text().catch(() => {});
    log(`connectors: ${entry.name} refused its sign-in (HTTP ${up.status})`);
    return deny(res, up.status, cat.authOf(entry) === 'oauth' ? `${entry.name} refused the sign-in: open claude-nonstop (Apps → Connectors) and click Connect next to it again` : `${entry.name} refused its access token: add it again with a new one`);
  }
  const back = {};
  for (const h of BACK) if (up.headers.get(h)) back[h] = up.headers.get(h);
  const type = String(up.headers.get('content-type') || '');
  if (!up.body) {
    res.writeHead(up.status, back);
    return res.end();
  }
  if (type.includes('text/event-stream')) {
    res.writeHead(up.status, back);
    if (res.flushHeaders) res.flushHeaders();
    return fixStream(Readable.fromWeb(up.body), res, entry.name);
  }
  let text = await up.text();
  if (type.includes('json')) text = fixJson(text, entry.name);
  res.writeHead(up.status, { ...back, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

module.exports = { handle, fixMessage, fixJson };
