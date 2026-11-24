'use strict';

// Non-secret runtime state shared by the CLI, the key helper and the gateway: the
// last check of each key and account, keyed by fingerprint (never the key itself).

const paths = require('./paths');
const { readJson, writeJson } = require('./files');

function load() {
  const s = readJson(paths.STATE, {});
  return {
    keys: s.keys || {},
    accounts: s.accounts || {},
    current: s.current || null,
    currentAt: s.currentAt || null,
    // The line requests last actually went out on ({ line: 'account:<id>' | 'key:<id>', at }),
    // from sessions or the desktop app: where the page's cable is plugged in.
    inUse: s.inUse || null,
    desktop: s.desktop || null,
    desktopAdvice: s.desktopAdvice || null,
    desktopLimitedAt: s.desktopLimitedAt || null,
    usage: s.usage || {},
    chatgptModels: s.chatgptModels || {},
    // Each provider's model list as its API last gave it (models.js): { list: [[id, name]], at }.
    models: s.models || {},
  };
}

function update(change) {
  const s = load();
  change(s);
  writeJson(paths.STATE, s);
  return s;
}

const recordKey = (id, check) => update((s) => (s.keys[id] = { ...check, at: Date.now() }));
const recordAccount = (id, check) => update((s) => (s.accounts[id] = { ...check, at: Date.now() }));
const forgetKey = (id) => update((s) => delete s.keys[id]);
const forgetAccount = (id) =>
  update((s) => {
    delete s.accounts[id];
    delete s.usage[id];
    delete s.chatgptModels[id];
  });
// How much of an account's plan is used (see usage.js).
const recordUsage = (id, usage) => update((s) => (s.usage[id] = usage));
// The model names a ChatGPT account's backend listed last (see chatgpt-models.js).
const recordModels = (provider, list) => update((s) => (s.models[provider] = { list, at: Date.now() }));
const recordChatgptModels = (id, slugs) => update((s) => (s.chatgptModels[id] = { slugs, at: Date.now() }));

function isCoolingDown(id, minutes) {
  const k = load().keys[id];
  return Boolean(k && k.verdict === 'used-up' && Date.now() - k.at < minutes * 60000);
}

// Records which account or key terminal sessions are on, writing only when it changes.
function setCurrent(label) {
  if (load().current === label) return;
  update((s) => {
    s.current = label;
    s.currentAt = Date.now();
  });
}

// Records the line requests just went out on. Written when it changes, or once a minute while
// it stays the same, so the page can tell a line in use now from one used a while ago.
function setInUse(line) {
  const now = load().inUse;
  if (now && now.line === line && Date.now() - now.at < 60000) return;
  update((s) => (s.inUse = { line, at: Date.now() }));
}

// The key the desktop app's requests last went out on, and when. Kept apart from `current`:
// the desktop app runs only on API keys, whatever line terminal sessions are on.
function setDesktop(label, kind = 'key') {
  update((s) => (s.desktop = { label, kind, at: Date.now() }));
}

const setDesktopAdvice = (advice) => update((s) => (s.desktopAdvice = advice));
// When the desktop app's account was last seen at its limit; null once it's been used again.
const setDesktopLimited = (at) => update((s) => (s.desktopLimitedAt = at));

function clearCooldowns() {
  update((s) => {
    s.keys = {};
    s.accounts = {};
  });
}

module.exports = { load, setInUse, recordModels, recordKey, recordAccount, recordUsage, recordChatgptModels, forgetKey, forgetAccount, isCoolingDown, setCurrent, setDesktop, setDesktopAdvice, setDesktopLimited, clearCooldowns };
