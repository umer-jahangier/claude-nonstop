'use strict';

// Local Anthropic-compatible API-key gateway.
// Normalize incoming Desktop/Claude Code requests into ordinary API requests.
// This changes request headers only; the upstream provider determines billing.

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { classifyResponse } = require('./classify');
const keys = require('./keys');
const relay = require('./relay');
const events = require('./events');
const state = require('./state');
const { log } = require('./files');

const MAX_BODY = 64 * 1024 * 1024;
const MAX_ERROR_BODY = 4 * 1024 * 1024;
const KEYS_HEADER = 'x-claude-nonstop-keys';
const DROP_REQUEST = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
  'accept-encoding', 'authorization', 'x-api-key', KEYS_HEADER,
  'user-agent', 'x-app',
]);
const DROP_RESPONSE = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'content-length',
]);
const agents = {
  'http:': new http.Agent({ keepAlive: true }),
  'https:': new https.Agent({ keepAlive: true }),
};

function keysFor(req, cfg, all) {
  const order = relay.keyOrder(cfg, all);
  const named = req.headers[KEYS_HEADER];
  if (!named) return order;
  const ids = new Set(String(named).split(',').map((s) => s.trim()).filter(Boolean));
  return order.filter((k) => ids.has(k.id));
}

const isFree = (req) =>
  req.method === 'GET' && /^\/v1\/models(\/|\?|$)/.test(req.url);

function sameToken(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function clientToken(req) {
  const auth = String(req.headers.authorization || '');
  return req.headers['x-api-key'] ||
    (/^bearer /i.test(auth) ? auth.slice(7).trim() : '');
}

function sendError(res, status, type, message) {
  const body = JSON.stringify({ type: 'error', error: { type, message } });
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(stream, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    stream.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        reject(new Error('too large'));
        stream.destroy();
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    stream.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    stream.on('close', () => {
      if (settled) return;
      settled = true;
      reject(new Error('request stream closed early'));
    });
  });
}

function upstreamHeaders(headers, key, length) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!DROP_REQUEST.has(lower)) out[lower] = value;
  }

  // Claude Code and OAuth betas identify a different client/authorization flow.
  // Keep unrelated API feature betas, such as fine-grained tool streaming.
  if (out['anthropic-beta']) {
    const betas = String(out['anthropic-beta'])
      .split(',')
      .map((beta) => beta.trim())
      .filter((beta) => beta &&
        !/^claude-code(?:-|$)/i.test(beta) &&
        !/^oauth-/i.test(beta));
    const distinct = [...new Set(betas)];
    if (distinct.length) out['anthropic-beta'] = distinct.join(',');
    else delete out['anthropic-beta'];
  }

  // Use ordinary API-key authentication; do not claim Desktop or CLI identity.
  // Node sends its own generic user-agent behavior unless explicitly set.
  out['x-api-key'] = key;
  out['accept-encoding'] = 'identity';
  if (length !== undefined && length !== null) {
    out['content-length'] = String(length);
  }
  return out;
}

function responseHeaders(headers, length) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!DROP_RESPONSE.has(name.toLowerCase())) out[name] = value;
  }
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
    const lib = target.protocol === 'https:' ? https :
      target.protocol === 'http:' ? http : null;
    if (!lib) {
      resolve({ error: new Error(`Unsupported protocol: ${target.protocol}`) });
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const upstream = lib.request(target, {
      method: req.method,
      headers: upstreamHeaders(req.headers, key, body.length),
      agent: agents[target.protocol],
    }, (res) => finish({ res, upstream }));
    upstream.on('error', (error) => finish({ error }));
    upstream.end(body.length ? body : undefined);
  });
}

async function handle(req, res, ctx) {
  const { cfg, vault } = ctx.current();
  if (!sameToken(clientToken(req), vault.gatewayToken)) {
    sendError(res, 401, 'authentication_error',
      'claude-nonstop gateway: missing or invalid gateway token.');
    return;
  }

  let body;
  try {
    body = await readBody(req, MAX_BODY);
  } catch (error) {
    if (res.destroyed) return;
    sendError(res, error.message === 'too large' ? 413 : 400,
      error.message === 'too large' ? 'request_too_large' : 'invalid_request_error',
      error.message === 'too large'
        ? 'claude-nonstop gateway: request body too large.'
        : 'claude-nonstop gateway: could not read request body.');
    return;
  }

  // Keep local session tracking unchanged; upstream headers are plain API.
  const desktop = !req.headers[KEYS_HEADER];
  const free = isFree(req);
  const eligible = keysFor(req, cfg, vault.keys);
  let attempted = 0;
  let cooled = 0;
  let lastError = '';

  for (const entry of eligible) {
    // IMPORTANT: plain API cooldown classification, not Claude Code scope.
    if (!free && state.isCoolingDown(entry.id, cfg.cooldownMinutes, {
      claudeCode: false,
    })) {
      cooled++;
      continue;
    }
    attempted++;
    const { res: upRes, upstream, error } = await forward(cfg, req, body, entry.key);
    if (error) {
      log(`gateway: upstream connection failed: ${error.message}`);
      if (!res.destroyed && !res.headersSent) {
        sendError(res, 502, 'api_error',
          `claude-nonstop gateway could not reach ${cfg.upstream}: ${error.message}`);
      }
      return;
    }

    if (upRes.statusCode >= 400) {
      const errBody = await readBody(upRes, MAX_ERROR_BODY)
        .catch(() => Buffer.alloc(0));
      const text = errBody.toString('utf8');
      if (classifyResponse(upRes.statusCode, text) === 'used-up') {
        const detail = keys.errorMessage(text);
        lastError = detail;
        // No Claude Code billing scope on an ordinary API request.
        state.recordKey(entry.id, {
          verdict: 'used-up',
          status: upRes.statusCode,
          detail,
        });
        log(`gateway: API key "${entry.label}" unavailable (HTTP ${upRes.statusCode}); trying next key`);
        events.emit('switch', {
          keyId: entry.id,
          label: entry.label,
          status: upRes.statusCode,
          detail,
        });
        continue;
      }
      events.emit('request', {
        keyId: entry.id,
        label: entry.label,
        status: upRes.statusCode,
        path: req.url,
      });
      if (res.destroyed || res.headersSent) return;
      res.writeHead(upRes.statusCode, responseHeaders(upRes.headers, errBody.length));
      res.end(errBody);
      return;
    }

    if (!free) ctx.noteKeyInUse(entry, { desktop });
    events.emit('request', {
      keyId: entry.id,
      label: entry.label,
      status: upRes.statusCode,
      path: req.url,
    });
    log(`gateway: API request succeeded using key "${entry.label}" (HTTP ${upRes.statusCode})`);
    if (res.destroyed || res.headersSent) {
      upstream.destroy();
      return;
    }
    res.writeHead(upRes.statusCode, responseHeaders(upRes.headers));
    upRes.pipe(res);
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    return;
  }

  events.emit('exhausted', {});
  const reason = !eligible.length
    ? 'No API keys matched this session.'
    : !attempted
      ? `All ${cooled} eligible API keys are cooling down.`
      : 'All eligible API keys are unavailable for this request.';
  log(`gateway: plain API request exhausted eligible keys; attempted=${attempted}, coolingDown=${cooled}`);
  if (!res.destroyed && !res.headersSent) {
    sendError(res, 402, 'billing_error',
      `claude-nonstop: ${reason} Check standard API credit and key status in the web UI.` +
      (lastError ? ` Last upstream error: ${lastError}` : ''));
  }
}

module.exports = { handle, sameToken, sendError, readBody, KEYS_HEADER };