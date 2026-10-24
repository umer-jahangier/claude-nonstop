'use strict';

// The management commands: everything except launching Claude Code.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('./paths');
const config = require('./config');
const vault = require('./vault');
const keys = require('./keys');
const accounts = require('./accounts');
const state = require('./state');
const claude = require('./claude');
const keystore = require('./keystore');
const desktop = require('./desktop');
const hostsfile = require('./hostsfile');
const system = require('./system');
const tls = require('./tls');
const service = require('./service');
const shell = require('./shell');
const prompt = require('./prompt');
const { gatewayRunning, gatewayUrl } = require('./launch');
const { FRIENDLY_HOST } = require('./hosts');
const { ensureHome, readJson, log } = require('./files');
const pkg = require('../package.json');

const out = (line = '') => process.stdout.write(`${line}\n`);
const say = (message) => process.stderr.write(`claude-nonstop: ${message}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ago(at) {
  const m = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (m === 0) return 'just now';
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

function describeKeyCheck(c) {
  if (!c) return 'not checked yet';
  const detail = c.detail ? `: ${c.detail}` : '';
  if (c.verdict === 'ok') return 'works';
  if (c.verdict === 'used-up') return `used up (HTTP ${c.status}${detail})`;
  return `kept, the problem isn't this key (${c.status ? `HTTP ${c.status}` : 'no answer'}${detail})`;
}

function describeAccountCheck(c) {
  if (!c) return 'not checked yet';
  return `${c.ok ? 'had usage left' : c.reason} (${ago(c.at)})`;
}

function requireClaude() {
  const bin = claude.findClaude();
  if (!bin) throw new Error("can't find Claude Code (the `claude` command). Install it from https://code.claude.com/docs/en/setup");
  return bin;
}

// Finds an item by its number in the list (1-based) or by its label.
function pickItem(list, ref, noun) {
  const n = Number(ref);
  const item = Number.isInteger(n) && n >= 1 ? list[n - 1] : list.find((x) => x.label.toLowerCase() === String(ref || '').toLowerCase());
  if (!item) throw new Error(`no ${noun} "${ref || ''}". See the numbers with \`claude-nonstop status\`.`);
  return item;
}

function openBrowser(url) {
  const opts = { detached: true, stdio: 'ignore', windowsHide: true };
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  try {
    const cmd =
      process.platform === 'darwin'
        ? ['open', [url]]
        : process.platform === 'win32'
          ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
          : ['xdg-open', [url]];
    const child = spawn(cmd[0], cmd[1], opts);
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function ensureServer(cfg) {
  if (await gatewayRunning(cfg)) return true;
  service.startDetached();
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    if (await gatewayRunning(cfg)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- serve / ui / status

async function serve(args) {
  const cfg = config.load();
  if (await gatewayRunning(cfg)) {
    if (!args.includes('--background')) say(`already running on ${gatewayUrl(cfg)}`);
    return 0;
  }
  if (args.includes('--background')) {
    service.startDetached();
    return 0;
  }
  try {
    await require('./server').serve();
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      say(`port ${cfg.port} is used by another program. Set a different "port" in ${paths.CONFIG}.`);
      return 1;
    }
    throw err;
  }
  say(`gateway and web UI running on ${gatewayUrl(cfg)} (Ctrl-C stops them)`);
  return new Promise(() => {});
}

async function ui(args = []) {
  ensureHome();
  const cfg = config.load();
  const v = vault.loadWithTokens();
  if (!(await ensureServer(cfg))) {
    say(`couldn't start the local server; details are in ${paths.GATEWAY_LOG}`);
    return 1;
  }
  const url = `${uiUrl(cfg)}/auth?t=${encodeURIComponent(v.uiToken)}`;
  if (!args.includes('--no-open') && openBrowser(url)) out(`Opened the claude-nonstop web UI. If no browser window appeared, open:\n  ${url}`);
  else out(`Open the claude-nonstop web UI at:\n  ${url}`);
  return 0;
}

// The web UI's address, as the running server reported it: http://claude-nonstop.localhost
// when it could take port 80, otherwise the same name with the gateway's port.
function uiUrl(cfg) {
  const info = readJson(paths.SERVER, null);
  return (info && info.uiUrl) || `http://${FRIENDLY_HOST}:${cfg.port}`;
}

async function status() {
  ensureHome();
  const cfg = config.load();
  const v = vault.loadWithTokens();
  const s = state.load();
  const running = await gatewayRunning(cfg);
  out(`claude-nonstop ${pkg.version}`);
  const bin = claude.findClaude();
  const cv = bin ? await claude.version(bin) : null;
  const note = cv && !claude.atLeast(cv) ? ', update it with `claude update` so sessions continue by themselves after limits' : '';
  out(`  Claude Code        ${bin ? `${bin}${cv ? ` (${cv.join('.')}${note})` : ''}` : 'not found'}`);
  out(`  Secrets            encrypted, key in ${keystore.describe()}`);
  out(`  Gateway            ${running ? `running on ${gatewayUrl(cfg)}` : 'not running'}${service.status().installed ? ', starts at login' : ''}`);
  if (running) out(`  Web UI             ${uiUrl(cfg)}  (open it with \`claude-nonstop ui\`)`);
  out(`  Updates            ${cfg.autoUpdate === false ? 'off' : 'install themselves'}`);
  out(`  claude shortcut    ${shell.status().installed ? 'on' : 'off'}`);
  const d = desktop.status(desktop.settings(cfg, v));
  out(`  Desktop app        ${!d.installed ? 'not installed' : d.automatic ? 'set up to use the gateway' : 'not set up yet (run `claude-nonstop desktop`)'}`);
  out(`  In use             ${s.current || 'nothing yet'}`);
  out('');
  out('Subscription accounts, tried in this order:');
  cfg.accounts.forEach((a, i) => out(`  ${i + 1}. ${a.label}${a.enabled === false ? ' (off)' : ''}: ${describeAccountCheck(s.accounts[a.id])}`));
  out('');
  out('API keys, tried after the accounts:');
  if (!v.keys.length) out('  none yet. Add some with `claude-nonstop ui` or `claude-nonstop keys add`.');
  v.keys.forEach((k, i) => out(`  ${i + 1}. ${k.label}  ${keys.mask(k.key)}  ${describeKeyCheck(s.keys[k.id])}`));
  return 0;
}

// ---------------------------------------------------------------- keys

async function checkAllKeys() {
  const v = vault.loadWithTokens();
  const cfg = config.load();
  if (!v.keys.length) {
    out('No API keys yet. Add one with `claude-nonstop keys add` or `claude-nonstop ui`.');
    return 0;
  }
  out('API keys, tried top to bottom:');
  for (const [i, entry] of v.keys.entries()) {
    const check = await keys.check(entry, cfg);
    out(`  ${i + 1}. ${entry.label.padEnd(16)} ${keys.mask(entry.key).padEnd(20)} ${describeKeyCheck(check)}`);
  }
  return 0;
}

async function addKey(label) {
  const key = await prompt.secret('Paste your Claude API key (it stays hidden): ');
  const problem = keys.problemWith(key);
  if (problem) {
    say(`can't save it: ${problem}`);
    return 1;
  }
  let entry;
  try {
    entry = vault.update((v) => {
      if (v.keys.some((k) => k.id === keys.fingerprint(key))) throw new Error('that key is already saved');
      const created = keys.newEntry(key, label.trim().slice(0, 60), v.keys.length + 1);
      v.keys.push(created);
      return created;
    });
  } catch (err) {
    say(err.message);
    return 1;
  }
  log(`added API key "${entry.label}"`);
  const check = await keys.check(entry, config.load());
  out(`Saved "${entry.label}" (${keys.mask(key)}): ${describeKeyCheck(check)}`);
  return 0;
}

function removeKey(ref) {
  const entry = pickItem(vault.load().keys, ref, 'key');
  vault.update((v) => {
    v.keys = v.keys.filter((k) => k.id !== entry.id);
  });
  state.forgetKey(entry.id);
  out(`Removed "${entry.label}".`);
  return 0;
}

function keysCommand([sub, ...rest] = []) {
  if (!sub || sub === 'list' || sub === 'check') return checkAllKeys();
  if (sub === 'add') return addKey(rest.join(' '));
  if (sub === 'remove' || sub === 'rm') return removeKey(rest[0]);
  say(`unknown command: keys ${sub}`);
  return 1;
}

// ---------------------------------------------------------------- accounts

async function listAccounts() {
  const cfg = config.load();
  const bin = claude.findClaude();
  const s = state.load();
  out('Subscription accounts, tried in this order:');
  for (const [i, a] of cfg.accounts.entries()) {
    const login = bin ? await accounts.status(a, bin) : { loggedIn: null, error: 'Claude Code was not found' };
    const who = login.loggedIn ? `signed in${login.email ? ` as ${login.email}` : ''}` : login.loggedIn === false ? 'not signed in' : `sign-in not checked (${login.error})`;
    out(`  ${i + 1}. ${a.label}${a.enabled === false ? ' (off)' : ''}: ${who}; ${describeAccountCheck(s.accounts[a.id])}`);
  }
  out('');
  out('Add one with `claude-nonstop accounts add "Work"` or in `claude-nonstop ui`.');
  return 0;
}

async function signIn(account, bin) {
  out(`Sign in to "${account.label}" in the browser window that opens (Anthropic's own sign-in page).`);
  const code = await claude.runInteractive(bin, accounts.LOGIN_ARGS, accounts.env(account));
  state.forgetAccount(account.id);
  if (code !== 0) {
    say(`sign-in didn't finish. Try again with \`claude-nonstop accounts login ${account.label}\`.`);
    return code;
  }
  const check = await accounts.probe(account, bin);
  out(`Signed in to "${account.label}": ${check.ok ? 'it has usage left' : check.reason}`);
  return 0;
}

async function accountsCommand([sub, ...rest] = []) {
  if (!sub || sub === 'list') return listAccounts();
  const cfg = config.load();
  if (sub === 'add') {
    const bin = requireClaude();
    const account = accounts.createProfile(rest.join(' ').trim().slice(0, 60) || `Account ${cfg.accounts.length + 1}`);
    config.update((c) => c.accounts.push(account));
    log(`added account "${account.label}"`);
    return signIn(account, bin);
  }
  if (sub === 'login') return signIn(pickItem(cfg.accounts, rest[0] || '1', 'account'), requireClaude());
  if (sub === 'check') {
    const bin = requireClaude();
    for (const a of cfg.accounts.filter((x) => x.enabled !== false)) {
      const r = await accounts.probe(a, bin);
      out(`  ${a.label}: ${r.ok ? 'has usage left' : r.reason}`);
    }
    return 0;
  }
  if (sub === 'on' || sub === 'off') {
    const account = pickItem(cfg.accounts, rest[0], 'account');
    config.update((c) => {
      c.accounts.find((a) => a.id === account.id).enabled = sub === 'on';
    });
    out(`${account.label} is ${sub}.`);
    return 0;
  }
  if (sub === 'remove' || sub === 'rm') {
    const account = pickItem(cfg.accounts, rest[0], 'account');
    if (account.kind !== 'profile') {
      say('the main account is your normal Claude Code login. Turn it off with `claude-nonstop accounts off 1` instead.');
      return 1;
    }
    if (!(await prompt.confirm(`Sign out of "${account.label}" and remove it?`, false))) return 0;
    await accounts.remove(account, claude.findClaude());
    config.update((c) => {
      c.accounts = c.accounts.filter((a) => a.id !== account.id);
    });
    out(`Removed "${account.label}".`);
    return 0;
  }
  say(`unknown command: accounts ${sub}`);
  return 1;
}

// ---------------------------------------------------------------- desktop

// Sets the desktop app up through its documented managed settings and says what happened.
// The web page runs this with --quiet and reads only the exit code.
function setUpDesktop(quiet) {
  const cfg = config.load();
  const v = vault.loadWithTokens();
  const want = desktop.settings(cfg, v);
  const tell = quiet ? () => {} : out;
  if (process.env.CLAUDE_NONSTOP_DESKTOP_MANAGED === '0') return 'manual';
  if (!desktop.appInstalled()) {
    tell("- The Claude desktop app isn't installed. Run `claude-nonstop desktop` after installing it (claude.com/download).");
    return 'missing';
  }
  if (desktop.applied(want)) {
    tell('- The Claude desktop app is set up. On its sign-in screen, pick the third-party option to run on your API keys, or Claude.ai for your subscription.');
    return 'done';
  }
  if (process.platform === 'darwin') {
    if (!desktop.macProfile(want)) return 'manual';
    tell('- Claude desktop app: System Settings just opened. Double-click "claude-nonstop for the Claude desktop app", click Install, then quit and reopen the app.');
    return 'profile';
  }
  if (system.apply({ hosts: false, desktopSettings: want }).desktop) {
    tell('- The Claude desktop app is set up. Quit and reopen it, then pick the third-party option on its sign-in screen to run on your API keys.');
    return 'done';
  }
  tell("! The Claude desktop app wasn't set up (the administrator prompt was declined). Run `claude-nonstop desktop` to try again.");
  return 'declined';
}

function desktopCommand(args = []) {
  ensureHome();
  const quiet = args.includes('--quiet');
  const outcome = setUpDesktop(quiet);
  if (outcome === 'done' || outcome === 'profile') return 0;
  if (quiet) return 1;
  const cfg = config.load();
  const v = vault.loadWithTokens();
  const file = desktop.write(cfg, v);
  out('');
  out(outcome === 'manual' ? 'To run the Claude desktop app on your API keys through claude-nonstop:' : 'To set it up by hand instead:');
  desktop.STEPS.forEach((step, i) => out(`  ${i + 1}. ${step}`));
  out(`  Gateway base URL  ${gatewayUrl(cfg)}`);
  out(`  Gateway API key   ${v.gatewayToken}`);
  out('  Auth scheme       Bearer');
  out(`  (also saved in ${file})`);
  return 0;
}

// ---------------------------------------------------------------- setup / service / shell

function optionValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

// Brings an older Claude Code up to the version that continues by itself after a usage
// limit, with Claude Code's own updater.
async function keepClaudeCurrent(bin) {
  const v = await claude.version(bin);
  if (!v || claude.atLeast(v)) return;
  out(`- Updating Claude Code ${v.join('.')}, so sessions continue by themselves after a usage limit...`);
  const r = await claude.capture(bin, ['update'], { timeoutMs: 300000 });
  const after = await claude.version(bin);
  if (after && claude.atLeast(after)) out(`- Claude Code is now ${after.join('.')}.`);
  else out(`! Couldn't update Claude Code (${(r.stderr || r.stdout).trim().split('\n').pop() || `exit ${r.code}`}). Run \`claude update\` to get automatic continue after limits.`);
}

async function setup(args = []) {
  const yes = args.includes('--yes') || args.includes('-y');
  ensureHome();
  const v = vault.loadWithTokens();
  out(`- Secrets are stored encrypted; the encryption key is in ${keystore.describe()}.`);
  const bin = claude.findClaude();
  if (!bin) out('! Claude Code was not found. Install it (https://code.claude.com/docs/en/setup), then run `claude-nonstop setup` again.');
  else await keepClaudeCurrent(bin);
  if (!args.includes('--no-system') && !process.env.CI) {
    // One admin prompt covers the short address and, on Windows and Linux, the desktop app.
    const desktopSettings = args.includes('--no-desktop') ? null : desktop.settings(config.load(), v);
    const done = system.apply({ hosts: !args.includes('--no-hosts'), desktopSettings });
    if (done.hosts) {
      const secure = tls.setup();
      out(`- The web page is at ${secure ? 'https' : 'http'}://${hostsfile.PRIMARY} (also ${hostsfile.NAMES[1]})${secure ? ', with a certificate this computer trusts' : ''}.`);
    } else {
      out(`- The web page is at http://${FRIENDLY_HOST}. For the short address ${hostsfile.PRIMARY}, run \`claude-nonstop setup\` again and allow the change.`);
    }
    if (desktopSettings && desktop.appInstalled()) setUpDesktop(false);
  }
  if (!args.includes('--no-service')) {
    try {
      out(`- The gateway starts whenever you log in: ${service.install()}`);
    } catch (err) {
      out(`! Couldn't set the gateway to start at login (${err.message}). \`claude-nonstop ui\` starts it when needed.`);
    }
  }
  desktop.write(config.load(), v);
  if (!args.includes('--no-shell')) {
    if (yes || (await prompt.confirm('Make plain `claude` go through claude-nonstop in your terminals?', true))) {
      try {
        const changed = shell.install({ binDir: optionValue(args, '--bin-dir') });
        out(`- Plain \`claude\` now goes through claude-nonstop (updated ${changed.join(', ') || 'nothing'}). Open a new terminal to use it.`);
      } catch (err) {
        out(`! Couldn't set up the \`claude\` shortcut: ${err.message}. Use \`claude-nonstop\` in place of \`claude\`.`);
      }
    }
  }
  out('');
  out('Next: add your subscription accounts and API keys in the web UI.');
  if (!args.includes('--no-open')) return ui([]);
  out('Open it any time with `claude-nonstop ui`.');
  return 0;
}

function serviceCommand([sub] = []) {
  if (sub === 'install') {
    out(`The gateway now starts whenever you log in: ${service.install()}`);
    return 0;
  }
  if (sub === 'uninstall') {
    service.uninstall();
    out('The gateway no longer starts at login, and has been stopped.');
    return 0;
  }
  out(service.status().installed ? 'The gateway starts at login.' : "The gateway doesn't start at login. Turn it on with `claude-nonstop service install`.");
  return 0;
}

function shellCommand(args = []) {
  const [sub] = args;
  if (sub === 'install') {
    const changed = shell.install({ binDir: optionValue(args, '--bin-dir') });
    out(`Plain \`claude\` now goes through claude-nonstop (updated ${changed.join(', ') || 'nothing'}). Open a new terminal to use it.`);
    return 0;
  }
  if (sub === 'uninstall') {
    shell.uninstall();
    out('Plain `claude` is back to normal in new terminals.');
    return 0;
  }
  out(shell.status().installed ? 'Plain `claude` goes through claude-nonstop.' : 'Plain `claude` runs Claude Code directly. Change that with `claude-nonstop shell install`.');
  return 0;
}

// ---------------------------------------------------------------- update

async function updateCommand() {
  const result = await require('./update').checkAndInstall();
  if (!result.updated) {
    out(result.note || `claude-nonstop ${result.version} is the latest version.`);
    return 0;
  }
  out(`Updated claude-nonstop ${result.from} → ${result.version}.`);
  if (service.status().installed) {
    try {
      service.install();
      out('The gateway restarted on the new version.');
    } catch (err) {
      say(`the gateway didn't restart (${err.message}); it picks up the new version at your next login.`);
    }
  }
  return 0;
}

// ---------------------------------------------------------------- uninstall / reset

function removeData() {
  keystore.removeMasterKey();
  for (const file of [paths.VAULT, paths.CONFIG, paths.STATE, paths.SERVER, paths.DESKTOP_CONFIG, paths.LOG, `${paths.LOG}.1`, paths.GATEWAY_LOG]) {
    fs.rmSync(file, { force: true });
  }
  fs.rmSync(paths.PROFILES, { recursive: true, force: true });
}

async function uninstall(args = []) {
  const purge = args.includes('--purge');
  service.uninstall();
  out('- The gateway is stopped and no longer starts at login.');
  shell.uninstall();
  out('- Plain `claude` runs Claude Code directly again (in new terminals).');
  if (system.remove().hosts) out(`- The short address ${hostsfile.PRIMARY} and the desktop app's settings are removed from this computer.`);
  else out(`! Couldn't remove the ${hostsfile.PRIMARY} lines from ${hostsfile.hostsPath()} (it needs administrator rights). They're harmless; delete them by hand if you like.`);
  tls.uninstall();
  out('- The local certificate is deleted and no longer trusted.');
  if (process.platform === 'darwin' && fs.existsSync(desktop.PROFILE)) {
    out('- To undo the desktop app setup, remove "claude-nonstop for the Claude desktop app" in System Settings → General → Device Management.');
    fs.rmSync(desktop.PROFILE, { force: true });
  }
  if (purge) {
    const bin = claude.findClaude();
    for (const account of config.load().accounts.filter((a) => a.kind === 'profile')) {
      try {
        await accounts.remove(account, bin);
      } catch {}
    }
    removeData();
    out('- Your saved keys, accounts and settings are deleted.');
  }
  // Installed by install.sh / install.ps1: remove the app and its launcher too.
  const appDir = path.join(paths.HOME, 'app');
  if (paths.APP_SCRIPT.startsWith(appDir + path.sep)) {
    if (process.platform === 'win32') {
      const binDir = path.join(paths.HOME, 'bin');
      try {
        require('./winpath').removeFromUserPath(binDir);
      } catch {}
      // claude-nonstop.cmd is still running this command, and cmd.exe complains if the file
      // disappears under it, so the folders are removed a moment after this process exits.
      const line = `ping -n 3 127.0.0.1 >nul & rmdir /s /q "${appDir}" & rmdir /s /q "${binDir}"${purge ? ` & rmdir "${paths.HOME}"` : ''}`;
      spawn(process.env.comspec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        windowsVerbatimArguments: true,
      }).unref();
    } else {
      fs.rmSync(path.join(os.homedir(), '.local', 'bin', 'claude-nonstop'), { force: true });
      fs.rmSync(appDir, { recursive: true, force: true });
    }
    out('- The claude-nonstop app is removed.');
  } else {
    out('- Installed with npm? Finish with: npm uninstall -g claude-nonstop');
  }
  if (purge) {
    try {
      fs.rmdirSync(paths.HOME); // only succeeds once nothing is left in it
    } catch {}
  } else {
    out(`Your saved keys are still in ${paths.HOME} (encrypted). \`claude-nonstop uninstall --purge\` deletes them.`);
  }
  return 0;
}

async function reset(args = []) {
  if (!args.includes('--yes') && !(await prompt.confirm('Delete every saved API key and start a fresh vault? (accounts stay signed in)', false))) return 0;
  keystore.removeMasterKey();
  for (const file of [paths.VAULT, paths.STATE, paths.DESKTOP_CONFIG]) fs.rmSync(file, { force: true });
  vault.loadWithTokens();
  out('Started a fresh vault. Add your API keys again with `claude-nonstop ui`. The desktop app needs the new file from `claude-nonstop desktop`.');
  return 0;
}

module.exports = {
  serve,
  ui,
  status,
  keys: keysCommand,
  accounts: accountsCommand,
  desktop: desktopCommand,
  setup,
  service: serviceCommand,
  shell: shellCommand,
  update: updateCommand,
  uninstall,
  reset,
};
