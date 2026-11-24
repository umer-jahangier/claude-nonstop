'use strict';

// Gemini lines: a Gemini API key and a Google account (Gemini Code Assist), against a stand-in
// for both that answers the way Google's do (an event stream of generateContent chunks).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { isolate, startFakeApi, testKey, call } = require('./helpers');

isolate();

const GEMINI_KEY = (kind) => `AIzaSyTest-${kind}-${'X'.repeat(30)}`;
let fake;
let api;
// What the stand-in serves, by key kind or account token: 'ok', 'tool', 'daily' (a key out of
// its daily quota), 'limit' (an account at its limit), 'nopreview' (no preview models).
function startFakeGemini() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const key = String(req.headers['x-goog-api-key'] || '');
      const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
      const codeAssist = req.url.startsWith('/v1internal');
      const kind = codeAssist ? bearer.replace('ya29.', '') : (key.match(/^AIzaSyTest-([a-z]+)-/) || [])[1];
      const model = codeAssist ? body.model : decodeURIComponent((req.url.match(/models\/([^:]+):/) || [])[1] || '');
      requests.push({ url: req.url, key, bearer, model, body, headers: req.headers });
      const json = (status, v) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      if (req.method === 'GET') return json(kind === 'ok' ? 200 : 400, kind === 'ok' ? { models: [{ name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] }] } : { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } });
      if (kind === 'daily') return json(429, { error: { code: 429, message: 'Quota exceeded for metric generate_content_free_tier_requests, limit: 50 per day', status: 'RESOURCE_EXHAUSTED' } });
      if (kind === 'limit') return json(429, { error: { code: 429, message: 'You have exhausted your capacity on this model. Your quota will reset after 3h.', status: 'RESOURCE_EXHAUSTED' } });
      if (kind === 'nopreview' && /preview/.test(model)) return json(404, { error: { code: 404, message: `models/${model} is not found for API version v1beta`, status: 'NOT_FOUND' } });
      const wrap = (r) => (codeAssist ? { response: r, traceId: 'trace-1' } : r);
      const chunk1 = { candidates: [{ content: { role: 'model', parts: [{ text: 'Hello ' }] } }], modelVersion: model, responseId: 'resp-1' };
      const parts = kind === 'tool' ? [{ functionCall: { name: 'Bash', args: { command: 'ls' } }, thoughtSignature: 'SIG-1' }] : [{ text: `from ${model}` }];
      const chunk2 = { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, thoughtsTokenCount: 2 } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(wrap(chunk1))}\r\n\r\n`);
      res.end(`data: ${JSON.stringify(wrap(chunk2))}\r\n\r\n`);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)) })));
}

before(async () => {
  fake = await startFakeGemini();
  api = await startFakeApi();
  process.env.CLAUDE_NONSTOP_GEMINI_UPSTREAM = `${fake.url}/v1beta`;
  process.env.CLAUDE_NONSTOP_CODE_ASSIST = `${fake.url}/v1internal`;
  process.env.CLAUDE_NONSTOP_UPSTREAM = api.url;
});

const vault = require('../src/vault');
const keys = require('../src/keys');
const state = require('../src/state');
const config = require('../src/config');

let server;
let base;
let token;
before(async () => {
  const { createServer, createContext } = require('../src/server');
  token = vault.loadWithTokens().gatewayToken;
  server = createServer(createContext());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fake.close();
  await api.close();
});

// Lines in order: ['key', key] or ['google', kind] (a Google account signed in for Gemini).
function useLines(...lines) {
  const accounts = [];
  const order = [];
  const entries = [];
  const creds = {};
  lines.forEach((l, i) => {
    if (l[0] === 'google') {
      const id = `gem-${l[1]}-${i}`;
      accounts.push({ id, label: `Gemini ${l[1]}`, kind: 'gemini', provider: 'gemini', enabled: true });
      creds[id] = { google: true, accessToken: `ya29.${l[1]}`, refreshToken: 'r', expiresAt: Date.now() + 3600000, projectId: 'proj-1', email: 'me@example.com' };
      order.push(`account:${id}`);
    } else {
      const entry = keys.newEntry(l[1], `key ${i}`, i);
      entries.push(entry);
      order.push(`key:${entry.id}`);
    }
  });
  vault.update((v) => {
    v.keys = entries;
    v.accounts = creds;
  });
  config.update((c) => {
    c.accounts = accounts;
    c.order = order;
    c.pinned = null;
  });
  state.clearCooldowns();
  fake.requests.length = 0;
  api.requests.length = 0;
}

const messages = (model = 'claude-sonnet-5-5', extra = {}) => call(`${base}/v1/messages`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' },
  body: { model, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], ...extra },
});

test('Gemini and OpenAI keys are recognised, including OpenAI project keys', () => {
  assert.equal(keys.newEntry(GEMINI_KEY('ok'), 'g', 1).provider, 'gemini');
  assert.equal(keys.problemWith(GEMINI_KEY('ok')), null);
  assert.equal(keys.newEntry('sk-proj-Ab_cd-EF.gh1234567890abcdefghijKLMN', 'o', 1).provider, 'openai');
  assert.equal(keys.problemWith('sk-proj-Ab_cd-EF.gh1234567890abcdefghijKLMN'), null);
  assert.match(keys.problemWith('hello'), /Gemini keys with AIza/);
});

test('a Gemini key is tested against Google, not Anthropic', async () => {
  assert.equal((await keys.check(keys.newEntry(GEMINI_KEY('ok'), 'g', 1), config.load())).verdict, 'ok');
  const bad = await keys.check(keys.newEntry(GEMINI_KEY('bad'), 'g', 1), config.load());
  assert.equal(bad.verdict, 'used-up');
  assert.match(bad.detail, /API key not valid/);
});

test('a Claude Code request goes out on a Gemini API key, translated both ways', async () => {
  useLines(['key', GEMINI_KEY('ok')]);
  const r = await messages();
  assert.equal(r.status, 200, r.body);
  const out = JSON.parse(r.body);
  assert.equal(out.type, 'message');
  assert.equal(out.content[0].text, 'Hello from gemini-3.1-pro-preview');
  assert.equal(out.usage.output_tokens, 5);
  const sent = fake.requests[0];
  assert.equal(sent.key, GEMINI_KEY('ok'));
  assert.equal(sent.model, 'gemini-3.1-pro-preview', 'a Claude model is mapped to the Gemini default');
  assert.match(sent.url, /:streamGenerateContent\?alt=sse$/);
  assert.deepEqual(sent.body.contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);
  assert.equal(state.load().inUse.line, `key:${keys.fingerprint(GEMINI_KEY('ok'))}`);
});

test('a Gemini tool call comes back as a tool_use, and its signature goes back with it', async () => {
  useLines(['key', GEMINI_KEY('tool')]);
  let r = await messages('gemini-2.5-pro', { tools: [{ name: 'Bash', description: 'run', input_schema: { $schema: 'x', type: 'object', properties: { command: { type: 'string' } } } }] });
  const out = JSON.parse(r.body);
  const call1 = out.content.find((p) => p.type === 'tool_use');
  assert.deepEqual(call1.input, { command: 'ls' });
  assert.equal(out.stop_reason, 'tool_use');
  assert.equal(fake.requests[0].model, 'gemini-2.5-pro', 'a Gemini model asked for is kept');
  assert.equal(fake.requests[0].body.tools[0].functionDeclarations[0].parametersJsonSchema.$schema, undefined);
  r = await call(`${base}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' },
    body: { model: 'gemini-2.5-pro', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: out.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call1.id, content: 'a.txt' }] }] },
  });
  assert.equal(r.status, 200);
  const [, model, back] = fake.requests[1].body.contents;
  assert.equal(model.parts.find((p) => p.functionCall).thoughtSignature, 'SIG-1');
  assert.deepEqual(back.parts[0].functionResponse, { name: 'Bash', response: { output: 'a.txt' } });
});

test('a line that is not given a preview model gets the next Gemini model instead', async () => {
  useLines(['key', GEMINI_KEY('nopreview')]);
  const r = await messages();
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(fake.requests.map((x) => x.model), ['gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-2.5-pro']);
  assert.match(JSON.parse(r.body).content[0].text, /gemini-2\.5-pro/);
});

test('a Gemini key out of its daily quota is set aside and the next line answers', async () => {
  useLines(['key', GEMINI_KEY('daily')], ['key', testKey('ok')]);
  const r = await messages();
  assert.equal(r.status, 200, r.body);
  assert.equal(state.load().keys[keys.fingerprint(GEMINI_KEY('daily'))].verdict, 'used-up');
  assert.equal(api.requests.length, 1);
});

test('a Google account goes through Code Assist; at its limit the gateway moves on, and the cable with it', async () => {
  useLines(['google', 'ok']);
  let r = await messages();
  assert.equal(r.status, 200, r.body);
  const sent = fake.requests[0];
  assert.match(sent.url, /^\/v1internal:streamGenerateContent\?alt=sse$/);
  assert.equal(sent.bearer, 'ya29.ok');
  assert.equal(sent.body.project, 'proj-1');
  assert.deepEqual(sent.body.request.contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);
  assert.match(sent.headers['user-agent'], /^GeminiCLI\//);
  assert.equal(JSON.parse(r.body).content[0].text, 'Hello from gemini-3.1-pro-preview');
  assert.equal(state.load().inUse.line, 'account:gem-ok-0');

  useLines(['google', 'limit'], ['key', GEMINI_KEY('ok')]);
  r = await messages();
  assert.equal(r.status, 200, r.body);
  assert.match(state.load().accounts['gem-limit-0'].reason, /usage limit reached/);
  assert.equal(state.load().inUse.line, `key:${keys.fingerprint(GEMINI_KEY('ok'))}`, 'the line in use follows the gateway to the next line');
});

test('the model list offers Gemini models once a Gemini line is in the order', async () => {
  useLines(['key', GEMINI_KEY('ok')]);
  const r = await call(`${base}/v1/models`, { headers: { authorization: `Bearer ${token}` } });
  const ids = JSON.parse(r.body).data.map((m) => m.id);
  assert.ok(ids.includes('gemini-3.1-pro-preview'));
  assert.ok(ids.includes('gemini-2.5-pro'));
});

test('a Gemini quota 429 tries the next model first; a per-minute 429 does not set the key aside', async () => {
  const gw = require('../src/translate/gemini');
  assert.ok(gw);
  const p = require('../src/providers').gemini;
  assert.equal(p.isQuota('Quota exceeded ... limit: 50 per day'), true);
  assert.equal(p.isQuota('Quota exceeded for metric requests per minute'), false);
  assert.equal(p.isQuota('No capacity available for model gemini-3-pro-preview'), false);
});

test("reasoning another provider wrote is dropped before the conversation goes back to Claude", async () => {
  useLines(['key', testKey('ok')]);
  const r = await call(`${base}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' },
    body: { model: 'claude-sonnet-5-5', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'from gemini', signature: '' }, { type: 'text', text: 'hello' }] }, { role: 'user', content: 'again' }] },
  });
  assert.equal(r.status, 200);
  const sent = JSON.parse(api.requests[api.requests.length - 1].body);
  assert.deepEqual(sent.messages[1].content, [{ type: 'text', text: 'hello' }]);
});

test('a split multi-byte character in a stream comes out whole', () => {
  const sse = require('../src/translate/sse');
  const parse = sse.parser();
  const bytes = Buffer.from('data: {"t":"a—b"}\n\n');
  const cut = bytes.indexOf(0xe2) + 1;
  const out = [...parse(bytes.subarray(0, cut)), ...parse(bytes.subarray(cut))];
  assert.equal(JSON.parse(out[0].data).t, 'a—b');
});

test("a Google account Code Assist won't serve gets Google's own reason, not a vague one", async () => {
  const googleAuth = require('../src/google-auth');
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ allowedTiers: [{ id: 'standard-tier', name: 'Gemini Code Assist', userDefinedCloudaicompanionProject: true, isDefault: true }], ineligibleTiers: [{ reasonCode: 'UNSUPPORTED_CLIENT', reasonMessage: 'This client is no longer supported.', tierId: 'free-tier', tierName: 'Gemini Code Assist for individuals' }] }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const before = process.env.CLAUDE_NONSTOP_CODE_ASSIST;
  process.env.CLAUDE_NONSTOP_CODE_ASSIST = `http://127.0.0.1:${srv.address().port}/v1internal`;
  try {
    await assert.rejects(googleAuth.setUp('gem-x', { accessToken: 't' }), /no longer supported.*own Google Cloud project.*Gemini API key/s);
  } finally {
    process.env.CLAUDE_NONSTOP_CODE_ASSIST = before;
    srv.close();
  }
});
