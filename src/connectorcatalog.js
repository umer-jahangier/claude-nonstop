'use strict';

// The connectors the gateway page offers with one click: Anthropic's public directory
// (src/directory.json, servers the desktop app signs in to by itself) plus a few well-known
// servers that sign in with an access token instead, which the app gets from claude-nonstop
// through a headers helper (`claude-nonstop connectors headers <name>`) each time it connects.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const directory = require('./directory.json');
const { carriesCredential } = require('./connectorcheck');

// Servers that take a token in an Authorization header. tokenFrom names a sign-in already on
// this computer that can supply the token, so nothing needs pasting.
const TOKEN_SERVERS = [
  {
    slug: 'github',
    name: 'GitHub',
    description: 'Repositories, issues, pull requests, Actions and code search',
    author: 'GitHub',
    url: 'https://api.githubcopilot.com/mcp/',
    transport: 'http',
    auth: 'token',
    tokenFrom: 'gh',
    tokenLabel: 'GitHub personal access token',
    tokenHint: 'Create one at github.com/settings/personal-access-tokens. Signed in to the GitHub CLI (gh auth login)? Leave this empty: your sign-in is used.',
    categories: ['developer-tools'],
  },
];

// "Made by Anthropic" connectors run on Anthropic's own servers and work only on Claude.ai
// sign-in, not when the desktop app runs on your own keys.
const usable = (c) => c.author !== 'Anthropic' && !carriesCredential(c.url);

function catalog() {
  const seen = new Set();
  const out = [];
  for (const c of [...TOKEN_SERVERS, ...directory.connectors.filter(usable)]) {
    const key = c.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ slug: c.slug, name: c.name, description: c.description || '', author: c.author || '', url: c.url, transport: c.transport, auth: c.auth, categories: c.categories || [], ...(c.auth === 'token' ? { tokenFrom: c.tokenFrom || null, tokenLabel: c.tokenLabel, tokenHint: c.tokenHint } : {}) });
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

const needsToken = (message) => Object.assign(new Error(message), { code: 'needs-token' });
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

// Adds a connector: from the catalog by slug, or any server by name and address. A server
// of unknown kind is asked how it signs in: by itself (OAuth the app registers for), not at
// all, or neither, in which case it takes an access token. A token given is kept in the
// vault, never in the app's settings. Returns the saved entry.
async function add({ slug, name, url, token, noAuth = false, oauth = false } = {}) {
  const desktop = require('./desktop');
  token = String(token || '').trim() || null;
  let entry;
  if (slug) {
    const c = bySlug(slug);
    if (!c) throw new Error(`there's no connector called ${slug} in the catalog`);
    if (c.auth === 'token') {
      entry = desktop.connector(c.name, c.url, { token: true, tokenFrom: c.tokenFrom, transport: c.transport });
      if (!token && !tokenFor(entry, null)) throw needsToken(`${c.name} signs in with an access token. ${c.tokenHint || 'Paste one to add it.'}`);
    } else {
      entry = desktop.connector(c.name, c.url, { oauth: c.auth === 'oauth', transport: c.transport });
    }
  } else {
    name = String(name || '').trim();
    url = String(url || '').trim();
    const known = tokenServerFor(url);
    if (known) {
      entry = desktop.connector(name, url, { token: true, tokenFrom: known.tokenFrom, transport: known.transport });
      if (!token && !tokenFor(entry, null)) throw needsToken(`${known.name} signs in with an access token. ${known.tokenHint}`);
    } else if (token) {
      entry = desktop.connector(name, url, { token: true });
    } else if (noAuth) {
      entry = desktop.connector(name, url, { oauth: false });
    } else if (oauth) {
      entry = desktop.connector(name, url);
    } else {
      desktop.connector(name, url); // checks the name and address first
      const { check, transportFor } = require('./connectorcheck');
      const transport = transportFor(url);
      const r = await check(url, transport);
      if (r.auth === 'oauth') entry = desktop.connector(name, url, { transport });
      else if (r.auth === 'none') entry = desktop.connector(name, url, { oauth: false, transport });
      else if (r.auth === 'needs-client' || r.auth === 'no-metadata') throw needsToken(`${name} doesn't let apps sign in to it by themselves. Paste an access token or API key from ${new URL(url).hostname} to add it.`);
      else if (r.auth === 'redirects') throw new Error(`${url} sends visitors elsewhere. Use the server's final address from its docs`);
      else throw new Error(`couldn't reach ${url}. Check the address`);
    }
  }
  const config = require('./config');
  config.update((c) => (c.desktopConnectors = [...(c.desktopConnectors || []).filter((e) => !sameName(e.name, entry.name)), entry]));
  require('./vault').update((v) => {
    if (token) v.connectorTokens[entry.name.toLowerCase()] = token;
    else delete v.connectorTokens[entry.name.toLowerCase()];
  });
  return entry;
}

function remove(name) {
  const config = require('./config');
  const found = (config.load().desktopConnectors || []).some((e) => sameName(e.name, name));
  config.update((c) => (c.desktopConnectors = (c.desktopConnectors || []).filter((e) => !sameName(e.name, name))));
  require('./vault').update((v) => delete v.connectorTokens[String(name).toLowerCase()]);
  return found;
}

// What `claude-nonstop connectors headers <name>` prints for the desktop app.
function headers(name) {
  const entry = (require('./config').load().desktopConnectors || []).find((e) => sameName(e.name, name));
  if (!entry) throw new Error(`there is no connector called ${name}`);
  const token = tokenFor(entry, require('./vault').load());
  if (!token) throw new Error(`${entry.name} has no access token: add it again with one${(entry.tokenFrom || (tokenServerFor(entry.url) || {}).tokenFrom) === 'gh' ? ', or sign in to the GitHub CLI (gh auth login)' : ''}`);
  return { Authorization: `Bearer ${token}` };
}

// How a saved connector signs in, for listing it.
function describeAuth(entry, v) {
  const tokenish = entry.auth === 'token' || tokenServerFor(entry.url);
  if (!tokenish) return entry.oauth ? 'oauth' : 'none';
  if (v && v.connectorTokens && v.connectorTokens[entry.name.toLowerCase()]) return 'token';
  const from = entry.tokenFrom || (tokenServerFor(entry.url) || {}).tokenFrom;
  return from === 'gh' ? 'gh' : 'token-missing';
}

module.exports = { catalog, bySlug, tokenServerFor, tokenFor, ghToken, add, remove, headers, describeAuth, TOKEN_SERVERS };
