'use strict';

// Every Claude Code that reads user settings — the terminal, VS Code, Cursor, and any
// other install — is pointed at this computer's gateway. The gateway then walks your
// subscription accounts and API keys, the same way it does for the desktop app. The
// desktop app itself is set up separately (desktop.js).

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const config = require('./config');
const vault = require('./vault');
const claude = require('./claude');
const { readJson, writeJson } = require('./files');

const BASE_URL = 'ANTHROPIC_BASE_URL';
const AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN';
const STATE = path.join(paths.HOME, 'clients.json');

function settingsFile() {
  return require('./marketplace').settingsFile();
}

function readSettings() {
  const file = settingsFile();
  if (!fs.existsSync(file)) return { file, current: {} };
  let current;
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { file, unreadable: true };
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) return { file, unreadable: true };
  return { file, current };
}

function realTarget(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

function gatewayAddress(cfg) {
  return `http://127.0.0.1:${cfg.port}`;
}

// Writes the gateway address into Claude Code's user settings. Returns what changed.
// A settings file that isn't valid JSON is left alone.
function apply(cfg = config.load(), v = vault.loadWithTokens()) {
  const loaded = readSettings();
  if (loaded.unreadable) return { ok: false, reason: 'unreadable', changed: false, permissionChanged: false };
  const current = loaded.current;
  const saved = readJson(STATE, {});
  const env = current.env && typeof current.env === 'object' && !Array.isArray(current.env) ? { ...current.env } : {};
  if (!saved.managed) {
    saved.managed = true;
    saved.env = {
      [BASE_URL]: Object.prototype.hasOwnProperty.call(env, BASE_URL) ? env[BASE_URL] : null,
      [AUTH_TOKEN]: Object.prototype.hasOwnProperty.call(env, AUTH_TOKEN) ? env[AUTH_TOKEN] : null,
    };
    saved.permissionMode = null;
  }
  const address = gatewayAddress(cfg);
  let permissionChanged = false;
  if (claude.isRoot() && current.permissions && current.permissions.defaultMode === 'bypassPermissions') {
    if (!saved.permissionMode) saved.permissionMode = 'bypassPermissions';
    current.permissions = { ...current.permissions, defaultMode: 'default' };
    permissionChanged = true;
  }
  const unchanged = env[BASE_URL] === address && env[AUTH_TOKEN] === v.gatewayToken && !permissionChanged && saved.managed;
  if (unchanged && readJson(STATE, {}).managed) return { ok: true, changed: false, permissionChanged: false, root: claude.isRoot() };
  env[BASE_URL] = address;
  env[AUTH_TOKEN] = v.gatewayToken;
  current.env = env;
  writeJson(STATE, saved);
  writeJson(realTarget(loaded.file), current);
  return { ok: true, changed: true, permissionChanged, root: claude.isRoot() };
}

// Puts back whatever those settings were before setup, then forgets that it managed them.
function remove() {
  const loaded = readSettings();
  const saved = readJson(STATE, null);
  if (loaded.unreadable) return { ok: false, reason: 'unreadable' };
  if (!saved || !saved.managed) return { ok: true };
  const env = loaded.current.env && typeof loaded.current.env === 'object' && !Array.isArray(loaded.current.env) ? { ...loaded.current.env } : {};
  for (const key of [BASE_URL, AUTH_TOKEN]) {
    const previous = saved.env ? saved.env[key] : null;
    if (previous === undefined || previous === null) delete env[key];
    else env[key] = previous;
  }
  if (Object.keys(env).length) loaded.current.env = env;
  else delete loaded.current.env;
  if (saved.permissionMode && loaded.current.permissions && loaded.current.permissions.defaultMode === 'default') {
    loaded.current.permissions = { ...loaded.current.permissions, defaultMode: saved.permissionMode };
  }
  writeJson(realTarget(loaded.file), loaded.current);
  fs.rmSync(STATE, { force: true });
  return { ok: true };
}

module.exports = { apply, remove, settingsFile, BASE_URL, AUTH_TOKEN };
