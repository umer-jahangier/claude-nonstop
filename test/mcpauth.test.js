'use strict';

// A connector that signs in with OAuth, end to end against a stand-in service: claude-nonstop
// registers itself, the browser comes back to the gateway with a code, the tokens are kept,
// the app reaches the connector through the gateway with only the gateway token, and an
// expired token is renewed on the way.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { isolate } = require('./helpers');

isolate();
const config = require('../src/config');
const vault = require('../src/vault');

let svc;
let server;
let base;
const seen = { registered: 0, tokens: [], mcpAuth: [] };
let accessN = 0;

before(async () => {
  svc = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const origin = `http://127.0.0.1:${svc.address().port}`;
    const json = (status, v, h = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...h });
      res.end(JSON.stringify(v));
    };
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (u.pathname === '/.well-known/oauth-protected-resource/mcp') return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['read', 'write'] });
      if (u.pathname === '/.well-known/oauth-authorization-server') return json(200, { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, token_endpoint_auth_methods_supported: ['none'] });
      if (u.pathname === '/register') {
        seen.registered++;
        return json(201, { client_id: 'client-1', redirect_uris: JSON.parse(body).redirect_uris });
      }
      if (u.pathname === '/authorize') {
        // Signed in at once: back to the redirect with a code.
        const back = new URL(u.searchParams.get('redirect_uri'));
        back.searchParams.set('code', `code-for-${u.searchParams.get('code_challenge').slice(0, 6)}`);
        back.searchParams.set('state', u.searchParams.get('state'));
        seen.authorize = Object.fromEntries(u.searchParams);
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      if (u.pathname === '/token') {
        const form = Object.fromEntries(new URLSearchParams(body));
        seen.tokens.push(form);
        accessN++;
        return json(200, { access_token: `at-${accessN}`, refresh_token: 'rt-1', expires_in: form.grant_type === 'refresh_token' ? 3600 : 1 });
      }
      if (u.pathname === '/mcp') {
        const auth = req.headers.authorization || '';
        seen.mcpAuth.push(auth);
        if (!/^Bearer at-/.test(auth)) return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
        const msg = JSON.parse(body || '{}');
        return json(200, { jsonrpc: '2.0', id: msg.id, result: msg.method === 'tools/list' ? { tools: [{ name: 'a' }, { name: 'b' }] } : { protocolVersion: '2025-06-18', capabilities: {} } });
      }
      json(404, {});
    });
  });
  await new Promise((r) => svc.listen(0, '127.0.0.1', r));
  const { createServer, createContext } = require('../src/server');
  server = createServer(createContext());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  config.update((c) => (c.port = server.address().port));
});
after(() => {
  server.closeAllConnections();
  server.close();
  svc.close();
});

test('an OAuth connector: added, signed in through the gateway, used by the app with only the gateway token, renewed when it runs out', async () => {
  const cat = require('../src/connectorcatalog');
  const url = `http://127.0.0.1:${svc.address().port}/mcp`;
  // The address check wants https; a test service is plain http, so add it the way the page does after checking.
  config.update((c) => (c.desktopConnectors = [{ name: 'Svc', transport: 'http', url, auth: 'oauth' }]));
  assert.equal(cat.describeAuth(config.load().desktopConnectors[0], vault.load()), 'needs-sign-in');

  const login = await cat.connect('Svc');
  assert.equal(seen.registered, 1, 'claude-nonstop registered itself');
  // The browser: the service's page sends it back to the gateway's /oauth/callback.
  const r1 = await fetch(login.url, { redirect: 'manual' });
  const back = r1.headers.get('location');
  assert.match(back, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback\?/);
  const page = await fetch(back);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Svc is connected/);
  await login.done;
  assert.equal(seen.authorize.resource, url);
  assert.equal(seen.authorize.scope, 'read write');
  assert.equal(seen.tokens[0].grant_type, 'authorization_code');
  assert.ok(seen.tokens[0].code_verifier);
  assert.equal(cat.describeAuth(config.load().desktopConnectors[0], vault.load()), 'connected');
  assert.ok(!JSON.stringify(config.load()).includes('at-1'), 'tokens stay in the vault');

  // The app's request through the gateway: the first token has already run out, so it's renewed.
  await new Promise((r) => setTimeout(r, 50));
  const gw = vault.loadWithTokens().gatewayToken;
  const res = await fetch(`${base}/mcp/Svc`, { method: 'POST', headers: { authorization: `Bearer ${gw}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result.tools.length, 2);
  assert.equal(seen.tokens[1].grant_type, 'refresh_token');
  assert.equal(seen.mcpAuth[seen.mcpAuth.length - 1], 'Bearer at-2');

  const t = await cat.test('Svc');
  assert.deepEqual(t, { ok: true, tools: 2 });

  // The app's entry points at the gateway.
  const app = JSON.parse(require('../src/desktop').settings(config.load(), vault.loadWithTokens()).managedMcpServers)[0];
  assert.equal(app.url, `http://127.0.0.1:${config.load().port}/mcp/Svc`);
  cat.remove('Svc');
  assert.equal(require('../src/mcpauth').saved('Svc'), null);
});

test('a service that needs your own OAuth app says so, with the redirect URL to register', async () => {
  const cat = require('../src/connectorcatalog');
  await assert.rejects(cat.add({ slug: 'gmail' }), (err) => err.code === 'needs-client' && /\/oauth\/callback$/.test(err.redirect));
  const e = await cat.add({ slug: 'gmail', client: { id: 'cid.apps.googleusercontent.com', secret: 's' } });
  assert.equal(e.auth, 'oauth');
  // One Google app serves Drive and Calendar too.
  assert.equal((await cat.add({ slug: 'google-drive' })).auth, 'oauth');
  await assert.rejects(cat.add({ slug: 'n8n' }), (err) => err.code === 'needs-url');
  const n = await cat.add({ slug: 'n8n', url: 'http://localhost:5678/mcp-server/http', token: 'n8n-token-123' });
  assert.equal(n.auth, 'token');
  assert.ok(cat.catalog().some((c) => c.slug === 'highlevel' && c.auth === 'oauth'));
  config.update((c) => (c.desktopConnectors = []));
});
