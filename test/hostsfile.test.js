'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { isolate } = require('./helpers');

const { env } = isolate();
const hostsfile = require('../src/hostsfile');
const hosts = require('../src/hosts');

test('adds the short names to the hosts file and takes only them back out', () => {
  fs.writeFileSync(env.CLAUDE_NONSTOP_HOSTS_FILE, '127.0.0.1 localhost\r\n::1 localhost\r\n# a note of yours\r\n');
  assert.equal(hostsfile.mapped(), false);
  assert.equal(hostsfile.install(), true);
  const added = fs.readFileSync(env.CLAUDE_NONSTOP_HOSTS_FILE, 'utf8');
  assert.match(added, /^127\.0\.0\.1 claude\.nonstop claude-nonstop\r$/m);
  assert.match(added, /# a note of yours/);
  assert.equal(hostsfile.install(), true, 'a second run changes nothing');
  assert.equal(fs.readFileSync(env.CLAUDE_NONSTOP_HOSTS_FILE, 'utf8'), added);
  assert.equal(hostsfile.uninstall(), true);
  assert.equal(fs.readFileSync(env.CLAUDE_NONSTOP_HOSTS_FILE, 'utf8'), '127.0.0.1 localhost\r\n::1 localhost\r\n# a note of yours\r\n');
});

test('counts names someone else already mapped, and ignores ones pointed elsewhere', () => {
  assert.equal(hostsfile.mapped('127.0.0.1 claude.nonstop\n127.0.0.1 claude-nonstop # mine\n'), true);
  assert.equal(hostsfile.mapped('10.0.0.5 claude.nonstop claude-nonstop\n'), false);
  assert.equal(hostsfile.mapped('# 127.0.0.1 claude.nonstop claude-nonstop\n'), false);
});

test('the server answers to the short names only while they point here', () => {
  const ports = new Set([80, 43117]);
  hosts.allowShortNames(false);
  assert.equal(hosts.hostAllowed('claude.nonstop', ports), false);
  hosts.allowShortNames(true);
  assert.equal(hosts.hostAllowed('claude.nonstop', ports), true);
  assert.equal(hosts.hostAllowed('claude-nonstop:43117', ports), true);
  assert.equal(hosts.originAllowed('http://claude.nonstop', ports), true);
  assert.equal(hosts.hostAllowed('claude.nonstop.evil.example', ports), false);
  hosts.allowShortNames(false);
});
