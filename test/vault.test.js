'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { isolate, BIN } = require('./helpers');

const { realHome } = isolate();
const paths = require('../src/paths');
const vault = require('../src/vault');

test('the vault round-trips and creates its tokens once', () => {
  const first = vault.loadWithTokens();
  assert.match(first.gatewayToken, /^cn_/);
  assert.match(first.uiToken, /^cn_/);
  vault.update((v) => v.keys.push({ id: 'abc', label: 'Work', key: 'sk-ant-api03-secret-value', addedAt: 'now' }));
  const again = vault.loadWithTokens();
  assert.equal(again.gatewayToken, first.gatewayToken);
  assert.equal(again.keys[0].key, 'sk-ant-api03-secret-value');
});

test('keys are never written to disk in the clear', () => {
  for (const name of fs.readdirSync(paths.HOME)) {
    const file = `${paths.HOME}/${name}`;
    if (fs.statSync(file).isFile()) assert.ok(!fs.readFileSync(file, 'utf8').includes('sk-ant-api03-secret-value'), `${name} leaks the key`);
  }
});

test('a tampered vault is refused instead of read', () => {
  const raw = JSON.parse(fs.readFileSync(paths.VAULT, 'utf8'));
  const data = Buffer.from(raw.data, 'base64');
  data[0] ^= 0xff;
  fs.writeFileSync(paths.VAULT, JSON.stringify({ ...raw, data: data.toString('base64') }));
  assert.throws(() => vault.load(), /can't be decrypted/);
});

// The OS credential store itself: Keychain on macOS, DPAPI on Windows, Secret Service
// on Linux when one is running. Runs in a separate process with its own service name.
test('the operating system credential store keeps the vault key', (t) => {
  if (process.platform === 'linux' && spawnSync('secret-tool', ['--help']).error) {
    t.skip('no Secret Service on this machine; the file fallback is covered above');
    return;
  }
  const home = fs.mkdtempSync(`${require('os').tmpdir()}/cn-native-`);
  // The real home folder: the macOS login keychain is found through it.
  const env = { ...process.env, HOME: realHome, USERPROFILE: realHome, CLAUDE_NONSTOP_HOME: home, CLAUDE_NONSTOP_KEYCHAIN_SERVICE: `claude-nonstop-test-${process.pid}` };
  delete env.CLAUDE_NONSTOP_KEYSTORE;
  const script = `
    const vault = require(${JSON.stringify(require.resolve('../src/vault'))});
    const keystore = require(${JSON.stringify(require.resolve('../src/keystore'))});
    vault.update((v) => v.keys.push({ id: 'n', label: 'n', key: 'sk-ant-api03-native', addedAt: 'x' }));
    const label = keystore.describe();
    const ok = vault.load().keys[0].key === 'sk-ant-api03-native';
    keystore.removeMasterKey();
    console.log(JSON.stringify({ label, ok }));
  `;
  const r = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout.trim());
  if (process.platform === 'linux' && /file/.test(result.label)) {
    t.skip('Secret Service present but not usable here (no unlocked keyring)');
    return;
  }
  assert.ok(result.ok);
  assert.doesNotMatch(result.label, /file/, `expected an OS store, got ${result.label}`);
  assert.ok(BIN);
});
