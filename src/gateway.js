'use strict';

// The local gateway, at http://127.0.0.1:43117/v1/*. Three kinds of request reach it:
//
//   The desktop app, in third-party mode (no session header). It walks your relay order:
//   on a subscription account, the request goes out on that account's own Claude Code
//   sign-in; when every account is out, on the first API key with credit. Either way it
//   goes out as Claude Code (the CLI user agent, x-app and the claude-code beta), never as
//   the desktop app: the app's own identity stays on this computer.
//
//   A terminal Claude Code session on API keys (x-claude-nonstop-keys names its keys). The
//   request goes out as Claude Code too, on one of the session's keys.
//
//   A request signed in to a Claude.ai account (a subscription token as its bearer). The
//   gateway spends no key on it: it goes to Anthropic exactly as sent, so Claude Code on an
//   account works through the gateway too, not only on API keys.

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { classifyResponse } = require('./classify');
const keys = require('./keys');
const relay = require('./relay');
const events = require('./events');
const state = require('./state');
const accounts = require('./accounts');
const usage = require('./usage');
const { log } = require('./files');

// What a subscription sign-in needs to be accepted: Claude Code's identity and betas.
const CLI_USER_AGENT = 'claude-cli/2.1.310 (external, cli)';
const OAUTH_BETA = 'oauth-2025-04-20';
const CLAUDE_CODE_BETA = 'claude-code-20250219';
// A subscription sign-in accepts only Claude Code's own requests: the system prompt has to
// begin with this line, or Anthropic answers 429 "Error". Claude Code's requests carry it;
// the desktop app's startup probe doesn't, so the gateway puts it first when it's missing.
const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

const MAX_BODY = 64 * 1024 * 1024;
const MAX_ERROR_BODY = 4 * 1024 * 1024;
const KEYS_HEADER = 'x-claude-nonstop-keys';
// Hop-by-hop headers and the client's own credentials never go upstream.
const DROP_REQUEST = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
  'accept-encoding', 'authorization', 'x-api-key', KEYS_HEADER,
]);
// The client's own identity, replaced by Claude Code's on every request.
const IDENTITY = new Set(['user-agent', 'x-app']);
// Only hop-by-hop headers are dropped from a request on a Claude.ai sign-in; the sign-in stays.
const DROP_PASSTHROUGH = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
  'accept-encoding', KEYS_HEADER,
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

// The model list the desktop app asks for before anything else. When no line can answer
// it (every account out, no key), the gateway answers itself so the app still connects;
// the real request then walks your order as usual.
const BUILTIN_MODELS = [
  ['claude-fable-5-1', 'Claude Fable 5.1'],
  ['claude-opus-5-5', 'Claude Opus 5.5'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5'],
];
function sendBuiltinModels(res) {
  const body = JSON.stringify({
    data: BUILTIN_MODELS.map(([id, display_name]) => ({ type: 'model', id, display_name, created_at: '2026-01-01T00:00:00Z' })),
    has_more: false,
    first_id: BUILTIN_MODELS[0][0],
    last_id: BUILTIN_MODELS[BUILTIN_MODELS.length - 1][0],
  });
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

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

// A Claude.ai subscription sign-in (Claude Code's OAuth token), not the gateway token.
const isAccountToken = (token) => /^sk-ant-oat/.test(String(token || ''));

// A terminal Claude Code session names the keys it runs on; the desktop app sends no such header.
const isSession = (req) => Boolean(req.headers[KEYS_HEADER]);

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

function splitBetas(value) {
  return [...new Set(String(value || '').split(',').map((b) => b.trim()).filter(Boolean))];
}

// Claude Code's identity on an outgoing request, whoever sent it: the CLI user agent and
// x-app. On an API key it carries the claude-code beta (the way keys are tested, keys.js);
// on a subscription sign-in it carries the OAuth beta instead, which is what Claude Code
// itself sends on an account: the claude-code beta is refused there.
function asClaudeCode(headers, { oauth = false } = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!DROP_REQUEST.has(lower) && !IDENTITY.has(lower)) out[lower] = value;
  }
  const betas = splitBetas(out['anthropic-beta']).filter((b) => !/^oauth-/i.test(b) && !/^claude-code(?:-|$)/i.test(b));
  out['anthropic-beta'] = [oauth ? OAUTH_BETA : CLAUDE_CODE_BETA, ...betas].join(',');
  out['user-agent'] = CLI_USER_AGENT;
  out['x-app'] = 'cli';
  out['accept-encoding'] = 'identity';
  return out;
}

// Headers for a request going out on an API key, as Claude Code.
function upstreamHeaders(headers, key, length) {
  const out = asClaudeCode(headers);
  out['x-api-key'] = key;
  if (length !== undefined && length !== null) out['content-length'] = String(length);
  return out;
}

// Headers for the desktop app's request going out on one of your subscription accounts: the
// account's sign-in, and Claude Code's identity and betas, which that sign-in requires.
function accountHeaders(headers, token, length) {
  const out = asClaudeCode(headers, { oauth: true });
  out.authorization = `Bearer ${token}`;
  if (length !== undefined && length !== null) out['content-length'] = String(length);
  return out;
}

// The request body as Claude Code would send it on a sign-in: the system prompt opens with
// Claude Code's identity line. Left alone when it already does, or isn't a JSON body.
function asClaudeCodeBody(body) {
  let json;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    return body;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json) || !json.messages) return body;
  const block = { type: 'text', text: CLAUDE_CODE_SYSTEM };
  const sys = json.system;
  if (typeof sys === 'string') {
    if (sys.startsWith(CLAUDE_CODE_SYSTEM)) return body;
    json.system = sys ? [block, { type: 'text', text: sys }] : CLAUDE_CODE_SYSTEM;
  } else if (Array.isArray(sys)) {
    const first = sys[0];
    if (first && typeof first.text === 'string' && first.text.startsWith(CLAUDE_CODE_SYSTEM)) return body;
    json.system = [block, ...sys];
  } else {
    json.system = CLAUDE_CODE_SYSTEM;
  }
  return Buffer.from(JSON.stringify(json));
}

// An account the desktop app can use right now: on, signed in, and not seen at its limit
// in the last while. Returns its token, or null with why not.
function accountToken(account, cfg) {
  const recent = state.load().accounts[account.id];
  if (recent && !recent.ok && accounts.isLimitReason(recent.reason) && Date.now() - recent.at < cfg.accountRecheckMinutes * 60000) {
    return { token: null, why: recent.reason };
  }
  const creds = usage.readCredentials(account);
  if (!creds) return { token: null, why: 'no sign-in token found' };
  if (creds.expiresAt && creds.expiresAt < Date.now()) return { token: null, why: 'sign-in token expired' };
  return { token: creds.token, why: '' };
}

// Headers for a request on a Claude.ai sign-in: exactly as sent, sign-in and identity included.
function passthroughHeaders(headers, length) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!DROP_PASSTHROUGH.has(lower)) out[lower] = value;
  }
  out['accept-encoding'] = 'identity';
  if (length !== undefined && length !== null) out['content-length'] = String(length);
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

function forward(cfg, req, body, headers) {
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
      headers,
      agent: agents[target.protocol],
    }, (res) => finish({ res, upstream }));
    upstream.on('error', (error) => finish({ error }));
    upstream.end(body.length ? body : undefined);
  });
}

// A request on a Claude.ai sign-in, sent to Anthropic exactly as it came and answered as is.
async function passthrough(cfg, req, res, body) {
  const { res: upRes, upstream, error } = await forward(cfg, req, body, passthroughHeaders(req.headers, body.length));
  if (error) {
    log(`gateway: upstream connection failed: ${error.message}`);
    if (!res.destroyed && !res.headersSent) {
      sendError(res, 502, 'api_error',
        `claude-nonstop gateway could not reach ${cfg.upstream}: ${error.message}`);
    }
    return;
  }
  log(`gateway: Claude.ai account request passed through (HTTP ${upRes.statusCode})`);
  if (res.destroyed || res.headersSent) {
    upstream.destroy();
    return;
  }
  res.writeHead(upRes.statusCode, responseHeaders(upRes.headers));
  upRes.pipe(res);
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });
}

async function handle(req, res, ctx) {
  const { cfg, vault } = ctx.current();
  const token = clientToken(req);
  const account = isAccountToken(token);
  if (!account && !sameToken(token, vault.gatewayToken)) {
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

  // Signed in to a Claude.ai account: no key is spent, the request goes out as it came.
  if (account) {
    await passthrough(cfg, req, res, body);
    return;
  }

  // Every request goes out as Claude Code; the desktop app's walk your accounts first.
  const desktop = !isSession(req);
  const free = isFree(req);

  // The desktop app walks your relay order: a subscription account first, when one has usage.
  if (desktop) {
    for (const group of relay.groups(cfg, vault.keys)) {
      if (group.kind !== 'account') continue;
      const { account } = group;
      const { token, why } = accountToken(account, cfg);
      if (!token) {
        log(`gateway: ${account.label}: ${why}; trying the next line`);
        continue;
      }
      const accountBody = asClaudeCodeBody(body);
      const { res: upRes, upstream, error } = await forward(cfg, req, accountBody, accountHeaders(req.headers, token, accountBody.length));
      if (error) {
        log(`gateway: upstream connection failed: ${error.message}`);
        if (!res.destroyed && !res.headersSent) {
          sendError(res, 502, 'api_error', `claude-nonstop gateway could not reach ${cfg.upstream}: ${error.message}`);
        }
        return;
      }
      if (free && upRes.statusCode >= 400) {
        // The model list isn't use: a refusal here says nothing about the account.
        upstream.destroy();
        continue;
      }
      if (upRes.statusCode === 429 || upRes.statusCode === 401 || upRes.statusCode === 403) {
        const errBody = await readBody(upRes, MAX_ERROR_BODY).catch(() => Buffer.alloc(0));
        const detail = keys.errorMessage(errBody.toString('utf8')) || `HTTP ${upRes.statusCode}`;
        // A usage limit says so (in the message, or in Anthropic's unified limit header);
        // any other 429 is a passing refusal, so the account isn't set aside for it.
        const limited = upRes.statusCode === 429 &&
          (/limit/i.test(detail) || /rejected/i.test(String(upRes.headers['anthropic-ratelimit-unified-status'] || '')));
        if (upRes.statusCode !== 429 || limited) {
          state.recordAccount(account.id, { ok: false, reason: limited ? `usage limit reached: ${detail}` : `sign-in refused: ${detail}` });
        }
        log(`gateway: ${account.label} unavailable (HTTP ${upRes.statusCode}: ${detail}); trying the next line`);
        events.emit('switch', { accountId: account.id, label: account.label, status: upRes.statusCode, detail });
        continue;
      }
      if (upRes.statusCode < 400 && !free) {
        if (state.load().accounts[account.id]?.ok === false) state.recordAccount(account.id, { ok: true, reason: '' });
        ctx.noteAccountInUse(account, { desktop: true });
      }
      events.emit('request', { accountId: account.id, label: account.label, status: upRes.statusCode, path: req.url });
      log(`gateway: desktop request went out on ${account.label} (HTTP ${upRes.statusCode})`);
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
  }

  const eligible = keysFor(req, cfg, vault.keys);
  let attempted = 0;
  let cooled = 0;
  let lastError = '';

  for (const entry of eligible) {
    // Every request is Claude Code's, so a key whose credit doesn't cover it is set aside.
    if (!free && state.isCoolingDown(entry.id, cfg.cooldownMinutes)) {
      cooled++;
      continue;
    }
    attempted++;
    const headers = upstreamHeaders(req.headers, entry.key, body.length);
    const { res: upRes, upstream, error } = await forward(cfg, req, body, headers);
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
        // Out of credit for Claude Code: the credit may not cover it (see keys.js).
        const scope = /credit balance/i.test(detail) ? { scope: 'claude-code' } : {};
        state.recordKey(entry.id, {
          verdict: 'used-up',
          status: upRes.statusCode,
          detail,
          ...scope,
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
    log(`gateway: Claude Code request succeeded using key "${entry.label}" (HTTP ${upRes.statusCode})`);
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

  if (free) {
    log('gateway: no line could list models; answering with the built-in list');
    if (!res.destroyed && !res.headersSent) sendBuiltinModels(res);
    return;
  }
  events.emit('exhausted', {});
  const reason = desktop
    ? 'no subscription account has usage left and no API key has credit right now. Add an account or top up a key in the web UI, or sign in to Claude.ai in the desktop app.'
    : !eligible.length
      ? 'no API key matched this session.'
      : !attempted
        ? `every API key is used up (${cooled} cooling down).`
        : 'every API key is used up for this request.';
  log(`gateway: Claude Code request exhausted every line; attempted=${attempted}, coolingDown=${cooled}`);
  if (!res.destroyed && !res.headersSent) {
    sendError(res, 402, 'billing_error',
      `claude-nonstop: ${reason}` + (lastError ? ` Last upstream error: ${lastError}` : ''));
  }
}

module.exports = { handle, sameToken, sendError, readBody, isAccountToken, KEYS_HEADER };