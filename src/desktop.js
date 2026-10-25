'use strict';

// The Claude desktop app runs on your API keys through claude-nonstop's gateway in its
// third-party mode, and its sign-in screen keeps your Claude.ai subscription one click
// away. Anthropic documents where the app reads that mode's settings
// (claude.com/docs/third-party/claude-desktop/configuration-format):
//   Windows  registry policy, HKLM\SOFTWARE\Policies\Claude      (written in the admin prompt)
//   Linux    /etc/claude-desktop/managed-settings.json, root-owned (written in the admin prompt)
//   macOS    a configuration profile for com.anthropic.claudefordesktop. macOS lets only
//            the user approve a profile, so setup opens it in System Settings: one click.
// Settings take effect the next time the app starts.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const paths = require('./paths');
const { writeJson } = require('./files');
const { psQuote, shQuote } = require('./elevate');

const DOMAIN = 'com.anthropic.claudefordesktop';
const LINUX_FILE = '/etc/claude-desktop/managed-settings.json';
const WIN_KEY = 'HKLM\\SOFTWARE\\Policies\\Claude';
const PROFILE = path.join(paths.HOME, 'claude-nonstop-desktop.mobileconfig');

function settings(cfg, v) {
  return {
    inferenceProvider: 'gateway',
    inferenceGatewayBaseUrl: `http://127.0.0.1:${cfg.port}`,
    inferenceGatewayApiKey: v.gatewayToken,
    inferenceGatewayAuthScheme: 'bearer',
    // Third-party mode keeps its own history, so turn on Anthropic's import: Settings →
    // Import & export brings over your claude.ai chats and the Code and Cowork sessions
    // already on this computer, and a new chat offers it when it finds earlier sessions.
    claudeAiImport: JSON.stringify({ enabled: true, automatic3pImport: true, bannerBehavior: 'detect' }),
    // In third-party mode the app limits Code sessions to an allowlist of sites (strict
    // sandbox mode) unless this list contains "*". This is your own computer, so by default
    // sessions reach any site, as in a normal install. Settings → Strict sandbox restores it.
    ...(cfg.desktopStrictSandbox ? {} : { coworkEgressAllowedHosts: JSON.stringify(['*']) }),
    // Third-party mode leaves the built-in browser and desktop extensions off unless they
    // are switched on, so Code sessions get the same browser pane and extensions as before.
    builtinBrowserEnabled: 'true',
    isDesktopExtensionEnabled: 'true',
    // It also hides the claude.ai connector directory and the button for adding your own;
    // connectors come only from this list. `claude-nonstop connectors add` fills it.
    ...(connectors(cfg).length ? { managedMcpServers: JSON.stringify(connectors(cfg)) } : {}),
  };
}

const connectors = (cfg) => (Array.isArray(cfg.desktopConnectors) ? cfg.desktopConnectors : []);

// A connector entry the app accepts: a remote server by URL, signing in through OAuth
// unless it needs no sign-in.
function connector(name, url, { oauth = true } = {}) {
  if (!name || !/^[\w .-]{1,64}$/.test(name)) throw new Error('a connector name is letters, numbers, spaces, dots, dashes or underscores, up to 64 characters');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${url} isn't a URL`);
  }
  if (parsed.protocol !== 'https:') throw new Error('the desktop app only connects to https:// servers');
  return { name, transport: 'http', url: parsed.href, ...(oauth ? { oauth: true } : {}) };
}

// Every key claude-nonstop may write, so one it no longer wants is removed, not left behind.
const MANAGED_KEYS = ['inferenceProvider', 'inferenceGatewayBaseUrl', 'inferenceGatewayApiKey', 'inferenceGatewayAuthScheme', 'claudeAiImport', 'coworkEgressAllowedHosts', 'builtinBrowserEnabled', 'isDesktopExtensionEnabled', 'managedMcpServers'];

// A copy of the settings as JSON, for typing into the app's window by hand if ever needed.
function write(cfg, v) {
  writeJson(paths.DESKTOP_CONFIG, settings(cfg, v));
  return paths.DESKTOP_CONFIG;
}

const STEPS = [
  'In the Claude desktop app, open Help → Troubleshooting → Enable Developer Mode.',
  'Open Developer → Configure Third-Party Inference…, choose Gateway, and enter the three values below.',
  'Click Apply Changes, then Save & Restart.',
];

const managedOff = () => process.env.CLAUDE_NONSTOP_DESKTOP_MANAGED === '0';

// Whether the Claude desktop app is (or has been) on this computer.
function appInstalled() {
  const home = os.homedir();
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Claude.app', path.join(home, 'Applications', 'Claude.app')]
    : process.platform === 'win32'
      ? [path.join(process.env.LOCALAPPDATA || '', 'AnthropicClaude'), path.join(process.env.APPDATA || '', 'Claude'), path.join(process.env.LOCALAPPDATA || '', 'Claude-3p')]
      : ['/usr/bin/claude-desktop', '/opt/Claude', path.join(home, '.config', 'Claude')];
  return candidates.some((p) => p && fs.existsSync(p));
}

// The settings the app reads today from the documented managed location, if any.
function current() {
  try {
    if (process.platform === 'darwin') {
      const user = os.userInfo().username;
      for (const file of [`/Library/Managed Preferences/${user}/${DOMAIN}.plist`, `/Library/Managed Preferences/${DOMAIN}.plist`]) {
        if (!fs.existsSync(file)) continue;
        const r = spawnSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' });
        if (r.status === 0) return JSON.parse(r.stdout);
      }
      return null;
    }
    if (process.platform === 'win32') {
      const r = spawnSync('reg.exe', ['query', WIN_KEY], { encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) return null;
      const out = {};
      for (const line of r.stdout.split(/\r?\n/)) {
        const m = line.match(/^\s+(\S+)\s+REG_SZ\s+(.*)$/);
        if (m) out[m[1]] = m[2].trim();
      }
      return out;
    }
    return JSON.parse(fs.readFileSync(LINUX_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// The web page asks often; reading the managed settings means running a tool, so keep the
// answer for a few seconds.
let cached = { at: 0, value: null };
function currentCached() {
  if (Date.now() - cached.at > 5000) cached = { at: Date.now(), value: current() };
  return cached.value;
}

function applied(want, { fresh = false } = {}) {
  if (fresh) cached.at = 0;
  const have = currentCached();
  return Boolean(have && MANAGED_KEYS.every((k) => String(have[k] ?? '') === String(want[k] ?? '')));
}

// What system.js should do in its admin prompt to put the settings in place (Windows and
// Linux), or null when they're already there, the app isn't installed, or it's macOS.
function managedChange(want) {
  if (managedOff() || process.platform === 'darwin' || !appInstalled() || applied(want, { fresh: true })) return null;
  if (process.platform === 'win32') {
    const key = 'HKLM:\\SOFTWARE\\Policies\\Claude';
    const values = Object.entries(want).map(([k, value]) => `New-ItemProperty -Path ${psQuote(key)} -Name ${psQuote(k)} -Value ${psQuote(value)} -PropertyType String -Force | Out-Null`);
    const stale = MANAGED_KEYS.filter((k) => !(k in want)).map((k) => `Remove-ItemProperty -Path ${psQuote(key)} -Name ${psQuote(k)} -ErrorAction SilentlyContinue`);
    return { ps: [`New-Item -Path ${psQuote(key)} -Force | Out-Null`, ...values, ...stale].join('; ') };
  }
  return {
    file: { text: `${JSON.stringify(want, null, 2)}\n`, target: LINUX_FILE },
    sh: (staged) => `mkdir -p /etc/claude-desktop && chown root:root /etc/claude-desktop && chmod 755 /etc/claude-desktop && cp ${shQuote(staged)} ${LINUX_FILE} && chown root:root ${LINUX_FILE} && chmod 644 ${LINUX_FILE}`,
  };
}

function managedRemoval() {
  if (process.platform === 'darwin' || !current()) return null;
  if (process.platform === 'win32') {
    const key = 'HKLM:\\SOFTWARE\\Policies\\Claude';
    return { ps: MANAGED_KEYS.map((n) => `Remove-ItemProperty -Path ${psQuote(key)} -Name ${psQuote(n)} -ErrorAction SilentlyContinue`).join('; ') };
  }
  return { sh: () => `rm -f ${LINUX_FILE}` };
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// macOS: writes the configuration profile and opens it, which takes the user to System
// Settings to approve it. Returns the profile's path, or null when nothing is needed.
function macProfile(want, { open = true } = {}) {
  if (managedOff() || process.platform !== 'darwin' || !appInstalled() || applied(want, { fresh: true })) return null;
  const keys = Object.entries(want).map(([k, value]) => `      <key>${xml(k)}</key>\n      <string>${xml(value)}</string>`).join('\n');
  const profile = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key>
      <string>${DOMAIN}</string>
      <key>PayloadIdentifier</key>
      <string>dev.claude-nonstop.desktop.settings</string>
      <key>PayloadUUID</key>
      <string>${crypto.randomUUID().toUpperCase()}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadDisplayName</key>
      <string>Claude desktop app: claude-nonstop gateway</string>
${keys}
    </dict>
  </array>
  <key>PayloadDisplayName</key>
  <string>claude-nonstop for the Claude desktop app</string>
  <key>PayloadDescription</key>
  <string>Lets the Claude desktop app run on your API keys through claude-nonstop on this computer. Your Claude.ai subscription stays one click away on the app's sign-in screen. Remove this profile any time to undo it.</string>
  <key>PayloadIdentifier</key>
  <string>dev.claude-nonstop.desktop</string>
  <key>PayloadOrganization</key>
  <string>claude-nonstop</string>
  <key>PayloadScope</key>
  <string>User</string>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${crypto.randomUUID().toUpperCase()}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`;
  fs.writeFileSync(PROFILE, profile, { mode: 0o600 });
  if (open) {
    detached('open', [PROFILE]);
    setTimeout(() => detached('open', ['x-apple.systempreferences:com.apple.Profiles-Settings.extension']), 1200).unref();
  }
  return PROFILE;
}

// Where things stand, for the web page and `claude-nonstop status`.
function status(want) {
  return {
    file: paths.DESKTOP_CONFIG,
    installed: appInstalled(),
    automatic: Boolean(want) && applied(want),
    method: process.platform === 'darwin' ? 'profile' : process.platform === 'win32' ? 'registry' : 'file',
  };
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

module.exports = { settings, connector, write, status, reveal, STEPS, appInstalled, applied, managedChange, managedRemoval, macProfile, PROFILE };
