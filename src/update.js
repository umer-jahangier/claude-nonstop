'use strict';

// Keeps claude-nonstop current without anyone re-running the installer. The background
// gateway checks GitHub for a newer release 10 minutes after it starts and then once a
// day, unpacks it next to the running copy, swaps it in, and restarts on it. Only copies
// set up by install.sh / install.ps1 update themselves; an npm install updates via npm.
//
// Nothing is installed on GitHub's word alone. Each release carries its own tarball and a
// signature over "claude-nonstop <version>" and the tarball's SHA-256, made with a release
// key that never leaves the publisher's computer (scripts/release.js). The updater checks
// that signature against the public keys pinned below, the digest of what it downloaded,
// and the version inside the tarball, and installs nothing when any of them doesn't match.
// So a release published by someone who took over the repository or the GitHub account
// can't reach this computer. A second, recovery key kept offline can sign if the first is lost.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const paths = require('./paths');
const config = require('./config');
const { request, downloadFile } = require('./http');
const { log } = require('./files');
const crypto = require('crypto');
const pkg = require('../package.json');

const RELEASE_KEYS = [
  // release-signing-key
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA9j7q7kCKr0uFBQvb87Wpf+70LXpQzN15Bg74vI6z2u0=\n-----END PUBLIC KEY-----\n',
  // release-recovery-key (kept offline)
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAiJpGrmkR+tqQwoqVUdJCtPbMzS304HVxCtT2XrlLVgs=\n-----END PUBLIC KEY-----\n',
];
// Only the test runner may add a key (its own throwaway one).
const releaseKeys = () => [...RELEASE_KEYS, ...(process.env.NODE_TEST_CONTEXT && process.env.CLAUDE_NONSTOP_TEST_RELEASE_KEY ? [process.env.CLAUDE_NONSTOP_TEST_RELEASE_KEY] : [])];

// What a release signature covers: the version it claims and the exact tarball bytes.
const signedText = (version, sha256) => `claude-nonstop ${version}\nsha256 ${sha256}\n`;
const assetName = (version) => `claude-nonstop-${version}.tar.gz`;

// True when `signature` (base64) over this version and digest was made by a release key.
function verifySignature(version, sha256, signature) {
  const message = Buffer.from(signedText(version, sha256));
  let sig;
  try {
    sig = Buffer.from(String(signature).trim(), 'base64');
  } catch {
    return false;
  }
  return releaseKeys().some((pem) => {
    try {
      return crypto.verify(null, message, crypto.createPublicKey(pem), sig);
    } catch {
      return false;
    }
  });
}

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const REPO = 'umer-jahangier/claude-nonstop';
const APP_DIR = path.join(paths.HOME, 'app');
const APP_FILES = ['bin', 'src', 'package.json', 'README.md', 'LICENSE'];
const releasesUrl = () => process.env.CLAUDE_NONSTOP_RELEASES_URL || `https://api.github.com/repos/${REPO}/releases/latest`;

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
    const json = JSON.parse(r.body);
    const tag = json.tag_name;
    if (!tag) return null;
    const version = tag.replace(/^v/, '');
    const url = (name) => ((json.assets || []).find((a) => a && a.name === name) || {}).browser_download_url || null;
    return { tag, version, tarball: url(assetName(version)), signature: url(`${assetName(version)}.sig`) };
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
function installTarball(tarball, appDir, { version } = {}) {
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
    if (version) {
      let inside = null;
      try {
        inside = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
      } catch {}
      if (inside !== version) throw new Error(`the update says it is ${version} but holds ${inside || 'no version'}`);
    }
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

// Downloads a release's tarball and signature, checks both, and swaps it in for appDir.
async function installRelease(release, appDir) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nonstop-'));
  try {
    if (!release.tarball || !release.signature) throw new Error(`release ${release.tag} has no signed tarball; not installed`);
    const tarball = path.join(dir, 'release.tar.gz');
    const sigFile = path.join(dir, 'release.tar.gz.sig');
    await downloadFile(release.tarball, tarball);
    await downloadFile(release.signature, sigFile);
    const digest = sha256File(tarball);
    if (!verifySignature(release.version, digest, fs.readFileSync(sigFile, 'utf8'))) {
      throw new Error(`release ${release.tag} isn't signed by the claude-nonstop release key; not installed`);
    }
    installTarball(tarball, appDir, { version: release.version });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function checkAndInstall() {
  if (!managedInstall()) return { updated: false, version: pkg.version, note: 'installed with npm: update with `npm install -g @umer-jahangier/claude-nonstop`' };
  const release = await latestRelease();
  if (!release || !isNewer(release.version, pkg.version)) return { updated: false, version: pkg.version };
  await installRelease(release, APP_DIR);
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
  // A new release reaches this computer within the hour: checked a minute after the gateway
  // starts, then hourly (one small request to GitHub, well inside its unauthenticated limit).
  setTimeout(run, Number(process.env.CLAUDE_NONSTOP_UPDATE_DELAY_MS || 60 * 1000)).unref();
  setInterval(run, 60 * 60 * 1000).unref();
}

module.exports = { installRelease, RELEASE_KEYS, signedText, assetName, verifySignature, isNewer, latestRelease, installTarball, checkAndInstall, schedule, managedInstall };
