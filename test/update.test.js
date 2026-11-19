'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { isolate } = require('./helpers');

const { root } = isolate();
const update = require('../src/update');

// Builds a release tarball shaped like GitHub's: one top folder holding the app.
function makeRelease(name, files) {
  const dir = path.join(root, `build-${name}`);
  const top = path.join(dir, `claude-nonstop-${name}`);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(top, file)), { recursive: true });
    fs.writeFileSync(path.join(top, file), text);
  }
  const tarball = path.join(dir, 'release.tar.gz');
  const r = spawnSync('tar', ['-czf', 'release.tar.gz', `claude-nonstop-${name}`], { cwd: dir });
  assert.equal(r.status, 0, String(r.stderr));
  return tarball;
}

test('compares versions the way releases are numbered', () => {
  assert.equal(update.isNewer('1.1.0', '1.0.9'), true);
  assert.equal(update.isNewer('v1.10.0', '1.9.0'), true);
  assert.equal(update.isNewer('1.0.0', '1.0.0'), false);
  assert.equal(update.isNewer('0.9.9', '1.0.0'), false);
});

test('swaps a new release in for the app folder', () => {
  const app = path.join(root, 'app');
  fs.mkdirSync(path.join(app, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(app, 'bin', 'claude-nonstop.js'), 'old');
  fs.writeFileSync(path.join(app, 'stale.txt'), 'left over');
  const tarball = makeRelease('v9.9.9', {
    'bin/claude-nonstop.js': 'new',
    'src/x.js': 'module.exports = 1;',
    'package.json': '{"version":"9.9.9"}',
    'test/ignored.js': 'not shipped',
  });
  update.installTarball(tarball, app);
  assert.equal(fs.readFileSync(path.join(app, 'bin', 'claude-nonstop.js'), 'utf8'), 'new');
  assert.ok(fs.existsSync(path.join(app, 'src', 'x.js')));
  assert.ok(!fs.existsSync(path.join(app, 'stale.txt')), 'old files are gone');
  assert.ok(!fs.existsSync(path.join(app, 'test')), 'only app files are installed');
  assert.ok(!fs.existsSync(`${app}.old`));
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('.update-')), []);
});

test('leaves the installed app alone when a download is broken', () => {
  const app = path.join(root, 'app');
  const tarball = makeRelease('broken', { 'README.md': 'no app in here' });
  assert.throws(() => update.installTarball(tarball, app), /missing claude-nonstop/);
  assert.equal(fs.readFileSync(path.join(app, 'bin', 'claude-nonstop.js'), 'utf8'), 'new');
});

test('a copy installed with npm never updates itself', async () => {
  assert.equal(update.managedInstall(), false);
  const result = await update.checkAndInstall();
  assert.equal(result.updated, false);
  assert.match(result.note, /npm/);
});

// ---------------------------------------------------------------- signed releases

const http = require('http');
const crypto = require('crypto');

const releaseKey = crypto.generateKeyPairSync('ed25519');
process.env.CLAUDE_NONSTOP_TEST_RELEASE_KEY = releaseKey.publicKey.export({ type: 'spki', format: 'pem' });
const sign = (version, file, key = releaseKey.privateKey) => crypto.sign(null, Buffer.from(update.signedText(version, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'))), key).toString('base64');

// Serves files at http://127.0.0.1:<port>/<name>, for a release's download URLs.
function serve(files) {
  const server = http.createServer((req, res) => {
    const body = files[req.url.slice(1)];
    if (body === undefined) return res.writeHead(404).end();
    res.writeHead(200).end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

async function tryRelease(version, tarball, signature) {
  const app = path.join(root, 'app');
  const files = { 'r.tar.gz': fs.readFileSync(tarball), ...(signature === undefined ? {} : { 'r.sig': signature }) };
  const s = await serve(files);
  try {
    await update.installRelease({ tag: `v${version}`, version, tarball: `${s.url}/r.tar.gz`, signature: signature === undefined ? null : `${s.url}/r.sig` }, app);
    return null;
  } catch (err) {
    return err.message;
  } finally {
    s.close();
  }
}

const app = () => fs.readFileSync(path.join(root, 'app', 'bin', 'claude-nonstop.js'), 'utf8');

test('a release signed with a release key installs', async () => {
  const tarball = makeRelease('signed', { 'bin/claude-nonstop.js': 'signed', 'package.json': '{"version":"9.9.10"}' });
  assert.equal(await tryRelease('9.9.10', tarball, sign('9.9.10', tarball)), null);
  assert.equal(app(), 'signed');
});

test('an unsigned, wrongly signed, altered or mislabelled release is refused, and the app is left as it was', async () => {
  const tarball = makeRelease('evil', { 'bin/claude-nonstop.js': 'evil', 'package.json': '{"version":"9.9.11"}' });
  assert.match(await tryRelease('9.9.11', tarball, undefined), /no signed tarball/);
  const stranger = crypto.generateKeyPairSync('ed25519').privateKey;
  assert.match(await tryRelease('9.9.11', tarball, sign('9.9.11', tarball, stranger)), /isn't signed by the claude-nonstop release key/);
  const other = makeRelease('other', { 'bin/claude-nonstop.js': 'other', 'package.json': '{"version":"9.9.11"}' });
  assert.match(await tryRelease('9.9.11', tarball, sign('9.9.11', other)), /isn't signed/, 'a signature for different bytes');
  assert.match(await tryRelease('9.9.12', tarball, sign('9.9.11', tarball)), /isn't signed/, 'a signature for another version');
  const mislabelled = makeRelease('mislabelled', { 'bin/claude-nonstop.js': 'old code', 'package.json': '{"version":"1.0.0"}' });
  assert.match(await tryRelease('9.9.13', mislabelled, sign('9.9.13', mislabelled)), /holds 1.0.0/, 'no rolling back to old code under a new number');
  assert.equal(app(), 'signed');
});

test('the pinned keys are real Ed25519 public keys, and the test key only counts under the test runner', () => {
  assert.equal(update.RELEASE_KEYS.length, 2);
  for (const pem of update.RELEASE_KEYS) assert.equal(crypto.createPublicKey(pem).asymmetricKeyType, 'ed25519');
  const r = spawnSync(process.execPath, ['-e', `const u=require(${JSON.stringify(path.join(__dirname, '..', 'src', 'update'))});process.stdout.write(String(u.verifySignature('1.0.0','00',${JSON.stringify(crypto.sign(null, Buffer.from(update.signedText('1.0.0', '00')), releaseKey.privateKey).toString('base64'))})))`], { env: { ...process.env, NODE_TEST_CONTEXT: '' }, encoding: 'utf8' });
  assert.equal(r.stdout, 'false');
});
