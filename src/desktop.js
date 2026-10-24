'use strict';

// The Claude desktop app takes a gateway from its third-party inference settings
// (Developer → Configure Third-Party Inference). claude-nonstop writes a file you can
// import there, pointing the app at the local gateway.

const fs = require('fs');
const { spawn } = require('child_process');
const paths = require('./paths');
const { writeJson } = require('./files');

function settings(cfg, v) {
  return {
    inferenceProvider: 'gateway',
    inferenceGatewayBaseUrl: `http://127.0.0.1:${cfg.port}`,
    inferenceGatewayApiKey: v.gatewayToken,
    inferenceGatewayAuthScheme: 'bearer',
  };
}

function write(cfg, v) {
  writeJson(paths.DESKTOP_CONFIG, settings(cfg, v));
  return paths.DESKTOP_CONFIG;
}

const STEPS = [
  'In the Claude desktop app, open Help → Troubleshooting → Enable Developer Mode (the app restarts).',
  'Open Developer → Configure Third-Party Inference…',
  'Click Import configuration and pick the claude-nonstop file (or type the three values shown below).',
  'Click Apply Changes, then Save & Restart.',
  'At the sign-in screen, pick Claude.ai to use your subscription, or the third-party option to run on your API keys through claude-nonstop.',
];

function status() {
  return { file: paths.DESKTOP_CONFIG, written: fs.existsSync(paths.DESKTOP_CONFIG) };
}

function detached(cmd, args) {
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {}
}

// Shows the file in Finder / Explorer / the Linux file manager.
function reveal(file = paths.DESKTOP_CONFIG) {
  if (process.platform === 'darwin') detached('open', ['-R', file]);
  else if (process.platform === 'win32') detached('explorer.exe', [`/select,${file}`]);
  else detached('xdg-open', [paths.HOME]);
  return { ok: true };
}

module.exports = { settings, write, status, reveal, STEPS };
