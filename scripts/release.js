#!/usr/bin/env node
'use strict';

// Publishes a release that installed copies will accept (src/update.js):
//
//   node scripts/release.js 1.16.2 --notes "What changed"
//   node scripts/release.js 1.16.2 --notes-file notes.md
//
// It checks the working tree is clean and package.json says that version, tags the
// current commit v<version> and pushes main and the tag, builds the tarball with
// `git archive`, signs "claude-nonstop <version>" and the tarball's SHA-256 with the
// release key, and creates the GitHub release with the tarball and signature attached.
//
// The key lives outside the repository, in ~/.config/claude-nonstop/release-signing-key.pem
// (or the file CLAUDE_NONSTOP_SIGNING_KEY names); pass --recovery to sign with
// release-recovery-key.pem instead. Never commit either.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { signedText, assetName, verifySignature } = require('../src/update');

const ROOT = path.join(__dirname, '..');
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
  return (r.stdout || '').trim();
};
const fail = (message) => {
  process.stderr.write(`release: ${message}\n`);
  process.exit(1);
};

function main(argv) {
  const version = argv[0];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) fail('usage: node scripts/release.js <version> --notes "..." | --notes-file <file> [--recovery]');
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const notes = opt('--notes-file') ? fs.readFileSync(opt('--notes-file'), 'utf8') : opt('--notes');
  if (!notes) fail('give release notes with --notes or --notes-file');

  const keyFile = process.env.CLAUDE_NONSTOP_SIGNING_KEY ||
    path.join(os.homedir(), '.config', 'claude-nonstop', argv.includes('--recovery') ? 'release-recovery-key.pem' : 'release-signing-key.pem');
  if (!fs.existsSync(keyFile)) fail(`no signing key at ${keyFile}`);
  const key = crypto.createPrivateKey(fs.readFileSync(keyFile));

  if (run('git', ['status', '--porcelain'])) fail('the working tree has uncommitted changes');
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  if (pkgVersion !== version) fail(`package.json says ${pkgVersion}, not ${version}`);
  const tag = `v${version}`;

  // Build and sign before anything is published, so a bad key stops the release early.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nonstop-release-'));
  const tarball = path.join(dir, assetName(version));
  run('git', ['archive', '--format=tar.gz', `--prefix=claude-nonstop-${version}/`, '-o', tarball, 'HEAD']);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  const signature = crypto.sign(null, Buffer.from(signedText(version, digest)), key).toString('base64');
  if (!verifySignature(version, digest, signature)) fail("that key isn't one the updater trusts (src/update.js RELEASE_KEYS)");
  fs.writeFileSync(`${tarball}.sig`, `${signature}\n`);

  if (!run('git', ['tag', '-l', tag])) run('git', ['tag', '-a', tag, '-m', `claude-nonstop ${version}`]);
  run('git', ['push', 'origin', 'HEAD:main']);
  run('git', ['push', 'origin', tag]);
  const notesFile = path.join(dir, 'notes.md');
  fs.writeFileSync(notesFile, notes);
  const url = run('gh', ['release', 'create', tag, tarball, `${tarball}.sig`, '--title', `claude-nonstop ${version}`, '--latest', '--notes-file', notesFile]);
  fs.rmSync(dir, { recursive: true, force: true });
  process.stdout.write(`${url}\nsha256 ${digest}\n`);
}

try {
  main(process.argv.slice(2));
} catch (err) {
  fail(err.message);
}
