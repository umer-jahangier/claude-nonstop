'use strict';

// The names the local server answers to. claude-nonstop.localhost needs no DNS and no
// hosts file: browsers, and macOS itself, resolve every *.localhost name to this computer
// (RFC 6761), so the same address works on every machine. The short names claude.nonstop
// and claude-nonstop are answered only while this computer's hosts file points them here
// (see hostsfile.js), so no outside domain by those names could ever reach this server.

const hostsfile = require('./hostsfile');

const FRIENDLY_HOST = 'claude-nonstop.localhost';
const BASE = ['127.0.0.1', 'localhost', '[::1]', FRIENDLY_HOST];
let NAMES = new Set(BASE);

function allowShortNames(on) {
  NAMES = new Set(on ? [...BASE, ...hostsfile.NAMES] : BASE);
}

// True when a Host header names this server: a known name on a port it listens on.
// `defaultPort` is the port a browser leaves out: 80 for http, 443 for https.
function hostAllowed(host, ports, defaultPort = 80) {
  const match = String(host || '')
    .toLowerCase()
    .match(/^(\[[0-9a-f:.]+\]|[^:]+)(?::(\d+))?$/);
  if (!match || !NAMES.has(match[1])) return false;
  return ports.has(match[2] ? Number(match[2]) : defaultPort);
}

// A browser Origin header, if present, must be one of our own addresses.
function originAllowed(origin, ports) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (url.protocol === 'https:') return hostAllowed(url.host, ports, 443);
    return url.protocol === 'http:' && hostAllowed(url.host, ports);
  } catch {
    return false;
  }
}

// True for the short names, which are the ones served over HTTPS.
const isShortName = (host) => hostsfile.NAMES.includes(String(host || '').toLowerCase().replace(/:\d+$/, ''));

const isLoopback = (address) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

module.exports = { FRIENDLY_HOST, allowShortNames, hostAllowed, originAllowed, isShortName, isLoopback };
