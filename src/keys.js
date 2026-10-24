'use strict';

// The API key pool: checking keys and picking the first one that works.

const crypto = require('crypto');
const { classifyResponse } = require('./classify');
const { request } = require('./http');
const state = require('./state');
const { log } = require('./files');

const API_VERSION = '2026-10-21';

const fingerprint = (key) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
const mask = (key) => (key.length > 24 ? `${key.slice(0, 14)}…${key.slice(-4)}` : '••••••••');
const looksLikeKey = (key) => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key);

function errorMessage(body) {
  try {
    return JSON.parse(body).error.message || '';
  } catch {
    return '';
  }
}

// The smallest possible real request: one output token from the cheapest model.
async function probe(key, cfg) {
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
  const { status, body } = await probe(entry.key, cfg);
  const result = {
    verdict: classifyResponse(status, body),
    status,
    detail: errorMessage(body) || (status === 0 ? body : ''),
  };
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
  return { id: fingerprint(key), label: label || `Key ${position}`, key, addedAt: new Date().toISOString() };
}

// Why a pasted value can't be saved as an API key, or null if it can.
function problemWith(key) {
  if (key.startsWith('sk-ant-oat')) return "that's a subscription sign-in token, not an API key. Add subscription accounts as accounts instead.";
  if (key.startsWith('sk-ant-admin')) return "that's an Admin API key, which can't send messages. Use a regular API key.";
  if (!looksLikeKey(key)) return "that doesn't look like a Claude API key (they start with sk-ant-api).";
  return null;
}

module.exports = { API_VERSION, fingerprint, mask, looksLikeKey, problemWith, errorMessage, probe, check, pick, newEntry };
