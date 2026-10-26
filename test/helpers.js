'use strict';

// Shared test setup: an isolated home folder per test file, a fake Claude API, and a
// fake `claude` binary. Nothing here touches your real keys, keychain or shell files.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'claude-nonstop.js');
const FAKE_CLAUDE = path.join(ROOT, 'fixtures', 'fake-claude.js');

// Must run before any src/ module is required, since paths are read at load time.
function isolate() {
  const realHome = os.homedir();
  // A space in the path checks quoting everywhere a path is passed to a shell.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude nonstop test-'));
  const env = {
    CLAUDE_NONSTOP_HOME: path.join(root, 'cn-home'),
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    CLAUDE_CONFIG_DIR: path.join(root, 'home', '.claude'),
    CLAUDE_NONSTOP_KEYSTORE: 'file',
    FAKE_CLAUDE_LOG: path.join(root, 'fake-claude.log'),
    CLAUDE_NONSTOP_HOSTS_FILE: path.join(root, 'hosts'),
    // Tests never touch the system's trusted roots or the desktop app's managed settings.
    CLAUDE_NONSTOP_NO_TLS: '1',
    CLAUDE_NONSTOP_NO_STARTUP_CHECK: '1',
    CLAUDE_NONSTOP_NO_NOTIFY: '1',
    CLAUDE_NONSTOP_DESKTOP_MANAGED: '0',
  };
  for (const dir of [env.HOME, env.CLAUDE_CONFIG_DIR]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(env.CLAUDE_NONSTOP_HOSTS_FILE, '127.0.0.1 localhost\n');
  Object.assign(process.env, env);
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  return { root, env, realHome };
}

// A `claude` the launcher can execute: a .cmd file on Windows (which also exercises the
// cmd.exe quoting path), a shell script elsewhere.
function installFakeClaude(root) {
  const dir = path.join(root, 'fake bin');
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    const file = path.join(dir, 'claude.cmd');
    fs.writeFileSync(file, `@echo off\r\n"${process.execPath}" "${FAKE_CLAUDE}" %*\r\n`);
    return file;
  }
  const file = path.join(dir, 'claude');
  fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function readFakeLog() {
  try {
    return fs
      .readFileSync(process.env.FAKE_CLAUDE_LOG, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const testKey = (kind) => `sk-ant-api03-test-${kind}-${'x'.repeat(24)}`;
const testAccountToken = (kind) => `sk-ant-oat-test-${kind}`;

// Signs a test account in, the way Claude Code stores a sign-in: a .credentials.json in its config folder.
function signInFakeAccount(configDir, kind, { expiresAt = Date.now() + 3600000 } = {}) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: testAccountToken(kind), expiresAt } }));
}

const apiError = (type, message) => ({ type: 'error', error: { type, message } });

// A stand-in for the Claude API that answers according to the key it's sent.
function startFakeApi() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const key = String(req.headers['x-api-key'] || '');
      // A subscription sign-in: "Bearer sk-ant-oat-test-<kind>"; 'limited' is an account at its limit.
      const bearer = String(req.headers.authorization || '').replace(/^Bearer /i, '');
      requests.push({ method: req.method, url: req.url, key, bearer, headers: req.headers, body });
      let kind = (key.match(/^sk-ant-api03-test-([a-z0-9]+)-/) || [])[1] || (bearer.match(/^sk-ant-oat-test-([a-z0-9]+)/) || [])[1] || 'invalid';
      if (kind === 'limited') kind = 'oauthlimit';
      // A subscription sign-in takes only Claude Code's own requests: the system prompt must open with its line.
      if (bearer && kind !== 'oauthlimit' && req.method === 'POST' && !/"system":\s*(\[\s*\{[^}]*)?"[^"]*You are Claude Code, Anthropic's official CLI for Claude\./.test(body)) kind = 'oauthshape';
      // A 'spent' key works until a fake session's keys run out (FAKE_API_SPENT_FILE says 'keys').
      if (kind === 'spent') {
        const file = process.env.FAKE_API_SPENT_FILE;
        kind = file && fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('keys') ? 'credit' : 'ok';
      }
      const send = (status, value) => {
        const text = JSON.stringify(value);
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
        res.end(text);
      };
      if (kind === 'ok' || kind === 'second') {
        if (/"stream"\s*:\s*true/.test(body)) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`event: message_start\ndata: {"type":"message_start","served_by":"${kind}"}\n\n`);
          setTimeout(() => {
            res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
            res.end();
          }, 30);
          return;
        }
        send(200, { type: 'message', id: `msg_${kind}`, content: [{ type: 'text', text: kind }] });
        return;
      }
      const errors = {
        credit: [400, apiError('invalid_request_error', 'Your credit balance is too low to access the Anthropic API.')],
        spend: [400, apiError('invalid_request_error', 'You have reached your specified API usage limits.')],
        badreq: [400, apiError('invalid_request_error', 'messages: field required')],
        billing: [402, apiError('billing_error', 'Billing problem')],
        ratelimit: [429, apiError('rate_limit_error', 'Too many requests')],
        oauthlimit: [429, apiError('rate_limit_error', "You've hit your limit · resets 3pm")],
        oauthshape: [429, apiError('rate_limit_error', 'Error')],
        overloaded: [529, apiError('overloaded_error', 'Overloaded')],
      };
      const [status, value] = errors[kind] || [401, apiError('authentication_error', 'invalid x-api-key')];
      send(status, value);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(done);
          }),
      });
    });
  });
}

const testOpenaiKey = (kind) => `sk-test-openai-${kind}-${'x'.repeat(24)}`;
const testChatgptToken = (kind) => `oat-test-${kind}`;

// Signs a fake ChatGPT account in: a sign-in in the vault, as openai-auth.js keeps it.
function signInFakeChatgpt(accountId, kind, { expiresAt = Date.now() + 3600000 } = {}) {
  require('../src/openai-auth').store(accountId, { accessToken: testChatgptToken(kind), refreshToken: `refresh-${kind}`, idToken: null, accountId: `acct_${kind}`, email: `${kind}@example.com`, plan: 'pro', expiresAt, refreshedAt: Date.now() });
}

// A stand-in for OpenAI's API (/v1/responses), the Codex backend (/backend-api/codex/responses)
// and OpenAI's sign-in token endpoint (/oauth/token). Answers according to the key or token:
// 'ok' and 'second' work, 'tool' answers with a function call, 'limited' is an account at
// its limit, 'quota' a key out of credit, 'stale' a sign-in that needs renewing.
function startFakeOpenAI() {
  const requests = [];
  const sse = (res, events) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-codex-primary-used-percent': '42', 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-at': '1800000000', 'x-codex-secondary-used-percent': '7', 'x-codex-secondary-window-minutes': '10080', 'x-codex-secondary-reset-at': '1800500000' });
    let i = 0;
    const next = () => {
      if (i >= events.length) {
        res.end();
        return;
      }
      const e = events[i++];
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      setTimeout(next, 5);
    };
    next();
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const bearer = String(req.headers.authorization || '').replace(/^Bearer /i, '');
      requests.push({ method: req.method, url: req.url, bearer, headers: req.headers, body: text });
      const send = (status, value, headers = {}) => {
        const out = JSON.stringify(value);
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out), ...headers });
        res.end(out);
      };
      if (req.url === '/oauth/token') {
        let form = {};
        try {
          form = JSON.parse(text);
        } catch {
          form = Object.fromEntries(new URLSearchParams(text));
        }
        if (form.grant_type === 'refresh_token' && /^refresh-/.test(form.refresh_token || '')) {
          send(200, { access_token: testChatgptToken('ok'), refresh_token: 'refresh-ok', id_token: null, token_type: 'Bearer' });
        } else send(400, { error: 'invalid_grant', error_description: 'refresh token revoked' });
        return;
      }
      if (req.url === '/v1/models') {
        const kind = (bearer.match(/^sk-test-openai-([a-z0-9]+)-/) || [])[1];
        if (kind === 'ok' || kind === 'second' || kind === 'tool') send(200, { object: 'list', data: [{ id: 'gpt-5.5', object: 'model' }] });
        else send(401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } });
        return;
      }
      const chatgpt = req.url.startsWith('/backend-api/codex/');
      const kind = chatgpt ? (bearer.match(/^oat-test-([a-z0-9]+)/) || [])[1] : (bearer.match(/^sk-test-openai-([a-z0-9]+)-/) || [])[1];
      let json = {};
      try {
        json = JSON.parse(text);
      } catch {}
      if (!kind || kind === 'invalid' || kind === 'stale') {
        send(401, chatgpt ? { detail: 'Unauthorized' } : { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } });
        return;
      }
      if (kind === 'limited') {
        send(429, { error: { type: 'usage_limit_reached', message: "You've hit your usage limit.", resets_in_seconds: 3600 } }, { 'x-codex-rate-limit-reached-type': 'codex_primary' });
        return;
      }
      if (kind === 'quota') {
        send(429, { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' } });
        return;
      }
      if (chatgpt && json.stream !== true) {
        send(400, { detail: 'Stream must be true' });
        return;
      }
      const usage = { input_tokens: 11, input_tokens_details: { cached_tokens: 1 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 14 };
      const output = kind === 'tool'
        ? [{ id: 'fc_1', type: 'function_call', status: 'completed', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Lahore"}' }]
        : [{ id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: `${kind} via ${json.model}`, annotations: [] }] }];
      const response = { id: `resp_${kind}`, object: 'response', created_at: 1, status: 'completed', model: json.model, output, usage };
      if (!json.stream) {
        send(200, response);
        return;
      }
      const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } }];
      if (kind === 'tool') {
        events.push({ type: 'response.output_item.added', output_index: 0, item: { ...output[0], arguments: '', status: 'in_progress' } });
        events.push({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"city":' });
        events.push({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '"Lahore"}' });
        events.push({ type: 'response.output_item.done', output_index: 0, item: output[0] });
      } else {
        events.push({ type: 'response.output_item.added', output_index: 0, item: { ...output[0], content: [], status: 'in_progress' } });
        events.push({ type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', content_index: 0, delta: `${kind} via ` });
        events.push({ type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', content_index: 0, delta: String(json.model) });
        events.push({ type: 'response.output_item.done', output_index: 0, item: output[0] });
      }
      events.push({ type: 'response.completed', response });
      sse(res, events);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(done);
          }),
      });
    });
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// Runs the claude-nonstop CLI as a separate process and collects its output.
function runCli(args, { env = {}, input = '', timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

// One HTTP request against a local server; resolves { status, headers, body }.
function call(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(url, { method, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

module.exports = { ROOT, BIN, isolate, installFakeClaude, readFakeLog, testKey, testAccountToken, signInFakeAccount, startFakeApi, testOpenaiKey, testChatgptToken, signInFakeChatgpt, startFakeOpenAI, freePort, runCli, call };
