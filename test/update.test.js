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
