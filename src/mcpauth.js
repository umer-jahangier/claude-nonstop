'use strict';

// Signing in to a connector's own service, done by claude-nonstop instead of the desktop app.
// The app then reaches the connector through the gateway (mcpproxy.js), which adds the access
// token to every request and renews it, so a connector works the same in every app and an
// app never has to sign in to it itself.
//
// The sign-in is standard MCP authorization: the server's protected-resource metadata names
// its authorization server; claude-nonstop registers itself there (dynamic client
// registration) or uses an OAuth app you registered (a client ID and secret, for services
// such as Google and Slack that don't let apps register themselves); you sign in on the
// service's own page in your browser; it comes back to the gateway's /oauth/callback with a
// code, exchanged (PKCE) for tokens kept encrypted in the vault.

const crypto = require('crypto');
const vault = require('./vault');
const config = require('./config');
const { log } = require('./files');

const TIMEOUT = 15000;
const pending = new Map(); // state -> { name, verifier, redirect, client, meta, resource, scope, at, done }

const b64url = (b) => Buffer.from(b).toString('base64url');
const key = (name) => String(name).toLowerCase();

async function getJson(url, init = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': 'claude-nonstop', ...(init.headers || {}) } });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, headers: r.headers, json, text };
  } catch (err) {
    return { status: 0, headers: new Headers(), json: null, text: err.message };
  } finally {
    clearTimeout(t);
  }
}

const wellKnown = (base, name) => {
  const u = new URL(base);
  const p = u.pathname.replace(/\/$/, '');
  return p ? [`${u.origin}/.well-known/${name}${p}`, `${u.origin}/.well-known/${name}`, `${u.origin}${p}/.well-known/${name}`] : [`${u.origin}/.well-known/${name}`];
};

// Where and how a connector's server signs people in.
async function discover(url) {
  let resource = null;
  const probe = await getJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const hint = (probe.headers.get('www-authenticate') || '').match(/resource_metadata="([^"]+)"/);
  if (hint) resource = (await getJson(hint[1])).json;
  if (!resource) for (const u of wellKnown(url, 'oauth-protected-resource')) if ((resource = (await getJson(u)).json) && resource.authorization_servers) break;
  let issuer = (resource && Array.isArray(resource.authorization_servers) && resource.authorization_servers[0]) || new URL(url).origin;
  try {
    issuer = new URL(issuer, url).href.replace(/\/$/, '');
  } catch {
    issuer = new URL(url).origin;
  }
  let meta = null;
  for (const u of [...wellKnown(issuer, 'oauth-authorization-server'), ...wellKnown(issuer, 'openid-configuration')]) {
    const j = (await getJson(u)).json;
    if (j && j.authorization_endpoint && j.token_endpoint) {
      meta = j;
      break;
    }
  }
  if (!meta) return null;
  return {
    issuer: meta.issuer || issuer,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: meta.registration_endpoint || null,
    // The resource indicator the server expects tokens for (RFC 8707).
    resource: (resource && resource.resource) || url,
    scopes: (resource && Array.isArray(resource.scopes_supported) && resource.scopes_supported) || (Array.isArray(meta.scopes_supported) ? meta.scopes_supported : []),
    authMethods: meta.token_endpoint_auth_methods_supported || ['client_secret_basic'],
  };
}

// The address the service sends you back to: the gateway itself.
const redirectUri = (cfg = config.load()) => `http://127.0.0.1:${cfg.port}/oauth/callback`;

const saved = (name, v = vault.load()) => (v.connectorAuth || {})[key(name)] || null;
const save = (name, change) => vault.update((v) => {
  v.connectorAuth = v.connectorAuth || {};
  v.connectorAuth[key(name)] = change(v.connectorAuth[key(name)] || {});
});
const forget = (name) => vault.update((v) => {
  if (v.connectorAuth) delete v.connectorAuth[key(name)];
});

// An OAuth app you registered with a service, kept per service so Gmail, Drive and
// Calendar share one Google app. { id, secret }.
const clientFor = (issuer, v = vault.load()) => ((v.oauthClients || {})[issuer]) || null;
const saveClient = (issuer, client) => vault.update((v) => {
  v.oauthClients = v.oauthClients || {};
  v.oauthClients[issuer] = client;
});

async function register(meta, redirect) {
  const r = await getJson(meta.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'claude-nonstop', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'native' }),
  });
  if (!r.json || !r.json.client_id) throw Object.assign(new Error(`the service refused to register claude-nonstop (${(r.json && (r.json.error_description || r.json.error)) || `HTTP ${r.status}`})`), { code: 'register-refused' });
  return { id: r.json.client_id, secret: r.json.client_secret || null, redirect, registered: true };
}

// Starts a sign-in for a saved connector: returns the address to open in the browser.
// `client` is an OAuth app you registered, for a service without self-registration.
async function start(entry, { client = null } = {}) {
  const meta = await discover(entry.url);
  if (!meta) throw new Error(`${entry.name} doesn't publish how to sign in to it. Add it with an access token instead`);
  const redirect = redirectUri();
  let use = client || clientFor(meta.issuer);
  const before = saved(entry.name);
  if (!use && before && before.client && before.client.registered && before.client.redirect === redirect && before.issuer === meta.issuer) use = before.client;
  if (!use) {
    if (!meta.registrationEndpoint) {
      const err = new Error(`${entry.name} doesn't let apps register themselves. Register an OAuth app with ${new URL(meta.issuer).hostname} and enter its client ID and secret`);
      err.code = 'needs-client';
      err.issuer = meta.issuer;
      err.redirect = redirect;
      throw err;
    }
    use = await register(meta, redirect);
  } else if (client) {
    saveClient(meta.issuer, client);
  }
  const verifier = b64url(crypto.randomBytes(48));
  const state = b64url(crypto.randomBytes(24));
  const scope = (entry.scopes && entry.scopes.length ? entry.scopes : meta.scopes).join(' ');
  const auth = new URL(meta.authorizationEndpoint);
  const params = {
    response_type: 'code',
    client_id: use.id,
    redirect_uri: redirect,
    state,
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    resource: meta.resource,
    ...(scope ? { scope } : {}),
  };
  // Google gives a refresh token only when asked for offline access.
  if (/accounts\.google\.com/.test(meta.issuer)) Object.assign(params, { access_type: 'offline', prompt: 'consent' });
  for (const [k, v] of Object.entries(params)) auth.searchParams.set(k, v);
  let settle;
  const done = new Promise((resolve, reject) => (settle = { resolve, reject }));
  done.catch(() => {});
  pending.set(state, { name: entry.name, verifier, redirect, client: use, meta, at: Date.now(), settle });
  for (const [s, p] of pending) if (Date.now() - p.at > 20 * 60000) pending.delete(s);
  return { url: auth.toString(), done };
}

async function tokenRequest(meta, client, form) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams(form);
  if (client.secret && !(meta.authMethods || []).includes('client_secret_post') && (meta.authMethods || []).includes('client_secret_basic')) {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.id)}:${encodeURIComponent(client.secret)}`).toString('base64')}`;
  } else {
    body.set('client_id', client.id);
    if (client.secret) body.set('client_secret', client.secret);
  }
  const r = await getJson(meta.tokenEndpoint, { method: 'POST', headers, body: body.toString() });
  if (!r.json || !r.json.access_token) {
    const err = new Error((r.json && (r.json.error_description || r.json.error)) || `HTTP ${r.status}`);
    err.code = r.json && r.json.error;
    throw err;
  }
  return r.json;
}

const tokensFrom = (t, before = {}) => ({
  accessToken: t.access_token,
  refreshToken: t.refresh_token || before.refreshToken || null,
  expiresAt: t.expires_in ? Date.now() + Number(t.expires_in) * 1000 : null,
  scope: t.scope || before.scope || null,
});

// The browser comes back here. Returns { ok, name, message } for the page shown.
async function callback(query) {
  const p = pending.get(query.get('state'));
  if (!p) return { ok: false, message: 'This sign-in has expired or belongs to another attempt. Start it again from claude-nonstop.' };
  pending.delete(query.get('state'));
  const code = query.get('code');
  if (!code) {
    const why = query.get('error_description') || query.get('error') || 'no code came back';
    p.settle.reject(new Error(why));
    return { ok: false, name: p.name, message: why };
  }
  try {
    const t = await tokenRequest(p.meta, p.client, { grant_type: 'authorization_code', code, redirect_uri: p.redirect, code_verifier: p.verifier, resource: p.meta.resource });
    save(p.name, () => ({ issuer: p.meta.issuer, meta: p.meta, client: p.client, ...tokensFrom(t), connectedAt: Date.now() }));
    log(`connectors: signed in to ${p.name}`);
    p.settle.resolve({ name: p.name });
    return { ok: true, name: p.name };
  } catch (err) {
    log(`connectors: sign-in to ${p.name} failed: ${err.message}`);
    p.settle.reject(err);
    return { ok: false, name: p.name, message: err.message };
  }
}

const renewing = new Map();
// A token for the connector, renewed first when it's about to run out. null when not signed in.
async function accessToken(name, { force = false } = {}) {
  const s = saved(name);
  if (!s || !s.accessToken) return null;
  if (!force && (!s.expiresAt || s.expiresAt - Date.now() > 60000)) return s.accessToken;
  if (!s.refreshToken) return force ? null : s.accessToken;
  if (renewing.has(key(name))) return renewing.get(key(name));
  const job = (async () => {
    try {
      const t = await tokenRequest(s.meta, s.client, { grant_type: 'refresh_token', refresh_token: s.refreshToken, resource: s.meta.resource });
      save(name, (before) => ({ ...before, ...tokensFrom(t, before) }));
      return t.access_token;
    } catch (err) {
      log(`connectors: ${name}: couldn't renew the sign-in (${err.message})`);
      if (err.code === 'invalid_grant') save(name, (before) => ({ ...before, accessToken: null, refreshToken: null }));
      return null;
    } finally {
      renewing.delete(key(name));
    }
  })();
  renewing.set(key(name), job);
  return job;
}

const connected = (name) => Boolean(saved(name) && saved(name).accessToken);

// Asks a connector for its tools, the way the app will: proof that it works end to end.
async function probe(url, headers) {
  const base = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers };
  const read = async (r) => {
    const text = await r.text();
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    try {
      return JSON.parse(line ? line.slice(5) : text);
    } catch {
      return null;
    }
  };
  try {
    let r = await fetch(url, { method: 'POST', headers: base, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-nonstop', version: '1' } } }) });
    if (r.status === 401 || r.status === 403) return { ok: false, status: r.status, why: 'the service refused the sign-in' };
    const init = await read(r);
    if (!init || init.error) return { ok: false, why: (init && init.error && init.error.message) || `HTTP ${r.status}` };
    const sid = r.headers.get('mcp-session-id');
    const h = { ...base, 'mcp-protocol-version': (init.result && init.result.protocolVersion) || '2025-06-18', ...(sid ? { 'mcp-session-id': sid } : {}) };
    await fetch(url, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }).then((x) => x.text()).catch(() => {});
    r = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    const list = await read(r);
    if (!list || list.error) return { ok: false, status: r.status, why: (list && list.error && list.error.message) || `HTTP ${r.status}` };
    return { ok: true, tools: (list.result && list.result.tools || []).length };
  } catch (err) {
    return { ok: false, why: err.message };
  }
}

module.exports = { discover, start, callback, accessToken, connected, saved, forget, clientFor, saveClient, redirectUri, probe };
