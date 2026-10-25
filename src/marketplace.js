'use strict';

// The desktop app turns off Claude Code's automatic install of Anthropic's plugin
// marketplace whenever it talks to a gateway. Listing the marketplace in your settings
// brings it back, so plugins look the same as they did before claude-nonstop.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeJson } = require('./files');

const NAME = 'claude-plugins-official';
const SOURCE = { source: 'github', repo: 'anthropics/claude-plugins-official' };

// Every account links this same file, so one entry covers all of them.
const settingsFile = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');

function registered() {
  try {
    const current = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return Boolean(current && current.extraKnownMarketplaces && current.extraKnownMarketplaces[NAME]);
  } catch {
    return false;
  }
}

// Returns 'added', 'present', or 'unreadable' when the file exists but isn't valid JSON,
// in which case it is left alone rather than overwritten.
function ensure() {
  const file = settingsFile();
  let current = {};
  if (fs.existsSync(file)) {
    try {
      current = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return 'unreadable';
    }
    if (!current || typeof current !== 'object' || Array.isArray(current)) return 'unreadable';
  }
  const known = current.extraKnownMarketplaces;
  if (known && typeof known === 'object' && known[NAME]) return 'present';
  current.extraKnownMarketplaces = { ...(known && typeof known === 'object' ? known : {}), [NAME]: { source: SOURCE } };
  // Write through the link so every account keeps sharing the file.
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {}
  writeJson(target, current);
  return 'added';
}

module.exports = { NAME, SOURCE, settingsFile, registered, ensure };
