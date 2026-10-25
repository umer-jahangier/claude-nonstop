'use strict';

// How a remote MCP server signs users in, found the way the Claude desktop app finds it:
// ask the server, follow its protected-resource metadata to its authorization server, and
// read that server's metadata. Returns { auth, issuer }:
//   'oauth'        the app can register itself (dynamic client registration): just works
//   'needs-client' sign-in needs an OAuth client registered with the provider (a Client ID)
//   'none'         no sign-in at all
//   'no-metadata'  asks for sign-in but publishes no OAuth metadata the app can use
//   'redirects' / 'unreachable'  the address isn't the server's final https address

const TIMEOUT = 12000;

async function get(url, init = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    return await fetch(url, { redirect: 'manual', ...init, signal: ctl.signal, headers: { 'user-agent': 'claude-nonstop connector check', ...(init.headers || {}) } });
  } finally {
    clearTimeout(t);
  }
}

async function json(url) {
  try {
    const r = await get(url, { headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

const wellKnown = (base, name) => {
  const u = new URL(base);
  const p = u.pathname.replace(/\/$/, '');
  return p ? [`${u.origin}/.well-known/${name}${p}`, `${u.origin}/.well-known/${name}`] : [`${u.origin}/.well-known/${name}`];
};

async function authServerMeta(issuer) {
  for (const url of [...wellKnown(issuer, 'oauth-authorization-server'), ...wellKnown(issuer, 'openid-configuration')]) {
    const m = await json(url);
    if (m && (m.authorization_endpoint || m.token_endpoint)) return m;
  }
  return null;
}

const transportFor = (url) => (/\/sse\/?$/.test(new URL(url).pathname) ? 'sse' : 'http');

async function check(url, transport = transportFor(url)) {
  let r;
  try {
    r = transport === 'sse'
      ? await get(url, { headers: { accept: 'text/event-stream' } })
      : await get(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-nonstop', version: '1' } } }),
        });
  } catch {
    return { auth: 'unreachable', issuer: null };
  }
  try {
    if (r.body) r.body.cancel();
  } catch {}
  if (r.status >= 300 && r.status < 400) return { auth: 'redirects', issuer: null };
  if (r.status !== 401 && r.status !== 403) return { auth: r.status < 500 ? 'none' : 'unreachable', issuer: null };
  let resource = null;
  const hint = (r.headers.get('www-authenticate') || '').match(/resource_metadata="([^"]+)"/);
  if (hint) resource = await json(hint[1]);
  if (!resource) for (const u of wellKnown(url, 'oauth-protected-resource')) if ((resource = await json(u))) break;
  const declared = resource && Array.isArray(resource.authorization_servers) && resource.authorization_servers[0];
  const meta = await authServerMeta(declared || new URL(url).origin);
  if (!meta) return { auth: 'no-metadata', issuer: null };
  return { auth: meta.registration_endpoint ? 'oauth' : 'needs-client', issuer: meta.issuer || declared || new URL(url).origin };
}

// A few directory entries carry a credential in their address (an API key as a query value).
// Those aren't republished: the key is the provider's to hand out, and secret scanning
// rightly refuses it.
function carriesCredential(url) {
  for (const [name, value] of new URL(url).searchParams) {
    if (/key|token|secret|auth|signature|tracker/i.test(name) || /^[A-Za-z0-9_-]{24,}$/.test(value)) return true;
  }
  return false;
}

module.exports = { check, transportFor, carriesCredential };
