'use strict';

// The local gateway: an Anthropic-compatible endpoint on 127.0.0.1 that forwards each
// request to the Claude API with your first working API key. When a key turns out to
// be used up, the same request is sent again on the next key, so a running session
// (the CLI or the Claude desktop app) keeps going without noticing.

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { classifyResponse } = require('./classify');
const keys = require('./keys');
const state = require('./state');
const { log } = require('./files');

const MAX_BODY = 64 * 1024 * 1024;
// Never forwarded upstream: hop-by-hop headers, and the client's own credentials.
const DROP_REQUEST = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'accept-encoding',
  'authorization',
  'x-api-key',
]);
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length']);
const agents = { 'http:': new http.Agent({ keepAlive: true }), 'https:': new https.Agent({ keepAlive: true }) };

function sameToken(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function clientToken(req) {
  const auth = String(req.headers.authorization || '');
  return req.headers['x-api-key'] || (/^bearer /i.test(auth) ? auth.slice(7).trim() : '');
}

function sendError(res, status, type, message) {
  const body = JSON.stringify({ type: 'error', error: { type, message } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(stream, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('too large'));
        stream.destroy();
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function upstreamHeaders(headers, key, length) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) if (!DROP_REQUEST.has(name)) out[name] = value;
  // A client that signed in another way may announce OAuth; these requests carry an API key.
  if (out['anthropic-beta']) {
    const betas = String(out['anthropic-beta'])
      .split(',')
      .map((b) => b.trim())
      .filter((b) => b && !b.startsWith('oauth-'));
    if (betas.length) out['anthropic-beta'] = betas.join(',');
    else delete out['anthropic-beta'];
  }
  out['x-api-key'] = key;
  out['accept-encoding'] = 'identity';
  if (length) out['content-length'] = String(length);
  return out;
}

function responseHeaders(headers, length) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) if (!DROP_RESPONSE.has(name)) out[name] = value;
  if (length !== undefined) out['content-length'] = String(length);
  return out;
}

function forward(cfg, req, body, key) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(`${cfg.upstream}${req.url}`);
    } catch (error) {
      resolve({ error });
      return;
    }
    const lib = target.protocol === 'https:' ? https : http;
    const upstream = lib.request(
      target,
      { method: req.method, headers: upstreamHeaders(req.headers, key, body.length), agent: agents[target.protocol] },
      (res) => resolve({ res, upstream }),
    );
    upstream.on('error', (error) => resolve({ error }));
    upstream.end(body.length ? body : undefined);
  });
}

// Handles one /v1/* request. ctx.current() returns the latest { cfg, vault }.
async function handle(req, res, ctx) {
  const { cfg, vault } = ctx.current();
  if (!sameToken(clientToken(req), vault.gatewayToken)) {
    sendError(res, 401, 'authentication_error', 'claude-nonstop gateway: missing or wrong gateway token. Copy it from `claude-nonstop desktop` or the web UI.');
    return;
  }
  let body;
  try {
    body = await readBody(req, MAX_BODY);
  } catch {
    sendError(res, 413, 'request_too_large', 'claude-nonstop gateway: request body is too large');
    return;
  }
  for (const entry of vault.keys) {
    if (state.isCoolingDown(entry.id, cfg.cooldownMinutes)) continue;
    const { res: upRes, upstream, error } = await forward(cfg, req, body, entry.key);
    if (error) {
      sendError(res, 502, 'api_error', `claude-nonstop gateway could not reach ${cfg.upstream}: ${error.message}`);
      return;
    }
    if (upRes.statusCode >= 400) {
      const errBody = await readBody(upRes, 4 * 1024 * 1024).catch(() => Buffer.alloc(0));
      const text = errBody.toString('utf8');
      if (classifyResponse(upRes.statusCode, text) === 'used-up') {
        state.recordKey(entry.id, { verdict: 'used-up', status: upRes.statusCode, detail: keys.errorMessage(text) });
        log(`gateway: key "${entry.label}" is used up (HTTP ${upRes.statusCode}), sending the request again on the next key`);
        continue;
      }
      res.writeHead(upRes.statusCode, responseHeaders(upRes.headers, errBody.length));
      res.end(errBody);
      return;
    }
    ctx.noteKeyInUse(entry);
    res.writeHead(upRes.statusCode, responseHeaders(upRes.headers));
    upRes.pipe(res);
    // If the client goes away mid-stream, stop the upstream request too.
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    return;
  }
  sendError(
    res,
    402,
    'billing_error',
    'claude-nonstop: every API key is used up or cooling down. Top one up or add another in the claude-nonstop web UI (`claude-nonstop ui`).',
  );
}

module.exports = { handle, sameToken, sendError, readBody };
