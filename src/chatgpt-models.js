'use strict';

// The models a ChatGPT sign-in may use through the Codex backend. The backend serves only
// the models on its own list (asked for with the Codex client version it knows), and that
// list changes with no notice; a name from anywhere else is refused with "not supported when
// using Codex with a ChatGPT account". So the gateway asks each account for its list, keeps
// it for a while, and sends a listed model: the one asked for when it's there, else the
// account's own first choice.

const config = require('./config');
const state = require('./state');
const providers = require('./providers');
const { request } = require('./http');

const FRESH_MS = 60 * 60000;
const cache = new Map(); // account id -> { at, models: [{ slug, name, priority }] }

const NOT_SUPPORTED = /not supported when using Codex with a ChatGPT account/i;
const isModelRefusal = (status, text) => status === 400 && NOT_SUPPORTED.test(text || '');

function parse(body) {
  const j = JSON.parse(body);
  const list = (Array.isArray(j.models) ? j.models : [])
    .filter((m) => m && typeof m.slug === 'string' && m.visibility !== 'hide')
    .map((m) => ({ slug: m.slug, name: m.display_name || m.slug, priority: Number(m.priority) || 0 }))
    .sort((a, b) => a.priority - b.priority);
  if (!list.length) throw new Error('no models in the answer');
  return list;
}

// The account's list, fetched when there's none or it's old (or when `force`).
async function list(accountId, creds, cfg = config.load(), { force = false } = {}) {
  const had = cache.get(accountId);
  if (had && !force && Date.now() - had.at < FRESH_MS) return had.models;
  const r = await request(`${providers.openai.chatgptUpstream(cfg)}/models?client_version=${providers.CODEX_VERSION}`, {
    headers: { ...providers.openai.accountHeaders(creds), accept: 'application/json' },
    timeoutMs: 20000,
  });
  if (r.status !== 200) throw new Error(providers.openai.errorMessage(r.body) || `HTTP ${r.status}`);
  const models = parse(r.body);
  cache.set(accountId, { at: Date.now(), models });
  state.recordChatgptModels(accountId, models.map((m) => m.slug));
  return models;
}

// The model to send for this account: `wanted` when the backend lists it, else the first on
// the list. Without a list (the backend didn't answer), `wanted` goes as is.
async function pick(wanted, accountId, creds, cfg = config.load(), opts) {
  let models;
  try {
    models = await list(accountId, creds, cfg, opts);
  } catch {
    return wanted;
  }
  if (models.some((m) => m.slug === wanted)) return wanted;
  const preferred = cfg.models && cfg.models.chatgpt;
  if (preferred && models.some((m) => m.slug === preferred)) return preferred;
  return models[0].slug;
}

const known = (accountId) => (cache.get(accountId) || {}).models || null;
const forget = (accountId) => cache.delete(accountId);

module.exports = { list, pick, known, forget, isModelRefusal, parse, FRESH_MS };
