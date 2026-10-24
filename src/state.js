'use strict';

// Non-secret runtime state shared by the CLI, the key helper and the gateway: the
// last check of each key and account, keyed by fingerprint (never the key itself).

const paths = require('./paths');
const { readJson, writeJson } = require('./files');

function load() {
  const s = readJson(paths.STATE, {});
  return { keys: s.keys || {}, accounts: s.accounts || {}, current: s.current || null, currentAt: s.currentAt || null };
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

function isCoolingDown(id, minutes) {
  const k = load().keys[id];
  return Boolean(k && k.verdict === 'used-up' && Date.now() - k.at < minutes * 60000);
}

// Records which account or key is in use, writing only when it changes.
function setCurrent(label) {
  if (load().current === label) return;
  update((s) => {
    s.current = label;
    s.currentAt = Date.now();
  });
}

function clearCooldowns() {
  update((s) => {
    s.keys = {};
    s.accounts = {};
  });
}

module.exports = { load, recordKey, recordAccount, forgetKey, forgetAccount, isCoolingDown, setCurrent, clearCooldowns };
