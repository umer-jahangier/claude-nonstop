'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const tlsSocket = require('tls');
const { isolate } = require('./helpers');

isolate();
const tls = require('../src/tls');
const server = require('../src/server');
const hosts = require('../src/hosts');

test('the certificate covers only this computer and its authority signs nothing else', () => {
  const made = tls.issue();
  const ca = new crypto.X509Certificate(made.ca);
  const leaf = new crypto.X509Certificate(made.cert);
  assert.equal(ca.ca, true);
  assert.equal(leaf.ca, false);
  assert.equal(leaf.verify(ca.publicKey), true);
  for (const name of ['claude.nonstop', 'claude-nonstop', 'claude-nonstop.localhost', 'localhost']) assert.equal(leaf.checkHost(name), name);
  assert.ok(!/IP Address/.test(leaf.subjectAltName), 'Bun (Claude Code) refuses an IP address under an IP-constrained authority');
  assert.equal(leaf.checkHost('example.com'), undefined);
  const days = (new Date(leaf.validTo) - new Date(leaf.validFrom)) / 86400000;
  assert.ok(days <= 825, `Apple refuses server certificates valid for ${days} days`);
  assert.ok(!('caKey' in made) && !made.ca.includes('PRIVATE KEY'), 'the authority key is never handed out');
});

test('a browser that trusts the authority completes the handshake for claude.nonstop', async () => {
  const made = tls.issue();
  const srv = https.createServer({ cert: made.cert, key: made.key }, (req, res) => res.end('ok'));
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  const authorized = await new Promise((resolve, reject) => {
    const socket = tlsSocket.connect({ host: '127.0.0.1', port, servername: 'claude.nonstop', ca: made.ca }, () => {
      resolve(socket.authorized);
      socket.end();
    });
    socket.on('error', reject);
  });
  srv.close();
  assert.equal(authorized, true);
});

test('plain-http visits to the short names are sent to https', async () => {
  const ctx = server.createContext();
  const srv = server.createServer(ctx);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  ctx.ports = new Set([80, 443, port]);
  ctx.tlsPort = 443;
  hosts.allowShortNames(true);
  const get = (host, path) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers: { host } }, (res) => { res.resume(); resolve(res); }).on('error', reject);
  });
  try {
    const short = await get('claude.nonstop', '/settings?x=1');
    assert.equal(short.statusCode, 308);
    assert.equal(short.headers.location, 'https://claude.nonstop/settings?x=1');
    const gatewayCall = await get('claude.nonstop', '/health');
    assert.equal(gatewayCall.statusCode, 200, 'the health check and the gateway stay on http');
    const local = await get(`127.0.0.1:${port}`, '/');
    assert.notEqual(local.statusCode, 308, 'other names are left alone');
  } finally {
    hosts.allowShortNames(false);
    srv.close();
  }
});

test("the authority is name-constrained: it vouches for the gateway's own names and nothing else", async () => {
  const tlsLib = require('tls');
  const handshake = (made, servername) => new Promise((resolve) => {
    const server = tlsLib.createServer({ cert: made.cert, key: made.key }, (s) => s.end());
    server.listen(0, '127.0.0.1', () => {
      const c = tlsLib.connect({ port: server.address().port, host: '127.0.0.1', servername, ca: made.ca }, () => {
        c.end();
        server.close();
        resolve('ok');
      });
      c.on('error', (err) => {
        server.close();
        resolve(err.message);
      });
    });
  });
  const own = tls.issue();
  for (const name of ['claude.nonstop', 'claude-nonstop', 'claude-nonstop.localhost', 'localhost']) assert.equal(await handshake(own, name), 'ok', name);
  // Even a certificate the authority itself signed is refused for any other site.
  const foreign = tls.issue({ names: ['example.com'], ips: [] });
  assert.notEqual(await handshake(foreign, 'example.com'), 'ok');
});
