'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { isolate } = require('./helpers');

const { root } = isolate();
delete process.env.CLAUDE_NONSTOP_CLAUDE;
const claude = require('../src/claude');
const paths = require('../src/paths');

function makeClaude(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
  fs.writeFileSync(file, '');
  fs.chmodSync(file, 0o755);
  return file;
}

test("finds Claude Code on PATH but never claude-nonstop's own shim", () => {
  const shims = path.join(paths.HOME, 'shims');
  makeClaude(shims);
  const real = makeClaude(path.join(root, 'real bin'));
  const before = process.env.PATH;
  process.env.PATH = [shims, path.dirname(real)].join(path.delimiter);
  try {
    assert.equal(claude.findClaude(), real);
  } finally {
    process.env.PATH = before;
  }
});

test('a saved Claude Code location that no longer exists is looked up again', () => {
  const moved = makeClaude(path.join(root, 'native bin'));
  const before = process.env.PATH;
  process.env.PATH = path.dirname(moved);
  process.env.CLAUDE_NONSTOP_CLAUDE = path.join(root, 'uninstalled', 'claude');
  try {
    assert.equal(claude.findClaude(), moved);
  } finally {
    process.env.PATH = before;
    delete process.env.CLAUDE_NONSTOP_CLAUDE;
  }
});

// Windows runs .cmd files through cmd.exe, which re-parses arguments. This checks that
// awkward prompts reach the program exactly as typed.
test('passes awkward arguments through a .cmd file unchanged', { skip: process.platform !== 'win32' }, async () => {
  const dir = path.join(root, 'cmd test');
  fs.mkdirSync(dir, { recursive: true });
  const echo = path.join(dir, 'echo-args.js');
  fs.writeFileSync(echo, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  const cmd = path.join(dir, 'claude.cmd');
  fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${echo}" %*\r\n`);
  const args = ['fix the "bug" & ship', '100%', 'a^b', 'x|y', '<tag>', 'C:\\path with spaces\\', ''];
  const r = await claude.capture(cmd, args, { env: process.env });
  assert.deepEqual(JSON.parse(r.stdout), args);
});
