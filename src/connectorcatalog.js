'use strict';

// The connectors the gateway page offers with one click: the most used services first
// (FEATURED), then Anthropic's public directory (src/directory.json). claude-nonstop signs in
// to each itself (mcpauth.js) or keeps its access token, and the desktop app reaches every
// connector that needs a sign-in through the gateway (mcpproxy.js), which adds it. So a
// connector works in the app as soon as it's connected here, whatever the service.
//
// How a catalog entry signs in:
//   oauth         the service's own sign-in page; claude-nonstop registers itself
//   oauth-client  the service's own sign-in page, with an OAuth app you register once
//                 (Google, Slack, HubSpot don't let apps register themselves)
//   token         an access token or API key you paste (or a sign-in already on this computer)
//   none          nothing

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const directory = require('./directory.json');
const { carriesCredential } = require('./connectorcheck');

const GOOGLE_HELP = 'One Google OAuth app serves Gmail, Drive and Calendar. In console.cloud.google.com: pick or create a project; enable the Gmail, Google Drive and Google Calendar APIs; under Google Auth Platform set up the consent screen and add your address as a test user; then Clients → Create client → Desktop app. Paste its client ID and secret here.';

const FEATURED = [
  { slug: 'github', name: 'GitHub', description: 'Repositories, issues, pull requests, Actions and code search', author: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', auth: 'token', tokenFrom: 'gh', tokenLabel: 'GitHub personal access token', tokenHint: 'Create one at github.com/settings/personal-access-tokens. Signed in to the GitHub CLI (gh auth login)? Leave this empty: your sign-in is used.', categories: ['developer-tools'] },
  { slug: 'gmail', name: 'Gmail', description: 'Search, read, draft and organise email (Google\'s official server)', author: 'Google', url: 'https://gmailmcp.googleapis.com/mcp/v1', auth: 'oauth-client', clientIssuer: 'https://accounts.google.com/', clientHelp: GOOGLE_HELP, clientUrl: 'https://console.cloud.google.com/auth/clients', categories: ['communication', 'productivity'] },
  { slug: 'google-drive', name: 'Google Drive', description: 'Find, read and create files in Drive (Google\'s official server)', author: 'Google', url: 'https://drivemcp.googleapis.com/mcp/v1', auth: 'oauth-client', clientIssuer: 'https://accounts.google.com/', clientHelp: GOOGLE_HELP, clientUrl: 'https://console.cloud.google.com/auth/clients', categories: ['productivity'] },
  { slug: 'google-calendar', name: 'Google Calendar', description: 'Events, availability and scheduling (Google\'s official server)', author: 'Google', url: 'https://calendarmcp.googleapis.com/mcp/v1', auth: 'oauth-client', clientIssuer: 'https://accounts.google.com/', clientHelp: GOOGLE_HELP, clientUrl: 'https://console.cloud.google.com/auth/clients', categories: ['productivity'] },
  { slug: 'slack', name: 'Slack', description: 'Search and read channels, send messages, canvases (Slack\'s official server)', author: 'Slack', url: 'https://mcp.slack.com/mcp', auth: 'oauth-client', clientIssuer: 'https://mcp.slack.com', clientHelp: 'At api.slack.com/apps create an app for your workspace. Under OAuth & Permissions add the redirect URL shown below and the user scopes you want (search:read.public, channels:history, chat:write…), then copy the client ID and secret from Basic Information.', clientUrl: 'https://api.slack.com/apps', categories: ['communication'] },
  { slug: 'n8n', name: 'n8n', multi: true, description: 'Run and manage your n8n workflows', author: 'n8n', url: null, askUrl: true, urlLabel: 'MCP server URL', urlHint: 'In n8n: Settings → MCP Access (instance-level MCP). Copy the server URL, like https://your-n8n.example.com/mcp-server/http', auth: 'token', tokenLabel: 'n8n MCP access token', tokenHint: 'From the same n8n page: create or copy the MCP access token.', categories: ['productivity', 'developer-tools'] },
  { slug: 'highlevel', name: 'HighLevel', description: 'GoHighLevel (GHL): contacts, conversations, calendars, opportunities and more in your GHL account', author: 'HighLevel', url: 'https://services.leadconnectorhq.com/mcp/', auth: 'oauth', categories: ['sales-and-marketing'] },
  { slug: 'vercel', name: 'Vercel', description: 'Projects, deployments, logs and docs', author: 'Vercel', url: 'https://mcp.vercel.com/', auth: 'oauth', categories: ['developer-tools'] },
  { slug: 'cloudflare', name: 'Cloudflare', description: 'The whole Cloudflare API: DNS, Workers, R2, Zero Trust and more', author: 'Cloudflare', url: 'https://mcp.cloudflare.com/mcp', auth: 'oauth', categories: ['developer-tools'] },
  { slug: 'cloudflare-bindings', name: 'Cloudflare Workers Bindings', description: 'Workers, KV, R2, D1 and Hyperdrive', author: 'Cloudflare', url: 'https://bindings.mcp.cloudflare.com/mcp', auth: 'oauth', categories: ['developer-tools'] },
  { slug: 'cloudflare-observability', name: 'Cloudflare Observability', description: 'Workers logs and analytics', author: 'Cloudflare', url: 'https://observability.mcp.cloudflare.com/mcp', auth: 'oauth', categories: ['developer-tools'] },
  { slug: 'notion', name: 'Notion', description: 'Search, read and edit your Notion pages and databases', author: 'Notion', url: 'https://mcp.notion.com/mcp', auth: 'oauth', categories: ['productivity'] },
  { slug: 'hubspot', name: 'HubSpot', description: 'CRM contacts, companies, deals and tickets', author: 'HubSpot', url: 'https://mcp.hubspot.com/anthropic', auth: 'oauth-client', clientIssuer: 'https://mcp.hubspot.com', clientHelp: 'In your HubSpot developer account create an MCP auth app (developers.hubspot.com/mcp), add the redirect URL shown below, and copy its client ID and secret.', clientUrl: 'https://developers.hubspot.com/mcp', categories: ['sales-and-marketing'] },
];
const TOKEN_SERVERS = FEATURED.filter((c) => c.auth === 'token' && c.url);

// "Made by Anthropic" connectors run on Anthropic's own servers and work only on Claude.ai
// sign-in, not when the desktop app runs on your own keys.
const usable = (c) => c.author !== 'Anthropic' && !carriesCredential(c.url);

function catalog() {
  const seen = new Set();
  const out = [];
  for (const c of [...FEATURED, ...directory.connectors.filter(usable)]) {
    const k = c.name.toLowerCase().replace(/\s*\(.*\)$/, '');
    if (seen.has(k) || (c.url && seen.has(c.url))) continue;
    seen.add(k);
    if (c.url) seen.add(c.url);
    const { slug, name, description = '', author = '', url, auth, categories = [] } = c;
    out.push({ slug, name, description, author, url, transport: c.transport || 'http', auth, categories, featured: FEATURED.includes(c), ...Object.fromEntries(['multi', 'tokenFrom', 'tokenLabel', 'tokenHint', 'askUrl', 'urlLabel', 'urlHint', 'clientIssuer', 'clientHelp', 'clientUrl'].filter((x) => c[x] !== undefined).map((x) => [x, c[x]])) });
  }
  return out;
}

const bySlug = (slug) => catalog().find((c) => c.slug === String(slug || '').toLowerCase() || c.name.toLowerCase() === String(slug || '').toLowerCase()) || null;
const sameUrl = (a, b) => String(a).replace(/\/+$/, '') === String(b).replace(/\/+$/, '');
const tokenServerFor = (url) => TOKEN_SERVERS.find((c) => sameUrl(c.url, url)) || null;

// The GitHub CLI, wherever it is: the desktop app runs helpers with a short PATH.
function findGh() {
  const dirs = [...String(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI')];
  for (const d of dirs) {
    if (!d) continue;
    for (const name of process.platform === 'win32' ? ['gh.exe'] : ['gh']) {
      const p = path.join(d, name);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return null;
}

function ghToken() {
  if (process.env.CLAUDE_NONSTOP_GH_TOKEN !== undefined) return process.env.CLAUDE_NONSTOP_GH_TOKEN || null;
  const gh = findGh();
  if (!gh) return null;
  const r = spawnSync(gh, ['auth', 'token', '--hostname', 'github.com'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  const t = r.status === 0 ? String(r.stdout || '').trim() : '';
  return /^[\w.-]{20,}$/.test(t) ? t : null;
}

const fromSignIn = { gh: ghToken };

// A connector's token: the one pasted for it, else the sign-in it can borrow.
function tokenFor(entry, v) {
  const saved = v && v.connectorTokens && v.connectorTokens[entry.name.toLowerCase()];
  if (saved) return saved;
  const from = entry.tokenFrom || (tokenServerFor(entry.url) || {}).tokenFrom;
  return from && fromSignIn[from] ? fromSignIn[from]() : null;
}

const fail = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

// How a saved connector signs in: 'token', 'oauth' (signed in here) or 'none'. Entries from
// before claude-nonstop signed in itself say `oauth: true`.
function authOf(entry) {
  if (!entry) return 'none';
  if (entry.auth === 'token' || tokenServerFor(entry.url)) return 'token';
  if (entry.auth === 'oauth' || entry.oauth) return 'oauth';
  return 'none';
}
const isTokenConnector = (entry) => authOf(entry) === 'token';
// Every connector that needs a sign-in goes through the gateway, unless it streams over SSE
// (whose stream names its own address to post to): then the app signs in itself.
const viaGateway = (entry) => authOf(entry) !== 'none' && (entry.transport || 'http') === 'http' && !entry.appSignIn;

function saveEntry(entry, token) {
  const config = require('./config');
  config.update((c) => (c.desktopConnectors = [...(c.desktopConnectors || []).filter((e) => !sameName(e.name, entry.name)), entry]));
  require('./vault').update((v) => {
    if (token) v.connectorTokens[entry.name.toLowerCase()] = token;
    else delete v.connectorTokens[entry.name.toLowerCase()];
  });
  return entry;
}

// Adds a connector: from the catalog by slug, or any server by name and address, whose
// sign-in is worked out by asking it. Returns the saved entry; one that signs in with
// OAuth then needs connect(). Throws with code 'needs-token' or 'needs-client' (and what
// to ask for) when something has to be entered first.
async function add({ slug, name, url, token, client, noAuth = false, oauth = false, label } = {}) {
  const desktop = require('./desktop');
  const mcpauth = require('./mcpauth');
  token = String(token || '').trim() || null;
  client = client && String(client.id || '').trim() ? { id: String(client.id).trim(), secret: String(client.secret || '').trim() || null } : null;
  if (slug) {
    const c = bySlug(slug);
    if (!c) throw new Error(`there's no connector called ${slug} in the catalog`);
    const address = c.askUrl ? String(url || '').trim() : c.url;
    if (c.askUrl && !address) throw fail(`${c.name} runs on your own server: enter its ${c.urlLabel || 'address'}. ${c.urlHint || ''}`.trim(), 'needs-url');
    // A service you may have several of (n8n instances, say): each gets its own name.
    let as = c.name;
    if (c.multi) {
      const list = require('./config').load().desktopConnectors || [];
      as = String(label || '').trim() || c.name;
      const taken = (n) => list.some((e) => sameName(e.name, n) && e.url !== address);
      for (let i = 2; taken(as); i++) as = `${String(label || '').trim() || c.name} ${i}`;
    }
    if (c.auth === 'token') {
      const entry = desktop.connector(as, address, { token: true, tokenFrom: c.tokenFrom, transport: c.transport });
      if (!token && !tokenFor(entry, null)) throw fail(`${c.name} signs in with an access token. ${c.tokenHint || 'Paste one to add it.'}`, 'needs-token');
      return saveEntry(entry, token);
    }
    if (c.auth === 'none') return saveEntry(desktop.connector(c.name, address, { oauth: false, transport: c.transport }), null);
    if (c.auth === 'oauth-client' && !client && !mcpauth.clientFor(c.clientIssuer)) {
      throw fail(`${c.name} needs an OAuth app you register once. ${c.clientHelp || ''}`.trim(), 'needs-client', { redirect: mcpauth.redirectUri(), clientUrl: c.clientUrl });
    }
    if (client && c.clientIssuer) mcpauth.saveClient(c.clientIssuer, client);
    return saveEntry({ ...desktop.connector(c.name, address, { transport: c.transport }), auth: 'oauth' }, null);
  }
  name = String(name || '').trim();
  url = String(url || '').trim();
  desktop.connector(name, url); // checks the name and address first
  const known = tokenServerFor(url);
  if (known) {
    const entry = desktop.connector(name, url, { token: true, tokenFrom: known.tokenFrom, transport: known.transport });
    if (!token && !tokenFor(entry, null)) throw fail(`${known.name} signs in with an access token. ${known.tokenHint}`, 'needs-token');
    return saveEntry(entry, token);
  }
  const { transportFor } = require('./connectorcheck');
  const transport = transportFor(url);
  if (token) return saveEntry(desktop.connector(name, url, { token: true, transport }), token);
  if (noAuth) return saveEntry(desktop.connector(name, url, { oauth: false, transport }), null);
  if (oauth) return saveEntry({ ...desktop.connector(name, url, { transport }), auth: 'oauth' }, null);
  const meta = await mcpauth.discover(url);
  if (meta) {
    if (!meta.registrationEndpoint && !client && !mcpauth.clientFor(meta.issuer)) {
      throw fail(`${name} doesn't let apps register themselves. Register an OAuth app with ${new URL(meta.issuer).hostname} and enter its client ID and secret, or paste an access token instead.`, 'needs-client', { redirect: mcpauth.redirectUri() });
    }
    if (client) mcpauth.saveClient(meta.issuer, client);
    return saveEntry({ ...desktop.connector(name, url, { transport }), auth: 'oauth' }, null);
  }
  const { check } = require('./connectorcheck');
  const r = await check(url, transport);
  if (r.auth === 'none') return saveEntry(desktop.connector(name, url, { oauth: false, transport }), null);
  if (r.auth === 'redirects') throw new Error(`${url} sends visitors elsewhere. Use the server's final address from its docs`);
  if (r.auth === 'unreachable') throw new Error(`couldn't reach ${url}. Check the address`);
  throw fail(`${name} asks for a sign-in but doesn't say how. Paste an access token or API key from ${new URL(url).hostname} to add it.`, 'needs-token');
}

// Starts the sign-in for a saved OAuth connector: the address to open in the browser, and a
// promise that settles when you're back.
async function connect(name, { client, switchAccount = false } = {}) {
  const entry = (require('./config').load().desktopConnectors || []).find((e) => sameName(e.name, name));
  if (!entry) throw new Error(`there is no connector called ${name}`);
  if (authOf(entry) !== 'oauth') throw new Error(`${entry.name} doesn't sign in with a browser`);
  const c = client && client.id ? { id: String(client.id).trim(), secret: String(client.secret || '').trim() || null } : null;
  const known = bySlug(entry.name);
  try {
    return await require('./mcpauth').start({ ...entry, scopes: known && known.scopes }, { client: c, fresh: switchAccount });
  } catch (err) {
    // A service that registers only apps it has approved (Figma, say): the Claude app, which
    // it may know, signs in to it itself instead.
    if (err.code === 'register-refused') {
      require('./config').update((cfg) => {
        const e = (cfg.desktopConnectors || []).find((x) => sameName(x.name, entry.name));
        if (e) e.appSignIn = true;
      });
      throw Object.assign(new Error(`${entry.name} only lets apps it has approved sign in, so claude-nonstop hands it to the Claude app: connect it from Claude's Connectors once the app has the new list`), { code: 'app-sign-in' });
    }
    throw err;
  }
}

// Puts another account on a token connector: a new token, and for a self-hosted service
// (n8n) a new address too. The connector keeps its name, so Claude sees no change but the account.
function replaceToken(name, { token, url } = {}) {
  const config = require('./config');
  const entry = (config.load().desktopConnectors || []).find((e) => sameName(e.name, name));
  if (!entry) throw new Error(`there is no connector called ${name}`);
  if (authOf(entry) !== 'token') throw new Error(`${entry.name} signs in with a browser: use Change Account to sign in as someone else`);
  token = String(token || '').trim();
  if (!token) throw new Error('paste the new access token');
  const next = { ...entry };
  if (url && String(url).trim() !== entry.url) next.url = require('./desktop').connector(entry.name, String(url).trim(), { token: true, transport: entry.transport }).url;
  return saveEntry(next, token);
}

function remove(name) {
  const config = require('./config');
  const found = (config.load().desktopConnectors || []).some((e) => sameName(e.name, name));
  config.update((c) => (c.desktopConnectors = (c.desktopConnectors || []).filter((e) => !sameName(e.name, name))));
  require('./vault').update((v) => delete v.connectorTokens[String(name).toLowerCase()]);
  require('./mcpauth').forget(name);
  return found;
}

// The Authorization header a connector's server gets, or null when it isn't signed in.
async function upstreamAuth(entry, v, { force = false } = {}) {
  if (authOf(entry) === 'token') {
    const t = tokenFor(entry, v);
    return t ? `Bearer ${t}` : null;
  }
  const t = await require('./mcpauth').accessToken(entry.name, { force });
  return t ? `Bearer ${t}` : null;
}

// What `claude-nonstop connectors headers <name>` prints for the desktop app: the gateway
// token for a connector reached through the gateway, else the connector's own token.
// viaGateway: the app's entry points at the gateway (its helper passes --via-gateway). An
// entry from an older profile that still points at the server itself gets the server's token.
function headers(name, { viaGateway: throughGateway = false } = {}) {
  const entry = (require('./config').load().desktopConnectors || []).find((e) => sameName(e.name, name));
  if (!entry) throw new Error(`there is no connector called ${name}`);
  const v = require('./vault').loadWithTokens();
  if (throughGateway && viaGateway(entry)) return { Authorization: `Bearer ${v.gatewayToken}` };
  const token = tokenFor(entry, v);
  if (!token) throw new Error(`${entry.name} has no access token: add it again with one${(entry.tokenFrom || (tokenServerFor(entry.url) || {}).tokenFrom) === 'gh' ? ', or sign in to the GitHub CLI (gh auth login)' : ''}`);
  return { Authorization: `Bearer ${token}` };
}

// How a saved connector stands, for listing it: 'none', 'token', 'gh', 'token-missing',
// 'connected' or 'needs-sign-in'.
function describeAuth(entry, v) {
  const a = authOf(entry);
  if (a === 'none') return 'none';
  if (a === 'oauth' && entry.appSignIn) return 'oauth';
  if (a === 'oauth') return viaGateway(entry) ? (require('./mcpauth').connected(entry.name) ? 'connected' : 'needs-sign-in') : 'oauth';
  if (v && v.connectorTokens && v.connectorTokens[entry.name.toLowerCase()]) return 'token';
  const from = entry.tokenFrom || (tokenServerFor(entry.url) || {}).tokenFrom;
  return from === 'gh' ? 'gh' : 'token-missing';
}

// Checks a saved connector the way the app will reach it: its tools, through its sign-in.
async function test(name) {
  const entry = (require('./config').load().desktopConnectors || []).find((e) => sameName(e.name, name));
  if (!entry) throw new Error(`there is no connector called ${name}`);
  const auth = authOf(entry) === 'none' ? 'none' : await upstreamAuth(entry, require('./vault').load());
  if (auth === null) return { ok: false, why: authOf(entry) === 'oauth' ? 'not signed in yet' : 'no access token' };
  let r = await require('./mcpauth').probe(entry.url, auth === 'none' ? {} : { authorization: auth });
  if (!r.ok && r.status === 401 && authOf(entry) === 'oauth') {
    const again = await upstreamAuth(entry, null, { force: true });
    if (again) r = await require('./mcpauth').probe(entry.url, { authorization: again });
  }
  return r;
}

module.exports = { catalog, bySlug, tokenServerFor, tokenFor, ghToken, add, connect, replaceToken, remove, headers, describeAuth, authOf, upstreamAuth, test, isTokenConnector, viaGateway, TOKEN_SERVERS, FEATURED };
