'use strict';

// Signing in to a ChatGPT account the way Codex does: OpenAI's own sign-in page, with
// Codex's public OAuth client, through a short-lived page on this computer that catches
// the redirect. The sign-in (access, refresh and id tokens) is kept in the vault, encrypted
// like your API keys, and renewed with its refresh token before it runs out. A sign-in
// Codex already made (~/.codex/auth.json) can be taken over instead of signing in again.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vault = require('./vault');
const { request } = require('./http');
const { log } = require('./files');

// Read when used, so a test or an override set after loading still applies.
const issuer = () => process.env.CLAUDE_NONSTOP_OPENAI_ISSUER || 'https://auth.openai.com';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const PORTS = [1455, 1457];
const SCOPE = 'openid profile email offline_access';
const RENEW_BEFORE_MS = 5 * 60000;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// The claims Codex reads from the id token: who the account is and what plan it's on.
function claims(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    const auth = payload['https://api.openai.com/auth'] || {};
    const profile = payload['https://api.openai.com/profile'] || {};
    return {
      email: payload.email || profile.email || null,
      accountId: auth.chatgpt_account_id || null,
      plan: auth.chatgpt_plan_type || null,
      userId: auth.chatgpt_user_id || auth.user_id || null,
    };
  } catch {
    return { email: null, accountId: null, plan: null, userId: null };
  }
}

const expiryOf = (jwt) => {
  try {
    const exp = JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8')).exp;
    return exp ? exp * 1000 : null;
  } catch {
    return null;
  }
};

// The sign-in as it's kept in the vault.
function credentials(tokens) {
  const c = claims(tokens.id_token);
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token || null,
    accountId: tokens.account_id || c.accountId,
    email: c.email,
    plan: c.plan,
    expiresAt: expiryOf(tokens.access_token),
    refreshedAt: Date.now(),
  };
}

// ---------------------------------------------------------------- the vault

const stored = (accountId) => vault.load().accounts[accountId] || null;

function store(accountId, creds) {
  vault.update((v) => {
    v.accounts[accountId] = creds;
  });
}

function forget(accountId) {
  vault.update((v) => {
    delete v.accounts[accountId];
  });
}

// ---------------------------------------------------------------- the token endpoint

async function tokenRequest(form, { json = false } = {}) {
  const body = json ? JSON.stringify(form) : new URLSearchParams(form).toString();
  const r = await request(`${issuer()}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded', accept: 'application/json', 'content-length': Buffer.byteLength(body), 'user-agent': require('./providers').codexUserAgent() },
    body,
    timeoutMs: 30000,
  });
  let parsed = null;
  try {
    parsed = JSON.parse(r.body);
  } catch {}
  if (r.status !== 200 || !parsed || !parsed.access_token) {
    const why = (parsed && (parsed.error_description || parsed.error)) || (r.status ? `HTTP ${r.status}` : r.body);
    const err = new Error(`OpenAI sign-in: ${why}`);
    err.status = r.status;
    err.code = parsed && parsed.error;
    throw err;
  }
  return parsed;
}

// Renews a sign-in with its refresh token and saves the result. Throws when OpenAI refuses
// (the account signed out everywhere, say), with `err.code === 'invalid_grant'` then.
async function refresh(accountId) {
  const creds = stored(accountId);
  if (!creds || !creds.refreshToken) throw new Error('no sign-in saved for this account');
  const tokens = await tokenRequest({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: creds.refreshToken, scope: 'openid profile email' }, { json: true });
  const next = credentials({ ...tokens, refresh_token: tokens.refresh_token || creds.refreshToken, id_token: tokens.id_token || creds.idToken, account_id: creds.accountId });
  store(accountId, next);
  log(`openai-auth: renewed the sign-in for ${accountId}`);
  return next;
}

// A sign-in that's good for the next few minutes, renewed first when it isn't.
async function current(accountId) {
  const creds = stored(accountId);
  if (!creds) return null;
  if (creds.expiresAt && creds.expiresAt - Date.now() < RENEW_BEFORE_MS) return refresh(accountId);
  return creds;
}

// ---------------------------------------------------------------- signing in

const SUCCESS_PAGE = `<!doctype html><meta charset="utf-8"><title>Signed in</title>
<body style="font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:32em;margin:4em auto;padding:0 1em;color:#222">
<h1 style="font-size:1.4em">Signed in to ChatGPT</h1><p>This account now joins your claude-nonstop relay. You can close this tab.</p></body>`;
const FAIL_PAGE = (why) => `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title>
<body style="font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:32em;margin:4em auto;padding:0 1em;color:#222">
<h1 style="font-size:1.4em">Sign-in didn't finish</h1><p>${String(why).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p><p>Go back to claude-nonstop and try again.</p></body>`;

function listenOn(server, ports) {
  return new Promise((resolve, reject) => {
    const tryPort = (i) => {
      if (i >= ports.length) {
        reject(new Error(`ports ${ports.join(' and ')} are both in use (is Codex signing in right now?)`));
        return;
      }
      server.once('error', () => tryPort(i + 1));
      server.listen(ports[i], '127.0.0.1', () => {
        server.removeAllListeners('error');
        resolve(ports[i]);
      });
    };
    tryPort(0);
  });
}

// Starts a sign-in: opens a page on this computer for the redirect and returns the address
// to open in the browser, plus a promise that settles with the saved sign-in.
async function startLogin(accountId, { timeoutMs = 15 * 60000 } = {}) {
  const verifier = b64url(crypto.randomBytes(64));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(32));
  let settle;
  const done = new Promise((resolve, reject) => (settle = { resolve, reject }));
  const server = http.createServer();
  const port = await listenOn(server, PORTS);
  const redirectUri = `http://localhost:${port}/auth/callback`;
  const finish = (err, creds) => {
    clearTimeout(timer);
    server.close();
    if (err) settle.reject(err);
    else settle.resolve(creds);
  };
  const timer = setTimeout(() => finish(new Error('the sign-in was left open too long')), timeoutMs);
  server.on('request', async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const reply = (status, html) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
      res.end(html);
    };
    if (url.pathname !== '/auth/callback') {
      reply(404, FAIL_PAGE('Not found.'));
      return;
    }
    if (url.searchParams.get('state') !== state) {
      reply(400, FAIL_PAGE('The sign-in came back with the wrong state; it may belong to another attempt.'));
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      const why = url.searchParams.get('error_description') || url.searchParams.get('error') || 'no code came back';
      reply(400, FAIL_PAGE(why));
      finish(new Error(why));
      return;
    }
    try {
      const tokens = await tokenRequest({ grant_type: 'authorization_code', client_id: CLIENT_ID, code, redirect_uri: redirectUri, code_verifier: verifier });
      const creds = credentials(tokens);
      store(accountId, creds);
      log(`openai-auth: signed in ${accountId}${creds.email ? ` as ${creds.email}` : ''}${creds.plan ? ` (${creds.plan})` : ''}`);
      reply(200, SUCCESS_PAGE);
      finish(null, creds);
    } catch (err) {
      reply(502, FAIL_PAGE(err.message));
      finish(err);
    }
  });
  const auth = new URL(`${issuer()}/oauth/authorize`);
  for (const [k, v] of Object.entries({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'codex_cli_rs',
  })) auth.searchParams.set(k, v);
  return { url: auth.toString(), port, done, cancel: () => finish(new Error('sign-in cancelled')) };
}

// ---------------------------------------------------------------- Codex's own sign-in

const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const codexAuthFile = () => path.join(codexHome(), 'auth.json');

// The sign-in Codex keeps on this computer, if there is one and it's a ChatGPT sign-in.
function readCodexAuth(file = codexAuthFile()) {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const t = j && j.tokens;
  if (!t || !t.access_token || !t.refresh_token) return null;
  return credentials({ access_token: t.access_token, refresh_token: t.refresh_token, id_token: t.id_token, account_id: t.account_id });
}

// Takes Codex's sign-in over for an account (a copy: Codex keeps its own).
function importCodexAuth(accountId, file) {
  const creds = readCodexAuth(file);
  if (!creds) throw new Error(`no ChatGPT sign-in found in ${file || codexAuthFile()}. Run \`codex login\` first, or sign in here instead.`);
  store(accountId, creds);
  return creds;
}

const describe = (creds) => (!creds ? 'not signed in' : `${creds.email || 'signed in'}${creds.plan ? ` (${creds.plan})` : ''}`);

module.exports = { CLIENT_ID, issuer, claims, credentials, stored, store, forget, refresh, current, startLogin, readCodexAuth, importCodexAuth, codexAuthFile, describe };
