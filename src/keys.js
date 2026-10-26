'use strict';

// The API key pool: checking keys and picking the first one that works. A key belongs to
// one service (providers.js), told apart by how it looks.

const crypto = require('crypto');
const providers = require('./providers');
const { request } = require('./http');
const state = require('./state');
const { log } = require('./files');

const API_VERSION = '2026-10-21';

const fingerprint = (key) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
const mask = (key) => (key.length > 24 ? `${key.slice(0, 14)}…${key.slice(-4)}` : '••••••••');
const looksLikeKey = (key) => Boolean(providers.providerForKey(key));

// The provider's own message out of an error body.
const errorMessage = (body, provider = providers.anthropic) => provider.errorMessage(body);

// The smallest possible real request on a key, exactly how the gateway sends every request
// on it (gateway.js): plain API, no client identity, so credit that covers only API use
// (promotional credit, say) works too. An OpenAI key is checked against the free model list.
async function probe(key, cfg, provider = providers.providerForKey(key) || providers.anthropic) {
  if (provider.id === 'openai') {
    return request(`${providers.openai.upstream(cfg)}/models`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      timeoutMs: 20000,
    });
  }
  const body = JSON.stringify({ model: cfg.probeModel, max_tokens: 1, messages: [{ role: 'user', content: '.' }] });
  return request(`${cfg.upstream}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': API_VERSION,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
    body,
    timeoutMs: 20000,
  });
}

async function check(entry, cfg) {
  const provider = providers.of(entry);
  const { status, body } = await probe(entry.key, cfg, provider);
  const verdict = provider.classify(status, body);
  const detail = provider.errorMessage(body) || (status === 0 ? body : '');
  const result = { verdict, status, detail };
  state.recordKey(entry.id, result);
  return result;
}

// Returns the first key that works, skipping keys still cooling down after running out.
async function pick(entries, cfg) {
  for (const entry of entries) {
    if (state.isCoolingDown(entry.id, cfg.cooldownMinutes)) continue;
    const result = await check(entry, cfg);
    if (result.verdict !== 'used-up') {
      state.setCurrent(`API key: ${entry.label}`);
      return entry;
    }
    log(`key "${entry.label}" is used up (HTTP ${result.status}${result.detail ? `: ${result.detail}` : ''}), trying the next one`);
  }
  return null;
}

function newEntry(key, label, position) {
  const provider = providers.providerForKey(key) || providers.anthropic;
  return { id: fingerprint(key), label: label || `Key ${position}`, key, provider: provider.id, addedAt: new Date().toISOString() };
}

// Why a pasted value can't be saved as an API key, or null if it can.
function problemWith(key) {
  if (/^sk-ant-/.test(key)) return providers.anthropic.keyProblem(key);
  if (/^sk-/.test(key)) return providers.openai.keyProblem(key);
  return "that doesn't look like an API key: Claude keys start with sk-ant-api, OpenAI keys with sk-.";
}

module.exports = { API_VERSION, fingerprint, mask, looksLikeKey, problemWith, errorMessage, probe, check, pick, newEntry };
