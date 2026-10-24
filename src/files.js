'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

function ensureHome() {
  fs.mkdirSync(paths.HOME, { recursive: true, mode: 0o700 });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Writes through a temp file and a rename, so a crash never leaves half a file behind.
// Files are created readable by your user only.
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      // Windows refuses the rename while another process has the file open; retry briefly.
      if (attempt >= 40 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      sleepSync(25);
    }
  }
}

function log(message) {
  try {
    ensureHome();
    try {
      if (fs.statSync(paths.LOG).size > 1024 * 1024) fs.renameSync(paths.LOG, `${paths.LOG}.1`);
    } catch {}
    fs.appendFileSync(paths.LOG, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch {}
}

module.exports = { ensureHome, readJson, writeJson, log };
