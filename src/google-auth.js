'use strict';

// Signing in to a Google account for Gemini the way Gemini CLI does: Google's own sign-in
// page with Gemini CLI's public OAuth client (an "installed application" client, whose secret
// Google says is not secret), through a short-lived page on this computer that catches the
// redirect. Requests then go to Gemini Code Assist, the service Gemini CLI uses, under the
// account's own plan: the free tier, Google AI Pro / Ultra, or a Code Assist licence. The
// sign-in is kept in the vault like a ChatGPT one and renewed with its refresh token. A
// sign-in Gemini CLI saved in a file (~/.gemini/oauth_creds.json) can be taken over instead.
// Gemini CLI itself has to be installed for a sign-in: its OAuth client is read from it.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vault = require('./vault');
const { request } = require('./http');
const { log } = require('./files');

// Gemini CLI's OAuth client, read from the Gemini CLI installed on this computer (it is in its
// published code; Google treats an installed app's client secret as public), so this
// repository doesn't carry a copy. CLAUDE_NONSTOP_GOOGLE_CLIENT_ID / _SECRET override it.
let client = null;
function geminiCliRoots() {
  const roots = [];
  const bins = [...String(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', path.join(process.env.APPDATA || '', 'npm')];
  for (const dir of bins) {
    for (const name of ['gemini', 'gemini.cmd']) {
      try {
        let p = fs.realpathSync(path.join(dir, name));
        for (let i = 0; i < 6 && p !== path.dirname(p); i++) {
          p = path.dirname(p);
          if (fs.existsSync(path.join(p, 'package.json')) && /"name":\s*"@google\/gemini-cli"/.test(fs.readFileSync(path.join(p, 'package.json'), 'utf8'))) {
            roots.push(p);
            break;
          }
        }
      } catch {}
    }
    // npm on Windows puts the package beside the shim.
    const beside = path.join(dir, 'node_modules', '@google', 'gemini-cli');
    if (fs.existsSync(beside)) roots.push(beside);
  }
  return [...new Set(roots)];
}
function findClient() {
  if (process.env.CLAUDE_NONSTOP_GOOGLE_CLIENT_ID) return { id: process.env.CLAUDE_NONSTOP_GOOGLE_CLIENT_ID, secret: process.env.CLAUDE_NONSTOP_GOOGLE_CLIENT_SECRET || '' };
  if (client) return client;
  for (const root of geminiCliRoots()) {
    const files = [];
    const walk = (dir, depth) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {}
      for (const e of entries) {
        if (e.isDirectory() && depth < 4 && e.name !== 'node_modules') walk(path.join(dir, e.name), depth + 1);
        else if (/\.m?js$/.test(e.name)) files.push(path.join(dir, e.name));
      }
    };
    for (const sub of ['bundle', 'dist', 'node_modules/@google/gemini-cli-core/dist']) walk(path.join(root, sub), 0);
    for (const f of files) {
      let text;
      try {
        text = fs.readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      const id = (text.match(/OAUTH_CLIENT_ID\s*=\s*["'`]([\w-]+\.apps\.googleusercontent\.com)["'`]/) || [])[1];
      const secret = (text.match(/OAUTH_CLIENT_SECRET\s*=\s*["'`]([\w-]+)["'`]/) || [])[1];
      if (id && secret) return (client = { id, secret });
    }
  }
  throw new Error('signing in to a Gemini account needs Gemini CLI on this computer: install it with `npm install -g @google/gemini-cli`, then try again. Gemini API keys work without it.');
}
const SCOPE = ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'].join(' ');
const authUrl = () => process.env.CLAUDE_NONSTOP_GOOGLE_AUTH || 'https://accounts.google.com/o/oauth2/v2/auth';
const tokenUrl = () => process.env.CLAUDE_NONSTOP_GOOGLE_TOKEN || 'https://oauth2.googleapis.com/token';
const codeAssist = () => process.env.CLAUDE_NONSTOP_CODE_ASSIST || 'https://cloudcode-pa.googleapis.com/v1internal';
const RENEW_BEFORE_MS = 5 * 60000;
const GEMINI_CLI_VERSION = '0.40.0';
const userAgent = () => `GeminiCLI/${GEMINI_CLI_VERSION} (${process.platform}; ${process.arch})`;
const META = { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' };

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const emailOf = (idToken) => {
  try {
    return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')).email || null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- the vault

const stored = (accountId) => vault.load().accounts[accountId] || null;
const store = (accountId, creds) => vault.update((v) => (v.accounts[accountId] = creds));
const forget = (accountId) => vault.update((v) => delete v.accounts[accountId]);

function credentials(tokens, before = {}) {
  return {
    google: true,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || before.refreshToken,
    idToken: tokens.id_token || before.idToken || null,
    email: emailOf(tokens.id_token) || before.email || null,
    expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : tokens.expiry_date || null,
    projectId: before.projectId || null,
    tier: before.tier || null,
    refreshedAt: Date.now(),
  };
}

async function tokenRequest(form) {
  const c = findClient();
  const body = new URLSearchParams({ client_id: c.id, client_secret: c.secret, ...form }).toString();
  const r = await request(tokenUrl(), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'content-length': Buffer.byteLength(body) }, body, timeoutMs: 30000 });
  let j = null;
  try {
    j = JSON.parse(r.body);
  } catch {}
  if (r.status !== 200 || !j || !j.access_token) {
    const err = new Error(`Google sign-in: ${(j && (j.error_description || j.error)) || `HTTP ${r.status}`}`);
    err.code = j && j.error;
    throw err;
  }
  return j;
}

async function refresh(accountId) {
  const creds = stored(accountId);
  if (!creds || !creds.refreshToken) throw new Error('no sign-in saved for this account');
  const next = credentials(await tokenRequest({ grant_type: 'refresh_token', refresh_token: creds.refreshToken }), creds);
  store(accountId, next);
  log(`google-auth: renewed the sign-in for ${accountId}`);
  return next;
}

// ---------------------------------------------------------------- Code Assist

async function codeAssistCall(method, token, body) {
  const r = await request(`${codeAssist()}:${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': userAgent() },
    body: JSON.stringify(body),
    timeoutMs: 30000,
  });
  let j = null;
  try {
    j = JSON.parse(r.body);
  } catch {}
  if (r.status !== 200) throw new Error(`Gemini Code Assist ${method}: ${(j && j.error && j.error.message) || `HTTP ${r.status}`}`);
  return j || {};
}

// The Code Assist project the account's requests are billed to, set up the first time the
// way Gemini CLI does it: the account's own, or a Google-managed one on the free tier.
async function setUp(accountId, creds) {
  if (creds.projectId) return creds;
  const load = await codeAssistCall('loadCodeAssist', creds.accessToken, { metadata: META });
  let projectId = load.cloudaicompanionProject || null;
  let tier = (load.paidTier && load.paidTier.name) || (load.currentTier && load.currentTier.name) || null;
  if (!projectId) {
    const t = (load.allowedTiers || []).find((x) => x.isDefault) || { id: 'free-tier' };
    tier = t.name || tier;
    let op = await codeAssistCall('onboardUser', creds.accessToken, { tierId: t.id, metadata: META });
    for (let i = 0; !op.done && op.name && i < 12; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const r = await request(`${codeAssist()}/${op.name}`, { headers: { authorization: `Bearer ${creds.accessToken}`, 'user-agent': userAgent() }, timeoutMs: 30000 });
      try {
        op = JSON.parse(r.body);
      } catch {}
    }
    projectId = op.response && op.response.cloudaicompanionProject && op.response.cloudaicompanionProject.id;
    if (!projectId) throw new Error('Gemini Code Assist did not set up a project for this account. Set one up with Gemini CLI first (run `gemini` and sign in).');
  }
  const next = { ...creds, projectId, tier };
  store(accountId, next);
  log(`google-auth: ${accountId} uses Code Assist project ${projectId}${tier ? ` (${tier})` : ''}`);
  return next;
}

// A sign-in good for the next few minutes with its project, renewed or set up first.
async function current(accountId) {
  let creds = stored(accountId);
  if (!creds) return null;
  if (!creds.expiresAt || creds.expiresAt - Date.now() < RENEW_BEFORE_MS) creds = await refresh(accountId);
  return setUp(accountId, creds);
}

// How much of each model's quota is left: { modelId: { pct used, resetsAt } }.
async function quota(creds) {
  const j = await codeAssistCall('retrieveUserQuota', creds.accessToken, { project: creds.projectId });
  const out = {};
  for (const b of j.buckets || []) {
    if (!b.modelId || typeof b.remainingFraction !== 'number') continue;
    out[b.modelId] = { pct: Math.round((1 - b.remainingFraction) * 100), resetsAt: b.resetTime ? Date.parse(b.resetTime) : null };
  }
  return out;
}

// ---------------------------------------------------------------- signing in

const page = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:32em;margin:4em auto;padding:0 1em;color:#222">
<h1 style="font-size:1.4em">${title}</h1><p>${String(text).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p></body>`;

async function startLogin(accountId, { timeoutMs = 15 * 60000 } = {}) {
  const verifier = b64url(crypto.randomBytes(64));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(32));
  let settle;
  const done = new Promise((resolve, reject) => (settle = { resolve, reject }));
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const finish = (err, creds) => {
    clearTimeout(timer);
    server.close();
    if (err) settle.reject(err);
    else settle.resolve(creds);
  };
  const timer = setTimeout(() => finish(new Error('the sign-in was left open too long')), timeoutMs);
  server.on('request', async (req, res) => {
    const url = new URL(req.url, redirectUri);
    const reply = (status, html) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
      res.end(html);
    };
    if (url.pathname !== '/oauth2callback') return reply(404, page('Not found', 'Not found.'));
    if (url.searchParams.get('state') !== state) return reply(400, page("Sign-in didn't finish", 'The sign-in came back with the wrong state; it may belong to another attempt.'));
    const code = url.searchParams.get('code');
    if (!code) {
      const why = url.searchParams.get('error_description') || url.searchParams.get('error') || 'no code came back';
      reply(400, page("Sign-in didn't finish", why));
      return finish(new Error(why));
    }
    try {
      let creds = credentials(await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }));
      store(accountId, creds);
      creds = await setUp(accountId, creds);
      log(`google-auth: signed in ${accountId}${creds.email ? ` as ${creds.email}` : ''}`);
      reply(200, page('Signed in to Gemini', 'This Google account now joins your claude-nonstop relay. You can close this tab.'));
      finish(null, creds);
    } catch (err) {
      reply(502, page("Sign-in didn't finish", err.message));
      finish(err);
    }
  });
  const auth = new URL(authUrl());
  for (const [k, v] of Object.entries({ client_id: findClient().id, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256', state })) auth.searchParams.set(k, v);
  return { url: auth.toString(), port, done, cancel: () => finish(new Error('sign-in cancelled')) };
}

// ---------------------------------------------------------------- Gemini CLI's own sign-in

const geminiCliFile = () => path.join(process.env.GEMINI_CLI_HOME || path.join(os.homedir(), '.gemini'), 'oauth_creds.json');

function readGeminiCli(file = geminiCliFile()) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && j.refresh_token ? credentials(j) : null;
  } catch {
    return null;
  }
}

function importGeminiCli(accountId, file) {
  const creds = readGeminiCli(file);
  if (!creds) throw new Error(`no Google sign-in found in ${file || geminiCliFile()}. Sign in here instead.`);
  store(accountId, creds);
  return creds;
}

const describe = (creds) => (!creds ? 'not signed in' : `${creds.email || 'signed in'}${creds.tier ? ` (${creds.tier})` : ''}`);

module.exports = { findClient, stored, store, forget, refresh, current, setUp, quota, startLogin, readGeminiCli, importGeminiCli, geminiCliFile, describe, userAgent, codeAssist };
