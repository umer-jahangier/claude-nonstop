'use strict';

// HTTPS for the web page, so https://claude.nonstop opens without a "Not secure" warning.
//
// Setup makes a certificate authority that exists for one purpose: it signs a single
// certificate for this computer's own names (claude.nonstop, claude-nonstop,
// claude-nonstop.localhost, localhost, 127.0.0.1, ::1), and its private key is thrown away
// the moment that's done. It is never written to disk, so nothing can ever use the
// authority to sign anything else, which makes trusting it on this computer safe. The
// authority's certificate is then added to the system's trusted roots (macOS asks for your
// password, Windows asks you to confirm, Linux browsers trust it through their NSS store).
//
// Certificates are built here directly in DER, so no OpenSSL is needed on any system.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const paths = require('./paths');
const { readJson, writeJson } = require('./files');

const DIR = path.join(paths.HOME, 'tls');
const FILES = {
  ca: path.join(DIR, 'ca.pem'),
  cert: path.join(DIR, 'cert.pem'),
  key: path.join(DIR, 'key.pem'),
  state: path.join(DIR, 'state.json'),
};
const DNS_NAMES = ['claude.nonstop', 'claude-nonstop', 'claude-nonstop.localhost', 'localhost'];
const IPS = ['127.0.0.1', '::1'];
const CA_NAME = 'claude-nonstop local certificate (this computer only)';
// Apple refuses server certificates valid for more than 825 days.
const LEAF_DAYS = 800;
const RENEW_DAYS = 30;

// ---------------------------------------------------------------- DER

function length(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), length(body.length), body]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const explicit = (n, body) => tlv(0xa0 | n, body);
const octets = (body) => tlv(0x04, body);
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const bits = (body, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), body]));

function integer(buf) {
  let b = Buffer.from(buf);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const value of parts.slice(2)) {
    const chunk = [value & 0x7f];
    for (let v = value >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function time(date) {
  const stamp = date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(stamp.slice(2))) : tlv(0x18, Buffer.from(stamp));
}

function ipBytes(ip) {
  if (ip.includes(':')) {
    const [head, tail = ''] = ip.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const groups = [...h, ...new Array(8 - h.length - t.length).fill('0'), ...t];
    return Buffer.from(groups.flatMap((g) => { const n = parseInt(g, 16); return [n >> 8, n & 0xff]; }));
  }
  return Buffer.from(ip.split('.').map(Number));
}

const name = (cn) => seq(set(seq(oid('2.5.4.10'), utf8('claude-nonstop'))), set(seq(oid('2.5.4.3'), utf8(cn))));
const extension = (id, critical, value) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));
const keyId = (spki) => crypto.createHash('sha1').update(spki).digest();
const pem = (label, der) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;

function certificate({ subject, issuer, spki, issuerSpki, signingKey, days, extensions }) {
  const now = Date.now();
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(crypto.randomBytes(16)),
    ECDSA_SHA256,
    name(issuer),
    seq(time(new Date(now - 86400000)), time(new Date(now + days * 86400000))),
    name(subject),
    spki,
    explicit(3, seq(
      extension('2.5.29.14', false, octets(keyId(spki))),
      extension('2.5.29.35', false, seq(tlv(0x80, keyId(issuerSpki)))),
      ...extensions,
    )),
  );
  const signature = crypto.sign('sha256', tbs, signingKey);
  return seq(tbs, ECDSA_SHA256, bits(signature));
}

// Makes the throwaway authority and the one certificate it will ever sign.
function issue() {
  const ca = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const leaf = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const caSpki = ca.publicKey.export({ type: 'spki', format: 'der' });
  const leafSpki = leaf.publicKey.export({ type: 'spki', format: 'der' });
  const caDer = certificate({
    subject: CA_NAME,
    issuer: CA_NAME,
    spki: caSpki,
    issuerSpki: caSpki,
    signingKey: ca.privateKey,
    days: 3650,
    extensions: [
      extension('2.5.29.19', true, seq(bool(true), integer(Buffer.from([0])))),
      extension('2.5.29.15', true, bits(Buffer.from([0x06]), 1)),
    ],
  });
  const leafDer = certificate({
    subject: 'claude.nonstop',
    issuer: CA_NAME,
    spki: leafSpki,
    issuerSpki: caSpki,
    signingKey: ca.privateKey,
    days: LEAF_DAYS,
    extensions: [
      extension('2.5.29.19', true, seq()),
      extension('2.5.29.15', true, bits(Buffer.from([0x80]), 7)),
      extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),
      extension('2.5.29.17', false, seq(...DNS_NAMES.map((n) => tlv(0x82, Buffer.from(n, 'ascii'))), ...IPS.map((ip) => tlv(0x87, ipBytes(ip))))),
    ],
  });
  // The authority's private key goes out of scope here and is never stored.
  return {
    ca: pem('CERTIFICATE', caDer),
    cert: pem('CERTIFICATE', leafDer),
    key: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    fingerprint: crypto.createHash('sha1').update(caDer).digest('hex').toUpperCase(),
  };
}

// ---------------------------------------------------------------- files

function read() {
  try {
    const cert = fs.readFileSync(FILES.cert, 'utf8');
    const key = fs.readFileSync(FILES.key, 'utf8');
    const ca = fs.readFileSync(FILES.ca, 'utf8');
    return { cert, key, ca, x509: new crypto.X509Certificate(cert) };
  } catch {
    return null;
  }
}

const daysLeft = (x509) => (new Date(x509.validTo).getTime() - Date.now()) / 86400000;

function save(made) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(FILES.ca, made.ca);
  fs.writeFileSync(FILES.cert, made.cert);
  fs.writeFileSync(FILES.key, made.key, { mode: 0o600 });
  writeJson(FILES.state, { fingerprint: made.fingerprint, trusted: false, createdAt: new Date().toISOString() });
}

// ---------------------------------------------------------------- the system's trusted roots

const ok = (r) => r && !r.error && r.status === 0;
const nssDirs = () => {
  const dirs = [path.join(os.homedir(), '.pki', 'nssdb')];
  for (const base of [path.join(os.homedir(), '.mozilla', 'firefox'), path.join(os.homedir(), 'snap', 'firefox', 'common', '.mozilla', 'firefox')]) {
    try {
      for (const d of fs.readdirSync(base)) if (fs.existsSync(path.join(base, d, 'cert9.db'))) dirs.push(path.join(base, d));
    } catch {}
  }
  return dirs;
};

function addTrust(state) {
  if (process.platform === 'darwin') {
    // Runs as you, in your login keychain; macOS shows its own password prompt.
    const keychain = path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');
    return ok(spawnSync('security', ['add-trusted-cert', '-r', 'trustRoot', '-p', 'ssl', '-k', keychain, FILES.ca], { stdio: 'ignore', timeout: 300000 }));
  }
  if (process.platform === 'win32') {
    // The current user's root store; Windows asks you to confirm. No admin rights needed.
    return ok(spawnSync('certutil.exe', ['-user', '-f', '-addstore', 'Root', FILES.ca], { stdio: 'ignore', windowsHide: true, timeout: 300000 }));
  }
  // Linux: Chrome, Chromium and Firefox read NSS stores in your home folder.
  if (spawnSync('certutil', ['-H'], { stdio: 'ignore' }).error) return false;
  let any = false;
  for (const dir of nssDirs()) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      spawnSync('certutil', ['-d', `sql:${dir}`, '-N', '--empty-password'], { stdio: 'ignore' });
    }
    if (ok(spawnSync('certutil', ['-d', `sql:${dir}`, '-A', '-t', 'C,,', '-n', CA_NAME, '-i', FILES.ca], { stdio: 'ignore' }))) any = true;
  }
  return any;
}

function removeTrust(state) {
  if (!state || !state.fingerprint) return true;
  if (process.platform === 'darwin') {
    spawnSync('security', ['remove-trusted-cert', FILES.ca], { stdio: 'ignore', timeout: 300000 });
    return ok(spawnSync('security', ['delete-certificate', '-Z', state.fingerprint], { stdio: 'ignore' }));
  }
  if (process.platform === 'win32') {
    return ok(spawnSync('certutil.exe', ['-user', '-delstore', 'Root', state.fingerprint], { stdio: 'ignore', windowsHide: true }));
  }
  for (const dir of nssDirs()) spawnSync('certutil', ['-d', `sql:${dir}`, '-D', '-n', CA_NAME], { stdio: 'ignore' });
  return true;
}

// ---------------------------------------------------------------- public

// Makes (or renews) the certificate and asks the system to trust it. True when HTTPS is
// ready to use without warnings.
function setup() {
  if (process.env.CLAUDE_NONSTOP_NO_TLS === '1') return false;
  let state = readJson(FILES.state, null);
  const current = read();
  if (state && state.trusted && current && daysLeft(current.x509) > RENEW_DAYS) return true;
  if (state && state.trusted) removeTrust(state);
  const made = issue();
  save(made);
  state = readJson(FILES.state, null);
  if (!addTrust(state)) return false;
  writeJson(FILES.state, { ...state, trusted: true, trustedAt: new Date().toISOString() });
  return true;
}

// What the HTTPS server needs, or null when HTTPS isn't set up and trusted.
function serverOptions() {
  const state = readJson(FILES.state, null);
  const current = read();
  if (!state || !state.trusted || !current || daysLeft(current.x509) <= 0) return null;
  return { cert: current.cert, key: current.key };
}

function uninstall() {
  const state = readJson(FILES.state, null);
  const removed = removeTrust(state);
  fs.rmSync(DIR, { recursive: true, force: true });
  return removed;
}

module.exports = { setup, serverOptions, uninstall, issue, DNS_NAMES, IPS, FILES };
