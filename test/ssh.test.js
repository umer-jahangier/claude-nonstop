'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isolate } = require('./helpers');

isolate();
const ssh = require('../src/ssh');
const desktop = require('../src/desktop');
const hostsfile = require('../src/hostsfile');
const tls = require('../src/tls');

const v = { gatewayToken: 'cn_test' };
const base = { port: 43117, sshTunnelPort: 43118, sshHosts: [] };

test("the desktop app keeps 127.0.0.1 until a server is set up for SSH sessions", () => {
  assert.equal(desktop.settings(base, v).inferenceGatewayBaseUrl, 'http://127.0.0.1:43117');
});

test("with a server set up, the desktop app gets a name it doesn't take for loopback", (t) => {
  t.mock.method(tls, 'serverOptions', () => ({}));
  t.mock.method(hostsfile, 'mapped', () => true);
  assert.equal(desktop.settings({ ...base, sshHosts: ['example'] }, v).inferenceGatewayBaseUrl, 'https://claude.nonstop:43118');
});

test('without the certificate or the short name, the tunnel address is never handed out', (t) => {
  t.mock.method(tls, 'serverOptions', () => null);
  assert.equal(desktop.settings({ ...base, sshHosts: ['example'] }, v).inferenceGatewayBaseUrl, 'http://127.0.0.1:43117');
});

test('only host names ssh reads as a destination are accepted', () => {
  for (const ok of ['cp.praivox.com', 'root@10.0.0.2', 'my-box', '[::1]']) assert.equal(ssh.validHost(ok), true, ok);
  for (const bad of ['-oProxyCommand=x', 'a b', 'a;b', '$(x)', '', null]) assert.equal(ssh.validHost(bad), false, String(bad));
});

// The script runs on a Linux server over SSH; Windows' sh (Git Bash) can't stand in for one.
test('the server script adds and removes exactly its own hosts line and trust anchor', { skip: process.platform === 'win32' && 'the script runs on a Linux server' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-ssh-'));
  const hosts = path.join(root, 'hosts');
  const anchors = path.join(root, 'anchors');
  fs.mkdirSync(anchors);
  fs.writeFileSync(hosts, '127.0.0.1 localhost\n');
  // Point the script's fixed paths at the temporary ones, and run it as if root.
  const sandbox = (script) => script
    .replace(/\/etc\/hosts/g, hosts)
    .replace('[ -d /etc/pki/ca-trust/source/anchors ]', `[ -d ${anchors} ]`)
    .replace('/etc/pki/ca-trust/source/anchors/claude-nonstop.pem', `${anchors}/claude-nonstop.pem`)
    .replace('update-ca-trust', 'true')
    .replace('if [ "$(id -u)" = 0 ]', 'if true');
  const run = (script) => spawnSync('sh', ['-c', sandbox(script)], { encoding: 'utf8' });

  let r = run(ssh.prepareScript('-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n'));
  assert.match(r.stdout, /OK/);
  r = run(ssh.prepareScript('-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n'));
  assert.equal(fs.readFileSync(hosts, 'utf8'), `127.0.0.1 localhost\n127.0.0.1 claude.nonstop  ${ssh.MARK}\n`, 'running it twice leaves one line');
  assert.match(fs.readFileSync(path.join(anchors, 'claude-nonstop.pem'), 'utf8'), /BEGIN CERTIFICATE/);

  run(ssh.prepareScript('', true));
  assert.equal(fs.readFileSync(hosts, 'utf8'), '127.0.0.1 localhost\n');
  assert.equal(fs.existsSync(path.join(anchors, 'claude-nonstop.pem')), false);
});
