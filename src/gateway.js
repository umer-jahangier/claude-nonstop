'use strict';

// The local gateway, at http://127.0.0.1:43117/v1/*. It takes requests in three formats
// (translate/index.js) and sends each one out on the first line in your order that can
// answer, whatever service that line is on:
//
//   An Anthropic line: a Claude subscription sign-in (the request goes out as Claude Code,
//   which that sign-in requires) or a Claude API key (as plain API: every Claude Code
//   signal is dropped from the headers and the system prompt, so API credit covers it).
//
//   An OpenAI line: a ChatGPT subscription sign-in (the request goes to the Codex backend,
//   as Codex, which that sign-in requires) or an OpenAI API key (plain API).
//
// A request whose format matches the line's service goes through as it came; one that
// doesn't is translated on the way out and the answer translated on the way back, so Claude
// Code can run on a ChatGPT account and Codex on a Claude one. A request for a model from
// the other service's family goes to that line's default model (`models` in config.json).
//
// Two kinds of request keep their old meaning: a terminal Claude Code session on API keys
// names its keys (x-claude-nonstop-keys), and a request already signed in to a Claude.ai
// account (a subscription token as its bearer) passes straight through to Anthropic.

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const providers = require('./providers');
const translate = require('./translate');
const relay = require('./relay');
const events = require('./events');
const state = require('./state');
const accounts = require('./accounts');
const usage = require('./usage');
const openaiAuth = require('./openai-auth');
const chatgptModels = require('./chatgpt-models');
const { log } = require('./files');

// What a Claude subscription sign-in needs to be accepted: Claude Code's identity and betas.
const CLI_USER_AGENT = 'claude-cli/2.1.310 (external, cli)';
const OAUTH_BETA = 'oauth-2025-04-20';
// A subscription sign-in accepts only Claude Code's own requests: the system prompt has to
// begin with this line, or Anthropic answers 429 "Error". Claude Code's requests carry it;
// the desktop app's startup probe doesn't, so the gateway puts it first when it's missing.
const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";
const ANTHROPIC_VERSION = '2026-10-21';

const MAX_BODY = 64 * 1024 * 1024;
const MAX_ERROR_BODY = 4 * 1024 * 1024;
const KEYS_HEADER = 'x-claude-nonstop-keys';
// A terminal Claude Code session on one account line (a ChatGPT account, which has no Claude
// Code sign-in of its own) names it: "account:<id>".
const LINE_HEADER = 'x-claude-nonstop-line';
// Hop-by-hop headers and the client's own credentials never go upstream.
const DROP_REQUEST = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
  'accept-encoding', 'authorization', 'x-api-key', KEYS_HEADER, LINE_HEADER,
]);
// The client's own identity, replaced by the line's on every request.
const IDENTITY = new Set(['user-agent', 'x-app', 'originator', 'session_id', 'chatgpt-account-id', 'openai-beta', 'openai-organization', 'openai-project', 'x-stainless-lang', 'x-stainless-package-version', 'x-stainless-os', 'x-stainless-arch', 'x-stainless-runtime', 'x-stainless-runtime-version', 'x-stainless-retry-count', 'x-stainless-timeout', 'x-stainless-helper-method']);
// Only hop-by-hop headers are dropped from a request on a Claude.ai sign-in; the sign-in stays.
const DROP_PASSTHROUGH = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
  'accept-encoding', KEYS_HEADER, LINE_HEADER,
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

// A terminal Claude Code session names the keys or the account it runs on; the desktop app sends no such header.
const isSession = (req) => Boolean(req.headers[KEYS_HEADER] || req.headers[LINE_HEADER]);

// The account line a session named, if any.
function lineFor(req, cfg) {
  const named = String(req.headers[LINE_HEADER] || '').trim();
  const m = /^account:(.+)$/.exec(named);
  if (!m) return null;
  const account = cfg.accounts.find((a) => a.id === m[1] && a.enabled !== false);
  return account ? [{ kind: 'account', item: account }] : [];
}

// Whether the client speaks OpenAI's formats, for the few answers the gateway writes itself
// before it has seen a body (the model list, an error on a path it doesn't know).
const speaksOpenAI = (req) => !req.headers['anthropic-version'] && !req.headers['x-api-key'] && /^\/v1\/(chat|responses|models)/.test(req.url || '');

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

// An error in the client's own format. `format` may be a translate format or null.
function sendError(res, status, type, message, format = null) {
  sendJson(res, status, translate.errorBody(format || 'messages', type, message));
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

// The client's headers without its identity, credentials or Claude Code's betas.
function stripped(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!DROP_REQUEST.has(lower) && !IDENTITY.has(lower)) out[lower] = value;
  }
  const betas = splitBetas(out['anthropic-beta']).filter((b) => !/^oauth-/i.test(b) && !/^claude-code(?:-|$)/i.test(b));
  if (betas.length) out['anthropic-beta'] = betas.join(',');
  else delete out['anthropic-beta'];
  out['accept-encoding'] = 'identity';
  return out;
}

// The headers for a request going out on an Anthropic line: Anthropic's own headers from
// the client when it spoke Anthropic's format, bare essentials otherwise.
function anthropicBase(headers, sameFormat) {
  const out = sameFormat ? stripped(headers) : { 'accept-encoding': 'identity' };
  out['content-type'] = 'application/json';
  if (!out['anthropic-version']) out['anthropic-version'] = ANTHROPIC_VERSION;
  return out;
}

// Claude Code's identity on a request going out on a subscription sign-in: the CLI user
// agent, x-app and the OAuth beta, which is what Claude Code itself sends on an account
// (the claude-code beta is refused there).
function claudeAccountHeaders(headers, sameFormat, token, length) {
  const out = anthropicBase(headers, sameFormat);
  out['anthropic-beta'] = [OAUTH_BETA, ...splitBetas(out['anthropic-beta'])].join(',');
  out['user-agent'] = CLI_USER_AGENT;
  out['x-app'] = 'cli';
  out.authorization = `Bearer ${token}`;
  out['content-length'] = String(length);
  return out;
}

// Headers for a request going out on a Claude API key: an ordinary API request, with no
// client identity at all, so it's billed as plain API use.
function claudeKeyHeaders(headers, sameFormat, key, length) {
  const out = anthropicBase(headers, sameFormat);
  out['x-api-key'] = key;
  out['content-length'] = String(length);
  return out;
}

// Headers for a request going out on an OpenAI API key.
function openaiKeyHeaders(headers, sameFormat, key, length) {
  const out = sameFormat ? stripped(headers) : { 'accept-encoding': 'identity' };
  delete out['anthropic-version'];
  delete out['anthropic-beta'];
  out['content-type'] = 'application/json';
  out.authorization = `Bearer ${key}`;
  out['content-length'] = String(length);
  return out;
}

// Headers for a request going out on a ChatGPT sign-in: Codex's identity, nothing of the client's.
function chatgptHeaders(creds, length) {
  return { ...providers.openai.accountHeaders(creds), 'content-type': 'application/json', 'accept-encoding': 'identity', 'content-length': String(length) };
}

// --------------------------------------------------------------- bodies

function parseJson(body) {
  try {
    const json = JSON.parse(body.toString('utf8'));
    return json && typeof json === 'object' && !Array.isArray(json) ? json : null;
  } catch {
    return null;
  }
}

// The request body as Claude Code would send it on a sign-in: the system prompt opens with
// Claude Code's identity line. Left alone when it already does, or isn't a JSON body.
function asClaudeCodeBody(body) {
  const json = parseJson(body);
  if (!json || !json.messages) return body;
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

// The request body as an ordinary API request: Anthropic also reads Claude Code's identity
// from the system prompt, and bills it as Claude Code (which much API credit doesn't cover,
// so the key answers 400 "credit balance is too low"). Two blocks do it: the billing header
// Claude Code puts first, and a block that is exactly its identity line ("You are Claude
// Code, ..." or the Agent SDK's). The billing header is dropped (it says nothing to the
// model); the identity line is kept, joined to the text after it, where it no longer marks
// the request. Left alone when there's nothing to change, or it isn't a JSON body.
const BILLING_HEADER = /^x-anthropic-billing-header:/i;
const IDENTITY_LINE = /^You are (?:Claude Code|a Claude agent)\b[^\n]*\bAnthropic's\b[^\n]*\.$/;

function asPlainApiBody(body) {
  const json = parseJson(body);
  if (!json || json.system === undefined) return body;
  const sys = json.system;
  if (typeof sys === 'string') {
    if (!IDENTITY_LINE.test(sys)) return body;
    json.system = `${sys}\n`;
    return Buffer.from(JSON.stringify(json));
  }
  if (!Array.isArray(sys)) return body;
  const isText = (b) => b && b.type === 'text' && typeof b.text === 'string';
  let changed = false;
  const out = [];
  for (const block of sys) {
    if (isText(block) && BILLING_HEADER.test(block.text)) {
      changed = true;
      continue;
    }
    out.push(block);
  }
  for (let i = 0; i < out.length; i++) {
    const block = out[i];
    if (!isText(block) || !IDENTITY_LINE.test(block.text)) continue;
    changed = true;
    const next = out[i + 1];
    if (isText(next)) {
      out.splice(i, 2, { ...next, text: `${block.text}\n\n${next.text}` });
    } else {
      out[i] = { ...block, text: `${block.text}\n` };
    }
  }
  if (!changed) return body;
  json.system = out;
  return Buffer.from(JSON.stringify(json));
}

// The model a line answers a request with: the one asked for when it's from the line's own
// service, else the line's default (an alias in `modelAliases` is applied first).
function modelFor(requested, provider, cfg) {
  const aliases = cfg.modelAliases || {};
  const model = aliases[requested] || requested;
  if (translate.ir.family(model) === provider.id) return model;
  return (cfg.models && cfg.models[provider.id]) || provider.defaultModel;
}

// A Responses-API body for an OpenAI line, out of the client's own Responses request:
// the model mapped, nothing stored upstream, and (on a ChatGPT sign-in) always streamed, as
// the Codex backend requires. Fields the backend wouldn't take are dropped.
function asResponsesBody(json, model, { chatgpt }) {
  const out = { ...json, model, store: false };
  if (chatgpt) {
    out.stream = true;
    // The backend takes input only as a list of items.
    if (typeof out.input === 'string') out.input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: out.input }] }];
    delete out.previous_response_id;
    delete out.service_tier;
    delete out.safety_identifier;
    delete out.user;
    delete out.metadata;
    delete out.max_tool_calls;
    delete out.truncation;
    delete out.background;
    const include = new Set([...(Array.isArray(out.include) ? out.include : []), 'reasoning.encrypted_content']);
    out.include = [...include];
    // Cached answers of another provider's reasoning can't be read here.
    if (Array.isArray(out.input)) out.input = out.input.filter((i) => !(i && i.type === 'reasoning' && !i.encrypted_content));
  }
  return Buffer.from(JSON.stringify(out));
}

// --------------------------------------------------------------- lines

// A Claude account the gateway can use right now: on, signed in, and not seen at its limit
// in the last while. Returns its token, or null with why not.
function claudeToken(account, cfg) {
  const recent = state.load().accounts[account.id];
  if (recent && !recent.ok && accounts.isLimitReason(recent.reason) && Date.now() - recent.at < cfg.accountRecheckMinutes * 60000) {
    return { token: null, why: recent.reason };
  }
  const creds = usage.readCredentials(account);
  if (!creds) return { token: null, why: 'no sign-in token found' };
  if (creds.expiresAt && creds.expiresAt < Date.now()) return { token: null, why: 'sign-in token expired' };
  return { token: creds.token, why: '' };
}

// A ChatGPT account the gateway can use right now, with a sign-in good for a while.
async function chatgptCredentials(account, cfg) {
  const recent = state.load().accounts[account.id];
  if (recent && !recent.ok && accounts.isLimitReason(recent.reason) && Date.now() - recent.at < cfg.accountRecheckMinutes * 60000) {
    return { creds: null, why: recent.reason };
  }
  try {
    const creds = await openaiAuth.current(account.id);
    if (!creds) return { creds: null, why: 'not signed in' };
    return { creds, why: '' };
  } catch (err) {
    return { creds: null, why: `sign-in could not be renewed: ${err.message}` };
  }
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

function forward(url, method, body, headers) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
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
    const upstream = lib.request(target, { method, headers, agent: agents[target.protocol] }, (res) => finish({ res, upstream }));
    upstream.on('error', (error) => finish({ error }));
    upstream.end(body.length ? body : undefined);
  });
}

// A request on a Claude.ai sign-in, sent to Anthropic exactly as it came and answered as is.
async function passthrough(cfg, req, res, body) {
  const { res: upRes, upstream, error } = await forward(`${cfg.upstream}${req.url}`, req.method, body, passthroughHeaders(req.headers, body.length));
  if (error) {
    log(`gateway: upstream connection failed: ${error.message}`);
    if (!res.destroyed && !res.headersSent) {
      sendError(res, 502, 'api_error',
        `claude-nonstop gateway could not reach ${cfg.upstream}: ${error.message}`);
    }
    return;
  }
  log(`gateway: Claude.ai account request passed through (HTTP ${upRes.statusCode})`);
  pipe(res, upRes, upstream);
}

function pipe(res, upRes, upstream) {
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

// Hands an upstream answer to the client in the client's own format. Same format and the
// same streaming either side: the bytes go through untouched. Otherwise the answer is read
// (whole, or event by event) and written again as the client asked.
function deliver(res, upRes, upstream, { inbound, wire, clientStream, upstreamStream, model, includeUsage }) {
  if (inbound === wire && clientStream === upstreamStream) {
    pipe(res, upRes, upstream);
    return;
  }
  if (res.destroyed || res.headersSent) {
    upstream.destroy();
    return;
  }
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });
  const headers = { 'cache-control': 'no-cache' };
  const requestId = upRes.headers['request-id'] || upRes.headers['x-request-id'];
  if (requestId) headers['request-id'] = String(requestId);
  if (!upstreamStream) {
    // A whole answer came back; the client gets it whole or as a stream of its own format.
    readBody(upRes, MAX_BODY).then((buf) => {
      const json = parseJson(buf);
      if (!json) {
        sendError(res, 502, 'api_error', 'claude-nonstop gateway: the answer could not be read.', inbound);
        return;
      }
      const answer = translate.readAnswer(wire, json);
      if (!clientStream) {
        sendJson(res, 200, translate.writeAnswer(inbound, answer, { model }));
        return;
      }
      res.writeHead(200, { ...headers, 'content-type': 'text/event-stream; charset=utf-8' });
      const write = translate.streamWriter(inbound, { model, includeUsage });
      for (const event of translate.ir.eventsOf(answer)) res.write(write(event));
      res.end();
    }).catch(() => {
      if (!res.headersSent) sendError(res, 502, 'api_error', 'claude-nonstop gateway: the answer could not be read.', inbound);
      else res.end();
    });
    return;
  }
  const read = translate.streamReader(wire);
  if (clientStream) {
    res.writeHead(200, { ...headers, 'content-type': 'text/event-stream; charset=utf-8' });
    const write = translate.streamWriter(inbound, { model, includeUsage });
    let stopped = false;
    upRes.on('data', (chunk) => {
      for (const event of read(chunk)) {
        if (event.type === 'stop' || event.type === 'error') stopped = true;
        res.write(write(event));
      }
    });
    upRes.on('end', () => {
      if (!stopped) res.write(write({ type: 'stop', stopReason: 'end_turn' }));
      res.end();
    });
    upRes.on('error', () => {
      if (!stopped) res.write(write({ type: 'error', message: 'the upstream stream ended early' }));
      res.end();
    });
    return;
  }
  // The client wanted the whole answer; the upstream only streams.
  const collect = translate.ir.collector();
  collect.push({ type: 'start', id: null, model });
  upRes.on('data', (chunk) => {
    for (const event of read(chunk)) collect.push(event);
  });
  const finish = () => {
    const { answer, error } = collect.result();
    if (error && !answer.content.length) {
      sendError(res, 502, 'api_error', error.message, inbound);
      return;
    }
    sendJson(res, 200, translate.writeAnswer(inbound, answer, { model }));
  };
  upRes.on('end', finish);
  upRes.on('error', finish);
}

// --------------------------------------------------------------- the model list

// Every model the lines in use can answer for, in the client's own list format. Answered by
// the gateway itself: the lists are well known, and asking a line would spend its attention.
function sendModels(req, res, cfg, allKeys) {
  const used = new Set(relay.active(cfg, allKeys).map((l) => providers.of(l.item).id));
  const ids = used.size ? [...used] : ['anthropic'];
  const models = [];
  for (const id of ['anthropic', 'openai']) if (ids.includes(id)) models.push(...providers.byId(id).models.map(([m, name]) => [m, name, id]));
  // What each ChatGPT sign-in's backend listed last.
  const seen = new Set(models.map((m) => m[0]));
  for (const a of cfg.accounts) {
    if (a.kind !== 'chatgpt' || a.enabled === false) continue;
    for (const m of chatgptModels.known(a.id) || []) if (!seen.has(m.slug) && seen.add(m.slug)) models.push([m.slug, m.name, 'openai']);
  }
  sendJson(res, 200, translate.modelList(speaksOpenAI(req) ? 'openai' : 'messages', models));
}

// --------------------------------------------------------------- the walk

async function handle(req, res, ctx) {
  const { cfg, vault } = ctx.current();
  const token = clientToken(req);
  const account = isAccountToken(token);
  const inbound = translate.detect(req);
  if (!account && !sameToken(token, vault.gatewayToken)) {
    sendError(res, 401, 'authentication_error',
      'claude-nonstop gateway: missing or invalid gateway token.', speaksOpenAI(req) ? 'responses' : null);
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
        : 'claude-nonstop gateway: could not read request body.', inbound);
    return;
  }

  // Signed in to a Claude.ai account: no key is spent, the request goes out as it came.
  if (account) {
    await passthrough(cfg, req, res, body);
    return;
  }

  if (inbound === 'models') {
    sendModels(req, res, cfg, vault.keys);
    return;
  }

  // Terminal Claude Code sessions on API keys name their keys; everything else walks the
  // whole order, accounts included.
  const desktop = !isSession(req);

  // A request the gateway doesn't translate (token counting, say) goes out as it came, on
  // the first Anthropic line.
  if (!inbound) {
    await rawAnthropic(req, res, ctx, body, desktop);
    return;
  }

  const json = parseJson(body);
  if (!json) {
    sendError(res, 400, 'invalid_request_error', 'claude-nonstop gateway: the request body is not JSON.', inbound);
    return;
  }
  let parsed;
  try {
    parsed = translate.readRequest(inbound, json);
  } catch (err) {
    sendError(res, 400, 'invalid_request_error', `claude-nonstop gateway: could not read the request: ${err.message}`, inbound);
    return;
  }
  const clientStream = Boolean(json.stream);
  const requested = String(json.model || '');

  const lines = [];
  const named = lineFor(req, cfg);
  if (named) lines.push(...named);
  else if (desktop) {
    for (const group of relay.groups(cfg, vault.keys)) {
      if (group.kind === 'account') lines.push({ kind: 'account', item: group.account });
      else for (const key of group.keys) lines.push({ kind: 'key', item: key });
    }
  } else {
    for (const key of keysFor(req, cfg, vault.keys)) lines.push({ kind: 'key', item: key });
  }

  let attempted = 0;
  let cooled = 0;
  let lastError = '';
  const fail = (status, type, message) => {
    if (!res.destroyed && !res.headersSent) sendError(res, status, type, message, inbound);
  };

  for (const line of lines) {
    const { item } = line;
    const provider = providers.of(item);
    const wire = provider.wire;
    const model = modelFor(requested, provider, cfg);
    const sameFormat = inbound === wire && model === requested;
    const chatgpt = line.kind === 'account' && provider.id === 'openai';
    const upstreamStream = chatgpt ? true : clientStream;
    const label = item.label;

    // ---- what goes out, and where
    let outBody;
    let url;
    let headers;
    let creds = null;
    let chatgptModel = model;
    const chatgptBody = (m) => (inbound === 'responses' ? asResponsesBody(json, m, { chatgpt: true }) : Buffer.from(JSON.stringify(translate.writeRequest('responses', { ...parsed, stream: true }, { model: m, store: false, stream: true, includeEncrypted: true }))));
    if (line.kind === 'account' && provider.id === 'anthropic') {
      const { token: t, why } = claudeToken(item, cfg);
      if (!t) {
        log(`gateway: ${label}: ${why}; trying the next line`);
        continue;
      }
      outBody = asClaudeCodeBody(sameFormat ? body : Buffer.from(JSON.stringify(translate.writeRequest('messages', parsed, { model }))));
      url = `${cfg.upstream}/v1/messages`;
      headers = claudeAccountHeaders(req.headers, sameFormat, t, outBody.length);
    } else if (chatgpt) {
      const r = await chatgptCredentials(item, cfg);
      if (!r.creds) {
        log(`gateway: ${label}: ${r.why}; trying the next line`);
        continue;
      }
      creds = r.creds;
      // The Codex backend takes only the models on its own list for this account.
      chatgptModel = await chatgptModels.pick(model, item.id, creds, cfg);
      outBody = chatgptBody(chatgptModel);
      url = `${providers.openai.chatgptUpstream(cfg)}/responses`;
      headers = chatgptHeaders(creds, outBody.length);
    } else if (line.kind === 'key') {
      if (state.isCoolingDown(item.id, cfg.cooldownMinutes)) {
        cooled++;
        continue;
      }
      attempted++;
      if (provider.id === 'anthropic') {
        outBody = asPlainApiBody(sameFormat ? body : Buffer.from(JSON.stringify(translate.writeRequest('messages', parsed, { model }))));
        url = `${cfg.upstream}/v1/messages`;
        headers = claudeKeyHeaders(req.headers, sameFormat, item.key, outBody.length);
      } else {
        outBody = inbound === 'responses' ? asResponsesBody(json, model, { chatgpt: false }) : Buffer.from(JSON.stringify(translate.writeRequest('responses', parsed, { model, store: false })));
        url = `${providers.openai.upstream(cfg)}/responses`;
        headers = openaiKeyHeaders(req.headers, sameFormat, item.key, outBody.length);
      }
    } else {
      continue;
    }

    // ---- send it, once more after renewing a ChatGPT sign-in that was refused
    let upRes;
    let upstream;
    for (let attempt = 0; ; attempt++) {
      const r = await forward(url, 'POST', outBody, headers);
      if (r.error) {
        log(`gateway: upstream connection failed: ${r.error.message}`);
        fail(502, 'api_error', `claude-nonstop gateway could not reach ${new URL(url).origin}: ${r.error.message}`);
        return;
      }
      upRes = r.res;
      upstream = r.upstream;
      if (chatgpt && upRes.statusCode === 400 && attempt === 0) {
        // The backend's model list may have changed since it was last asked: ask again,
        // and send the request once more with a model it lists now.
        const text = (await readBody(upRes, MAX_ERROR_BODY).catch(() => Buffer.alloc(0))).toString('utf8');
        if (chatgptModels.isModelRefusal(400, text)) {
          const again = await chatgptModels.pick(model, item.id, creds, cfg, { force: true });
          if (again !== chatgptModel) {
            log(`gateway: ${label}: the ChatGPT backend no longer lists ${chatgptModel}; sending ${again} instead`);
            chatgptModel = again;
            outBody = chatgptBody(chatgptModel);
            headers = chatgptHeaders(creds, outBody.length);
            continue;
          }
        }
        // Not a model problem, or nothing better to send: hand the answer on as it is.
        upstream.destroy();
        fail(400, 'invalid_request_error', `${label}: ${provider.errorMessage(text) || text || 'HTTP 400'}`);
        return;
      }
      if (chatgpt && upRes.statusCode === 401 && attempt === 0) {
        upstream.destroy();
        try {
          creds = await openaiAuth.refresh(item.id);
          headers = chatgptHeaders(creds, outBody.length);
          continue;
        } catch (err) {
          state.recordAccount(item.id, { ok: false, reason: `sign-in refused: ${err.message}` });
          log(`gateway: ${label}: sign-in refused and could not be renewed (${err.message}); trying the next line`);
          events.emit('switch', { accountId: item.id, label, status: 401, detail: err.message });
          upRes = null;
        }
      }
      break;
    }
    if (!upRes) continue;

    // ---- what the answer means for the line
    const status = upRes.statusCode;
    const ref = line.kind === 'account' ? { accountId: item.id, label } : { keyId: item.id, label };
    if (line.kind === 'account' && (status === 429 || status === 401 || status === 403)) {
      const errBody = await readBody(upRes, MAX_ERROR_BODY).catch(() => Buffer.alloc(0));
      const text = errBody.toString('utf8');
      const detail = provider.errorMessage(text) || `HTTP ${status}`;
      // A usage limit says so; any other 429 is a passing refusal, so the account isn't set aside for it.
      const limited = status === 429 && (provider.id === 'openai'
        ? providers.openai.isLimit(status, text, upRes.headers)
        : /limit/i.test(detail) || /rejected/i.test(String(upRes.headers['anthropic-ratelimit-unified-status'] || '')));
      if (status !== 429 || limited) {
        state.recordAccount(item.id, { ok: false, reason: limited ? `usage limit reached: ${detail}` : `sign-in refused: ${detail}` });
      }
      if (chatgpt) recordChatgptUsage(item, upRes.headers);
      log(`gateway: ${label} unavailable (HTTP ${status}: ${detail}); trying the next line`);
      events.emit('switch', { ...ref, status, detail });
      continue;
    }
    if (line.kind === 'key' && status >= 400) {
      const errBody = await readBody(upRes, MAX_ERROR_BODY).catch(() => Buffer.alloc(0));
      const text = errBody.toString('utf8');
      if (provider.classify(status, text) === 'used-up') {
        const detail = provider.errorMessage(text);
        lastError = detail;
        state.recordKey(item.id, { verdict: 'used-up', status, detail });
        log(`gateway: API key "${label}" unavailable (HTTP ${status}); trying next key`);
        events.emit('switch', { ...ref, status, detail });
        continue;
      }
      events.emit('request', { ...ref, status, path: req.url });
      if (res.destroyed || res.headersSent) return;
      // The error in the client's format, with the provider's message.
      if (inbound === wire) {
        res.writeHead(status, responseHeaders(upRes.headers, errBody.length));
        res.end(errBody);
      } else {
        sendError(res, status, status === 400 ? 'invalid_request_error' : status === 429 ? 'rate_limit_error' : 'api_error', provider.errorMessage(text) || `HTTP ${status} from ${provider.name}`, inbound);
      }
      return;
    }
    if (status >= 400) {
      // An account's other refusals (a malformed request, say) are the client's to see.
      const errBody = await readBody(upRes, MAX_ERROR_BODY).catch(() => Buffer.alloc(0));
      events.emit('request', { ...ref, status, path: req.url });
      if (res.destroyed || res.headersSent) return;
      if (inbound === wire) {
        res.writeHead(status, responseHeaders(upRes.headers, errBody.length));
        res.end(errBody);
      } else {
        sendError(res, status, status === 400 ? 'invalid_request_error' : 'api_error', provider.errorMessage(errBody.toString('utf8')) || `HTTP ${status} from ${provider.name}`, inbound);
      }
      return;
    }

    // ---- it answered
    if (line.kind === 'account') {
      if (state.load().accounts[item.id]?.ok === false) state.recordAccount(item.id, { ok: true, reason: '' });
      ctx.noteAccountInUse(item, { desktop });
      if (chatgpt) recordChatgptUsage(item, upRes.headers);
    } else {
      ctx.noteKeyInUse(item, { desktop });
    }
    events.emit('request', { ...ref, status, path: req.url });
    log(`gateway: ${inbound} request went out on ${line.kind === 'key' ? `API key "${label}"` : label}${model !== requested ? ` as ${model}` : ''} (HTTP ${status})`);
    deliver(res, upRes, upstream, { inbound, wire, clientStream, upstreamStream, model: requested || model, includeUsage: Boolean(parsed.includeUsage) });
    return;
  }

  events.emit('exhausted', {});
  const reason = desktop
    ? 'no subscription account has usage left and no API key has credit right now. Add an account or top up a key in the web UI, or sign in to Claude.ai in the desktop app.'
    : named
      ? `${named.length ? `${named[0].item.label} has no usage left right now` : 'that account is gone or paused'}.`
      : !lines.length
      ? 'no API key matched this session.'
      : !attempted
        ? `every API key is used up (${cooled} cooling down).`
        : 'every API key is used up for this request.';
  log(`gateway: request exhausted every line; attempted=${attempted}, coolingDown=${cooled}`);
  fail(402, 'billing_error', `claude-nonstop: ${reason}` + (lastError ? ` Last upstream error: ${lastError}` : ''));
}

// Codex's rate-limit headers come with every answer from the Codex backend; they're this
// account's usage readout.
function recordChatgptUsage(account, headers) {
  const u = providers.openai.usageFromHeaders(headers);
  if (!u) return;
  state.recordUsage(account.id, { ...u, at: Date.now() });
  events.notify('usage', { id: account.id });
}

// A request on a path the gateway doesn't translate, sent as it came on the first Anthropic
// line (an account for the desktop app, a key for everyone).
async function rawAnthropic(req, res, ctx, body, desktop) {
  const { cfg, vault } = ctx.current();
  const lines = [];
  if (desktop) {
    for (const group of relay.groups(cfg, vault.keys)) {
      if (group.kind === 'account') lines.push({ kind: 'account', item: group.account });
      else for (const key of group.keys) lines.push({ kind: 'key', item: key });
    }
  } else {
    for (const key of keysFor(req, cfg, vault.keys)) lines.push({ kind: 'key', item: key });
  }
  for (const line of lines.filter((l) => providers.of(l.item).id === 'anthropic')) {
    const { item } = line;
    let outBody;
    let headers;
    if (line.kind === 'account') {
      const { token } = claudeToken(item, cfg);
      if (!token) continue;
      outBody = asClaudeCodeBody(body);
      headers = claudeAccountHeaders(req.headers, true, token, outBody.length);
    } else {
      if (state.isCoolingDown(item.id, cfg.cooldownMinutes)) continue;
      outBody = asPlainApiBody(body);
      headers = claudeKeyHeaders(req.headers, true, item.key, outBody.length);
    }
    const { res: upRes, upstream, error } = await forward(`${cfg.upstream}${req.url}`, req.method, outBody, headers);
    if (error) {
      if (!res.destroyed && !res.headersSent) sendError(res, 502, 'api_error', `claude-nonstop gateway could not reach ${cfg.upstream}: ${error.message}`);
      return;
    }
    if (upRes.statusCode === 401 || upRes.statusCode === 403 || (upRes.statusCode === 429 && line.kind === 'account')) {
      upstream.destroy();
      continue;
    }
    log(`gateway: ${req.method} ${req.url.split('?')[0]} went out on ${item.label} (HTTP ${upRes.statusCode})`);
    pipe(res, upRes, upstream);
    return;
  }
  if (!res.destroyed && !res.headersSent) sendError(res, 402, 'billing_error', 'claude-nonstop: no Anthropic line could take this request.');
}

module.exports = { handle, sameToken, sendError, readBody, isAccountToken, asPlainApiBody, asClaudeCodeBody, modelFor, KEYS_HEADER, LINE_HEADER };
