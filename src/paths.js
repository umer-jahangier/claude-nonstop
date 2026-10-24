'use strict';

const os = require('os');
const path = require('path');

// Everything claude-nonstop keeps lives in one folder: the encrypted vault, settings,
// non-secret state, extra account profiles, and (with the installers) the app itself.
const HOME = process.env.CLAUDE_NONSTOP_HOME || path.join(os.homedir(), '.claude-nonstop');

module.exports = {
  HOME,
  APP_SCRIPT: path.resolve(__dirname, '..', 'bin', 'claude-nonstop.js'),
  VAULT: path.join(HOME, 'vault.json'),
  KEYSTORE: path.join(HOME, 'keystore.json'),
  MASTER_KEY_FILE: path.join(HOME, 'master.key'),
  MASTER_DPAPI_FILE: path.join(HOME, 'master.dpapi'),
  CONFIG: path.join(HOME, 'config.json'),
  STATE: path.join(HOME, 'state.json'),
  SERVER: path.join(HOME, 'server.json'),
  PROFILES: path.join(HOME, 'profiles'),
  LOG: path.join(HOME, 'claude-nonstop.log'),
  GATEWAY_LOG: path.join(HOME, 'gateway.log'),
  DESKTOP_CONFIG: path.join(HOME, 'claude-desktop-gateway.json'),
};
