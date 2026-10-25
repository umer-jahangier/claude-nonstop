'use strict';

// Non-secret runtime state shared by the CLI, the key helper and the gateway: the
// last check of each key and account, keyed by fingerprint (never the key itself).

const paths = require('./paths');
const { readJson, writeJson } = require('./files');

function load() {
  const s = readJson(paths.STATE, {});
  return { keys: s.keys || {}, accounts: s.accounts || {}, current: s.current || null, currentAt: s.currentAt || null, desktop: s.desktop || null };
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
const forgetAccount = (id) => update((s) => delete s.accounts[id]);

// A key whose credit doesn't cover Claude Code (scope 'claude-code') is set aside only for
// Claude Code's requests; anything else may still use it.
function isCoolingDown(id, minutes, { claudeCode = true } = {}) {
  const k = load().keys[id];
  if (!k || k.verdict !== 'used-up' || Date.now() - k.at >= minutes * 60000) return false;
  return claudeCode || k.scope !== 'claude-code';
}

// Records which account or key terminal sessions are on, writing only when it changes.
function setCurrent(label) {
  if (load().current === label) return;
  update((s) => {
    s.current = label;
    s.currentAt = Date.now();
  });
}

// The key the desktop app's requests last went out on. Kept apart from `current`: the
// desktop app runs only on API keys, whatever line terminal sessions are on.
function setDesktop(label) {
  if ((load().desktop || {}).label === label) return;
  update((s) => (s.desktop = { label, at: Date.now() }));
}

function clearCooldowns() {
  update((s) => {
    s.keys = {};
    s.accounts = {};
  });
}

module.exports = { load, recordKey, recordAccount, forgetKey, forgetAccount, isCoolingDown, setCurrent, setDesktop, clearCooldowns };
