'use strict';

// Each provider's models as its own API lists them, read with the first of your keys or
// sign-ins that can: Anthropic's /v1/models (a Claude account or key), OpenAI's /v1/models
// (a key) and the ChatGPT backend's own list (chatgpt-models.js), the Gemini API's model list
// (a key) and, for a Google account, the models Code Assist gives it a quota for. The lists
// are kept in state.json and refreshed every few hours, so the page's model pickers and the
// gateway's /v1/models offer what is available now, not a list frozen in a release. Until a
// provider has been read, its built-in list in providers.js stands in.

const providers = require('./providers');
const state = require('./state');
const config = require('./config');
const vault = require('./vault');
const { request } = require('./http');
const { log } = require('./files');

const STALE_MS = 6 * 3600000;

const json = (r) => {
  try {
    return r.status === 200 ? JSON.parse(r.body) : null;
  } catch {
    return null;
  }
};

// Chat models only: no embeddings, speech, images, moderation or realtime.
const NOT_CHAT = /embed|tts|audio|realtime|transcribe|image|dall-e|whisper|moderation|search|computer-use|live|veo|imagen|lyria|aqa|robotics|native-audio|babbage|davinci|instruct/i;

const pretty = (id) => id.replace(/^models\//, '').split('-').map((w) => (/^(gpt|gemini|claude|gemma)$/i.test(w) ? w[0].toUpperCase() + w.slice(1).replace(/^Gpt$/, 'GPT') : /^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1))).join(' ').replace(/^Gpt/, 'GPT');

async function anthropicList(cfg, v) {
  const usage = require('./usage');
  const sources = [];
  for (const a of cfg.accounts) {
    if ((a.provider || 'anthropic') !== 'anthropic' || a.enabled === false) continue;
    const c = usage.readCredentials(a);
    if (c && c.token) sources.push({ authorization: `Bearer ${c.token}`, 'anthropic-beta': 'oauth-2025-04-20' });
  }
  for (const k of v.keys) if ((k.provider || 'anthropic') === 'anthropic') sources.push({ 'x-api-key': k.key });
  for (const h of sources) {
    const j = json(await request(`${cfg.upstream}/v1/models?limit=100`, { headers: { ...h, 'anthropic-version': '2023-06-01' }, timeoutMs: 15000 }));
    if (j && Array.isArray(j.data) && j.data.length) return j.data.map((m) => [m.id, m.display_name || pretty(m.id)]);
  }
  return null;
}

async function openaiList(cfg, v) {
  for (const k of v.keys) {
    if (k.provider !== 'openai') continue;
    const j = json(await request(`${providers.openai.upstream(cfg)}/models`, { headers: { authorization: `Bearer ${k.key}` }, timeoutMs: 15000 }));
    if (!j || !Array.isArray(j.data)) continue;
    const ids = j.data.map((m) => m.id).filter((id) => /^(gpt|o\d|codex|chatgpt)/.test(id) && !NOT_CHAT.test(id) && !/-\d{4}-\d{2}-\d{2}$/.test(id));
    ids.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (ids.length) return ids.map((id) => [id, pretty(id)]);
  }
  return null;
}

async function geminiList(cfg, v) {
  for (const k of v.keys) {
    if (k.provider !== 'gemini') continue;
    const j = json(await request(`${providers.gemini.upstream(cfg)}/models?pageSize=1000`, { headers: { 'x-goog-api-key': k.key }, timeoutMs: 15000 }));
    if (!j || !Array.isArray(j.models)) continue;
    const list = j.models
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /^models\/gemini/.test(m.name) && !NOT_CHAT.test(m.name) && !/-\d{3}$/.test(m.name))
      .map((m) => [m.name.replace(/^models\//, ''), m.displayName || pretty(m.name)]);
    list.sort((a, b) => b[0].localeCompare(a[0], undefined, { numeric: true }));
    if (list.length) return list;
  }
  // A Google account: the models Code Assist keeps a quota for are the ones it serves.
  const googleAuth = require('./google-auth');
  for (const a of cfg.accounts) {
    if (a.kind !== 'gemini' || a.enabled === false) continue;
    try {
      const creds = await googleAuth.current(a.id);
      if (!creds) continue;
      const ids = Object.keys(await googleAuth.quota(creds)).filter((id) => /^gemini/.test(id) && !NOT_CHAT.test(id));
      ids.sort((x, y) => y.localeCompare(x, undefined, { numeric: true }));
      if (ids.length) return ids.map((id) => [id, (providers.gemini.models.find((m) => m[0] === id) || [id, pretty(id)])[1]]);
    } catch {}
  }
  return null;
}

const READERS = { anthropic: anthropicList, openai: openaiList, gemini: geminiList };
let running = null;

// Reads every provider's list again (those not read in the last few hours, unless forced).
function refresh({ force = false } = {}) {
  if (running) return running;
  running = (async () => {
    const cfg = config.load();
    const v = vault.load();
    const s = state.load();
    for (const [id, read] of Object.entries(READERS)) {
      const kept = s.models[id];
      if (!force && kept && Date.now() - kept.at < STALE_MS) continue;
      try {
        const list = await read(cfg, v);
        if (list && list.length) {
          state.recordModels(id, list);
          log(`models: ${providers.byId(id).name} lists ${list.length} models`);
        }
      } catch (err) {
        log(`models: couldn't read ${providers.byId(id).name}'s models: ${err.message}`);
      }
    }
  })().finally(() => (running = null));
  return running;
}

// A provider's models for a picker: the live list when there is one, then any built-in
// names it didn't include. [[id, name]].
function list(id) {
  const p = providers.byId(id);
  const live = (state.load().models[id] || {}).list || [];
  const seen = new Set(live.map((m) => m[0]));
  return [...live, ...p.models.filter((m) => !seen.has(m[0]))];
}

module.exports = { refresh, list, pretty };
