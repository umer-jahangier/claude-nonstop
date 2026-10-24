'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { isolate } = require('./helpers');

const { env } = isolate();
process.env.SHELL = '/bin/zsh';
const shell = require('../src/shell');

const posix = process.platform !== 'win32';

test('adds one marked block, and removes it cleanly', { skip: !posix }, () => {
  const zshrc = path.join(env.HOME, '.zshrc');
  fs.writeFileSync(zshrc, 'export EDITOR=vim\n');
  shell.install({ binDir: '/opt/kc/bin' });
  shell.install({ binDir: '/opt/kc/bin' });
  const text = fs.readFileSync(zshrc, 'utf8');
  assert.equal(text.split('>>> claude-nonstop >>>').length - 1, 1, 'block added twice');
  assert.ok(text.startsWith('export EDITOR=vim\n'));
  assert.equal(shell.status().installed, true);
  shell.uninstall();
  assert.equal(fs.readFileSync(zshrc, 'utf8').trim(), 'export EDITOR=vim');
  assert.equal(shell.status().installed, false);
});

for (const sh of ['bash', 'zsh']) {
  test(`in ${sh}, \`claude\` becomes claude-nonstop, even over an alias`, { skip: !posix || spawnSync(sh, ['-c', 'true']).error }, () => {
    const dir = fs.mkdtempSync(path.join(env.HOME, 'bin-'));
    fs.writeFileSync(path.join(dir, 'claude-nonstop'), '#!/bin/sh\necho "claude-nonstop $*"\n');
    fs.chmodSync(path.join(dir, 'claude-nonstop'), 0o755);
    const rc = path.join(dir, 'rc');
    fs.writeFileSync(rc, `alias claude="echo real-claude"\n${shell.posixBlock(dir)}\n`);
    const script = sh === 'bash' ? `shopt -s expand_aliases; source "${rc}"; claude --model opus "two words"` : `source "${rc}"; claude --model opus "two words"`;
    // HOME is set because some systems' shell startup files (Homebrew's, on CI Macs) complain without it.
    const r = spawnSync(sh, ['-c', script], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: env.HOME } });
    assert.doesNotMatch(r.stderr, /claude|syntax|parse|not found/i);
    assert.equal(r.stdout.trim(), 'claude-nonstop run --model opus two words');
  });
}

test('without claude-nonstop installed, the block leaves `claude` alone', { skip: !posix }, () => {
  const rc = path.join(env.HOME, 'rc-missing');
  fs.writeFileSync(rc, `${shell.posixBlock()}\n`);
  const r = spawnSync('bash', ['-c', `source "${rc}"; type -t claude || echo none`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: env.HOME } });
  assert.equal(r.stdout.trim(), 'none');
});

// Changes the real user PATH, so it only runs on throwaway CI machines.
test('on Windows, a claude.cmd shim goes first on the user PATH', { skip: process.platform !== 'win32' || !process.env.CI }, () => {
  const winpath = require('../src/winpath');
  shell.install();
  assert.ok(fs.existsSync(path.join(shell.SHIMS, 'claude.cmd')));
  assert.ok(winpath.userPath().toLowerCase().startsWith(shell.SHIMS.toLowerCase()));
  shell.uninstall();
  assert.ok(!winpath.userPath().toLowerCase().includes(shell.SHIMS.toLowerCase()));
});
