'use strict';

// The two services a line can belong to. Everything that differs between them lives here:
// how a key looks, where requests go, which headers a sign-in needs, what an answer means
// for the line that got it, and how much of a plan is used.
//
//   anthropic  Claude subscription sign-ins (Claude Code's own OAuth) and Claude API keys.
//              Speaks the Messages API.
//   openai     ChatGPT subscription sign-ins (Codex's own OAuth, see openai-auth.js) and
//              OpenAI API keys. Speaks the Responses API; a sign-in is taken only at the
//              Codex backend, as Codex.

const crypto = require('crypto');
const os = require('os');

const CODEX_VERSION = '0.164.0';
const CODEX_ORIGINATOR = 'codex_cli_rs';

function codexUserAgent() {
  const type = process.platform === 'darwin' ? 'Mac OS' : process.platform === 'win32' ? 'Windows' : 'Linux';
  return `${CODEX_ORIGINATOR}/${CODEX_VERSION} (${type} ${os.release()}; ${process.arch === 'arm64' ? 'arm64' : 'x86_64'}) unknown`;
}

const number = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// One usage window out of Codex's rate-limit headers: percent used and when it resets.
function codexWindow(headers, prefix) {
  const pct = number(headers[`${prefix}-used-percent`]);
  if (pct === null) return null;
  const resetAt = number(headers[`${prefix}-reset-at`]);
  const minutes = number(headers[`${prefix}-window-minutes`]);
  return { pct: Math.max(0, Math.min(100, Math.round(pct))), resetsAt: resetAt ? resetAt * 1000 : null, windowMinutes: minutes };
}

const anthropic = {
  id: 'anthropic',
  name: 'Anthropic',
  accountName: 'Claude account',
  keyName: 'Claude API key',
  wire: 'messages',
  defaultModel: 'claude-sonnet-5-5',
  probeModel: 'claude-haiku-5-5',
  keysUrl: 'https://platform.claude.com/settings/keys',
  billingUrl: 'https://platform.claude.com/settings/billing',
  models: [
    ['claude-fable-5-1', 'Claude Fable 5.1'],
    ['claude-opus-5-5', 'Claude Opus 5.5'],
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
    ['claude-haiku-5-5', 'Claude Haiku 5.5'],
  ],
  looksLikeKey: (key) => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key),
  keyProblem(key) {
    if (key.startsWith('sk-ant-oat')) return "that's a subscription sign-in token, not an API key. Add subscription accounts as accounts instead.";
    if (key.startsWith('sk-ant-admin')) return "that's an Admin API key, which can't send messages. Use a regular API key.";
    if (!anthropic.looksLikeKey(key)) return "that doesn't look like a Claude API key (they start with sk-ant-api).";
    return null;
  },
  upstream: (cfg) => cfg.upstream,
  // Where a request for this line goes, and the headers that identify it.
  keyTarget: (cfg, path) => `${cfg.upstream}${path}`,
  keyHeaders: (key) => ({ 'x-api-key': key }),
  // What one answer means for an API key.
  classify(status, body) {
    if (status >= 200 && status < 300) return 'ok';
    if (status === 401 || status === 402 || status === 403) return 'used-up';
    if (status === 400) return /credit balance|usage limit|spend limit/i.test(String(body)) ? 'used-up' : 'keep';
    return 'keep';
  },
  errorMessage(body) {
    try {
      return JSON.parse(body).error.message || '';
    } catch {
      return '';
    }
  },
};

const openai = {
  id: 'openai',
  name: 'OpenAI',
  accountName: 'ChatGPT account',
  keyName: 'OpenAI API key',
  wire: 'responses',
  defaultModel: 'gpt-5.5',
  probeModel: 'gpt-5.5',
  keysUrl: 'https://platform.openai.com/api-keys',
  billingUrl: 'https://platform.openai.com/settings/organization/billing/overview',
  apiUrl: 'https://api.openai.com/v1',
  chatgptUrl: 'https://chatgpt.com/backend-api/codex',
  models: [
    ['gpt-5.5', 'GPT-5.5'],
    ['gpt-5.4', 'GPT-5.4'],
    ['gpt-5.4-mini', 'GPT-5.4 mini'],
    ['gpt-5.3-codex', 'GPT-5.3 Codex'],
    ['gpt-5.2', 'GPT-5.2'],
  ],
  looksLikeKey: (key) => /^sk-[A-Za-z0-9_-]{20,}$/.test(key) && !/^sk-ant-/.test(key),
  keyProblem(key) {
    if (/^sk-ant-/.test(key)) return "that's a Claude key; add it as an Anthropic key.";
    if (!openai.looksLikeKey(key)) return "that doesn't look like an OpenAI API key (they start with sk-).";
    return null;
  },
  upstream: (cfg) => process.env.CLAUDE_NONSTOP_OPENAI_UPSTREAM || cfg.openaiUpstream || openai.apiUrl,
  chatgptUpstream: (cfg) => process.env.CLAUDE_NONSTOP_CHATGPT_UPSTREAM || cfg.chatgptUpstream || openai.chatgptUrl,
  keyTarget: (cfg, path) => `${openai.upstream(cfg)}${path}`,
  keyHeaders: (key) => ({ authorization: `Bearer ${key}` }),
  // A ChatGPT sign-in is taken only at the Codex backend, with Codex's identity.
  accountHeaders(creds) {
    const out = {
      authorization: `Bearer ${creds.accessToken}`,
      originator: CODEX_ORIGINATOR,
      'user-agent': codexUserAgent(),
      'openai-beta': 'responses=experimental',
      session_id: crypto.randomUUID(),
      accept: 'text/event-stream',
    };
    if (creds.accountId) out['chatgpt-account-id'] = creds.accountId;
    return out;
  },
  classify(status, body) {
    if (status >= 200 && status < 300) return 'ok';
    if (status === 401 || status === 402 || status === 403) return 'used-up';
    if (status === 429) return /insufficient_quota|billing|exceeded your current quota/i.test(String(body)) ? 'used-up' : 'keep';
    return 'keep';
  },
  errorMessage(body) {
    try {
      const j = JSON.parse(body);
      return (j.error && (j.error.message || j.error.code)) || (typeof j.detail === 'string' ? j.detail : j.detail && j.detail.message) || '';
    } catch {
      return '';
    }
  },
  // Codex's rate-limit headers, as this gateway shows usage: the 5-hour window and the week.
  usageFromHeaders(headers) {
    const primary = codexWindow(headers, 'x-codex-primary');
    const secondary = codexWindow(headers, 'x-codex-secondary');
    if (!primary && !secondary) return null;
    const out = {};
    // Codex names them primary and secondary; the shorter window is the session.
    const [short, long] = primary && secondary && (primary.windowMinutes || 0) > (secondary.windowMinutes || 0) ? [secondary, primary] : [primary, secondary];
    if (short) out.session = { pct: short.pct, resetsAt: short.resetsAt };
    if (long) out.week = { pct: long.pct, resetsAt: long.resetsAt };
    return out;
  },
  // Whether a refusal from the Codex backend means the account is at its limit.
  isLimit: (status, body, headers) => status === 429 && (/usage_limit|rate_limit|limit/i.test(String(body)) || Boolean(headers['x-codex-rate-limit-reached-type'])),
};

const PROVIDERS = { anthropic, openai };

const byId = (id) => PROVIDERS[id] || anthropic;

// The provider a key belongs to, from the key alone (null when it's neither).
function providerForKey(key) {
  if (anthropic.looksLikeKey(key)) return anthropic;
  if (openai.looksLikeKey(key)) return openai;
  return null;
}

// The provider a line is on: saved on the entry, Anthropic for entries from before there
// were two.
const of = (item) => byId(item && item.provider);

module.exports = { anthropic, openai, PROVIDERS, byId, of, providerForKey, CODEX_VERSION, codexUserAgent };
