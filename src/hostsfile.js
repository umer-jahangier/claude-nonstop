'use strict';

// Short addresses for the web page: claude.nonstop and claude-nonstop. Neither is a real
// domain, so this computer's hosts file points both names at itself, the way a router
// answers for its own setup page. Writing that file needs administrator rights, so the
// change is staged here and made by system.js in its single admin prompt. If that's
// declined, the page keeps working at claude-nonstop.localhost, which needs no setup.

const fs = require('fs');
const path = require('path');

const NAMES = ['claude.nonstop', 'claude-nonstop'];
const PRIMARY = NAMES[0];
const BEGIN = '# claude-nonstop: short names for its local web page';
const END = '# end claude-nonstop';

function hostsPath() {
  if (process.env.CLAUDE_NONSTOP_HOSTS_FILE) return process.env.CLAUDE_NONSTOP_HOSTS_FILE;
  if (process.platform === 'win32') return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
  return '/etc/hosts';
}

function read() {
  try {
    return fs.readFileSync(hostsPath(), 'utf8');
  } catch {
    return '';
  }
}

// True when every short name points at this computer, whoever added the lines.
function mapped(text = read()) {
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const [address, ...names] = line.replace(/#.*/, '').trim().split(/\s+/);
    if (address === '127.0.0.1') for (const name of names) seen.add(name.toLowerCase());
  }
  return NAMES.every((name) => seen.has(name));
}

const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

function withoutBlock(text) {
  const kept = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === BEGIN) inside = true;
    else if (inside && line.trim() === END) inside = false;
    else if (!inside) kept.push(line);
  }
  return kept.join(eolOf(text));
}

function withBlock(text) {
  const eol = eolOf(text);
  const base = withoutBlock(text).replace(/\s+$/, '');
  return `${base}${base ? eol + eol : ''}${BEGIN}${eol}127.0.0.1 ${NAMES.join(' ')}${eol}${END}${eol}`;
}

// The hosts file as it should be after adding (or removing) our lines, or null when
// nothing needs to change.
function desired(add) {
  const text = read();
  if (add) return mapped(text) ? null : withBlock(text);
  return text.includes(BEGIN) ? `${withoutBlock(text).replace(/\s+$/, '')}${eolOf(text)}` : null;
}

module.exports = { NAMES, PRIMARY, BEGIN, hostsPath, read, mapped, withBlock, withoutBlock, desired };
