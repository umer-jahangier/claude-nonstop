'use strict';

// Keeps claude-nonstop current without anyone re-running the installer. The background
// gateway checks GitHub for a newer release 10 minutes after it starts and then once a
// day, unpacks it next to the running copy, swaps it in, and restarts on it. Only copies
// set up by install.sh / install.ps1 update themselves; an npm install updates via npm.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const paths = require('./paths');
const config = require('./config');
const { request, downloadFile } = require('./http');
const { log } = require('./files');
const pkg = require('../package.json');

const REPO = 'umer-jahangier/claude-nonstop';
const APP_DIR = path.join(paths.HOME, 'app');
const APP_FILES = ['bin', 'src', 'package.json', 'README.md', 'LICENSE'];
const releasesUrl = () => process.env.CLAUDE_NONSTOP_RELEASES_URL || `https://api.github.com/repos/${REPO}/releases/latest`;
const tarballUrl = (tag) =>
  (process.env.CLAUDE_NONSTOP_TARBALL_URL || `https://codeload.github.com/${REPO}/tar.gz/refs/tags/{tag}`).replace('{tag}', tag);

const managedInstall = () => paths.APP_SCRIPT.startsWith(APP_DIR + path.sep);

function isNewer(candidate, current) {
  const parse = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}

async function latestRelease() {
  const r = await request(releasesUrl(), { headers: { 'user-agent': 'claude-nonstop', accept: 'application/vnd.github+json' }, timeoutMs: 15000 });
  if (r.status !== 200) return null;
  try {
    const tag = JSON.parse(r.body).tag_name;
    return tag ? { tag, version: tag.replace(/^v/, '') } : null;
  } catch {
    return null;
  }
}

function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      // Windows can briefly refuse while antivirus scans the new files.
      if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

// Unpacks a release tarball and swaps it in for appDir. A running process keeps the code
// it already loaded; its next start runs the new version.
function installTarball(tarball, appDir) {
  const work = fs.mkdtempSync(path.join(path.dirname(appDir), '.update-'));
  try {
    fs.copyFileSync(tarball, path.join(work, 'release.tar.gz'));
    // macOS, Linux and Windows 10+ all ship a tar that reads .tar.gz. A relative name
    // keeps Windows drive letters away from tar's "host:path" parsing.
    const r = spawnSync('tar', ['-xzf', 'release.tar.gz'], { cwd: work, windowsHide: true, encoding: 'utf8' });
    if (r.error || r.status !== 0) throw new Error(`couldn't unpack the update: ${(r.stderr || (r.error && r.error.message) || '').trim()}`);
    const root = fs
      .readdirSync(work)
      .map((name) => path.join(work, name))
      .find((p) => fs.statSync(p).isDirectory());
    if (!root || !fs.existsSync(path.join(root, 'bin', 'claude-nonstop.js'))) throw new Error('the update is missing claude-nonstop');
    const next = path.join(work, 'next');
    fs.mkdirSync(next);
    for (const name of APP_FILES) {
      if (fs.existsSync(path.join(root, name))) fs.cpSync(path.join(root, name), path.join(next, name), { recursive: true });
    }
    const old = `${appDir}.old`;
    fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(appDir)) renameWithRetry(appDir, old);
    renameWithRetry(next, appDir);
    fs.rmSync(old, { recursive: true, force: true });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function checkAndInstall() {
  if (!managedInstall()) return { updated: false, version: pkg.version, note: 'installed with npm: update with `npm install -g github:umer-jahangier/claude-nonstop`' };
  const release = await latestRelease();
  if (!release || !isNewer(release.version, pkg.version)) return { updated: false, version: pkg.version };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nonstop-'));
  try {
    const tarball = path.join(dir, 'release.tar.gz');
    await downloadFile(tarballUrl(release.tag), tarball);
    installTarball(tarball, APP_DIR);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  log(`updated from ${pkg.version} to ${release.version}`);
  return { updated: true, from: pkg.version, version: release.version };
}

// Runs inside the gateway. `restart` is called after an update has been swapped in.
function schedule(restart) {
  const run = async () => {
    if (config.load().autoUpdate === false) return;
    try {
      const result = await checkAndInstall();
      if (result.updated) restart();
    } catch (err) {
      log(`update check failed: ${err.message}`);
    }
  };
  setTimeout(run, Number(process.env.CLAUDE_NONSTOP_UPDATE_DELAY_MS || 10 * 60 * 1000)).unref();
  setInterval(run, 24 * 60 * 60 * 1000).unref();
}

module.exports = { isNewer, latestRelease, installTarball, checkAndInstall, schedule, managedInstall };
