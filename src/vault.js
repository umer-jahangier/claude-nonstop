'use strict';

// Secrets (your API keys, plus the tokens that guard the local gateway and web UI)
// are stored in vault.json, encrypted with AES-256-GCM under the key from keystore.js.

const crypto = require('crypto');
const paths = require('./paths');
const { readJson, writeJson } = require('./files');
const { masterKey } = require('./keystore');

const newToken = () => `cn_${crypto.randomBytes(24).toString('base64url')}`;

function fill(v) {
  return {
    keys: Array.isArray(v.keys) ? v.keys : [],
    gatewayToken: v.gatewayToken || null,
    uiToken: v.uiToken || null,
  };
}

function load() {
  const raw = readJson(paths.VAULT, null);
  if (!raw) return fill({});
  const key = masterKey();
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(raw.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(raw.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(raw.data, 'base64')), decipher.final()]);
    return fill(JSON.parse(plain.toString('utf8')));
  } catch {
    throw new Error("the vault can't be decrypted: its key in your credential store changed. Run `claude-nonstop reset` to start over.");
  }
}

function save(v) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(fill(v)), 'utf8'), cipher.final()]);
  writeJson(paths.VAULT, {
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  });
}

// Loads the vault, creating the gateway and UI tokens on first use.
function loadWithTokens() {
  const v = load();
  if (!v.gatewayToken || !v.uiToken) {
    v.gatewayToken = v.gatewayToken || newToken();
    v.uiToken = v.uiToken || newToken();
    save(v);
  }
  return v;
}

function update(change) {
  const v = loadWithTokens();
  const result = change(v);
  save(v);
  return result;
}

module.exports = { load, loadWithTokens, save, update, newToken };
