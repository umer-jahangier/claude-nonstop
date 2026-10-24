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
      requests.push({ method: req.method, url: req.url, key, headers: req.headers, body });
      const kind = (key.match(/^sk-ant-api03-test-([a-z0-9]+)-/) || [])[1] || 'invalid';
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

module.exports = { ROOT, BIN, isolate, installFakeClaude, readFakeLog, testKey, startFakeApi, freePort, runCli, call };
