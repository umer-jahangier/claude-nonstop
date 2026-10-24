'use strict';

// Starts the gateway when you log in, so the desktop app and the CLI can always reach
// it. None of these need admin rights:
//   macOS: a LaunchAgent. Linux: a systemd user service, or an XDG autostart entry.
//   Windows: an entry under HKCU\...\Run.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const paths = require('./paths');
const claude = require('./claude');
const { ensureHome, readJson } = require('./files');

const LABEL = 'dev.claude-nonstop.gateway';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { ok: !r.error && r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
};

// The service needs to find Claude Code (for signing in accounts from the web UI) even
// though login services start with a bare PATH, so it gets this shell's PATH.
function serviceEnv() {
  const env = { PATH: process.env.PATH || '' };
  const bin = claude.findClaude();
  if (bin) env.CLAUDE_NONSTOP_CLAUDE = bin;
  if (process.env.CLAUDE_NONSTOP_HOME) env.CLAUDE_NONSTOP_HOME = process.env.CLAUDE_NONSTOP_HOME;
  return env;
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const mac = {
  file: path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`),
  domain: () => `gui/${process.getuid()}`,
  install() {
    // launchd restarts the gateway when it exits non-zero, e.g. after installing an update.
    const env = { ...serviceEnv(), CLAUDE_NONSTOP_SUPERVISED: '1' };
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(paths.APP_SCRIPT)}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`)
  .join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(paths.GATEWAY_LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(paths.GATEWAY_LOG)}</string>
</dict>
</plist>
`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, plist);
    run('launchctl', ['bootout', `${this.domain()}/${LABEL}`]);
    const r = run('launchctl', ['bootstrap', this.domain(), this.file]);
    if (!r.ok && !run('launchctl', ['load', '-w', this.file]).ok) throw new Error(`launchctl could not start the gateway: ${r.out}`);
    return `LaunchAgent ${this.file}`;
  },
  uninstall() {
    run('launchctl', ['bootout', `${this.domain()}/${LABEL}`]);
    fs.rmSync(this.file, { force: true });
  },
  installed() {
    return fs.existsSync(this.file);
  },
};

const systemdUnit = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user', 'claude-nonstop.service');
const autostartFile = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'claude-nonstop.desktop');
const systemdQuote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;

const linux = {
  hasSystemd: () => run('systemctl', ['--user', 'show-environment']).ok,
  install() {
    const env = serviceEnv();
    if (this.hasSystemd()) {
      env.CLAUDE_NONSTOP_SUPERVISED = '1'; // systemd restarts it on a non-zero exit, e.g. after an update
      const unit = `[Unit]
Description=claude-nonstop gateway and web UI
After=network-online.target

[Service]
ExecStart=${systemdQuote(process.execPath)} ${systemdQuote(paths.APP_SCRIPT)} serve
Restart=on-failure
RestartSec=5
${Object.entries(env)
  .map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`)
  .join('\n')}

[Install]
WantedBy=default.target
`;
      fs.mkdirSync(path.dirname(systemdUnit), { recursive: true });
      fs.writeFileSync(systemdUnit, unit);
      run('systemctl', ['--user', 'daemon-reload']);
      const r = run('systemctl', ['--user', 'enable', '--now', 'claude-nonstop.service']);
      if (!r.ok) throw new Error(`systemctl could not start the gateway: ${r.out}`);
      return `systemd user service ${systemdUnit}`;
    }
    const desktopEntry = `[Desktop Entry]
Type=Application
Name=claude-nonstop gateway
Exec=${systemdQuote(process.execPath)} ${systemdQuote(paths.APP_SCRIPT)} serve
X-GNOME-Autostart-enabled=true
NoDisplay=true
`;
    fs.mkdirSync(path.dirname(autostartFile), { recursive: true });
    fs.writeFileSync(autostartFile, desktopEntry);
    startDetached();
    return `autostart entry ${autostartFile} (started now as well)`;
  },
  uninstall() {
    if (fs.existsSync(systemdUnit)) {
      run('systemctl', ['--user', 'disable', '--now', 'claude-nonstop.service']);
      fs.rmSync(systemdUnit, { force: true });
      run('systemctl', ['--user', 'daemon-reload']);
    }
    fs.rmSync(autostartFile, { force: true });
  },
  installed: () => fs.existsSync(systemdUnit) || fs.existsSync(autostartFile),
};

const windows = {
  command: () => `"${process.execPath}" "${paths.APP_SCRIPT}" serve --background`,
  install() {
    const r = run('reg', ['add', RUN_KEY, '/v', 'claude-nonstop', '/t', 'REG_SZ', '/d', this.command(), '/f']);
    if (!r.ok) throw new Error(`could not add the startup entry: ${r.out}`);
    startDetached();
    return `startup entry ${RUN_KEY}\\claude-nonstop (started now as well)`;
  },
  uninstall() {
    run('reg', ['delete', RUN_KEY, '/v', 'claude-nonstop', '/f']);
  },
  installed: () => run('reg', ['query', RUN_KEY, '/v', 'claude-nonstop']).ok,
};

const platform = () => ({ darwin: mac, linux, win32: windows })[process.platform];

// Stops a gateway started earlier (by `claude-nonstop ui` or a previous install).
function stopRunning() {
  const info = readJson(paths.SERVER, null);
  if (!info || !info.pid || info.pid === process.pid) return;
  try {
    process.kill(info.pid);
  } catch {}
  fs.rmSync(paths.SERVER, { force: true });
}

// Starts `claude-nonstop serve` in the background, detached from this terminal.
function startDetached() {
  ensureHome();
  const out = fs.openSync(paths.GATEWAY_LOG, 'a');
  const child = spawn(process.execPath, [paths.APP_SCRIPT, 'serve'], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: { ...process.env, ...serviceEnv() },
  });
  child.unref();
  fs.closeSync(out);
  return child.pid;
}

function install() {
  const p = platform();
  if (!p) throw new Error(`starting at login isn't supported on ${process.platform}; run \`claude-nonstop serve\` yourself`);
  stopRunning();
  return p.install();
}

function uninstall() {
  const p = platform();
  if (p) p.uninstall();
  stopRunning();
}

function status() {
  const p = platform();
  return { installed: Boolean(p && p.installed()) };
}

module.exports = { install, uninstall, status, startDetached, stopRunning };
