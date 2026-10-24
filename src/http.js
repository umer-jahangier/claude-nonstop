'use strict';

const http = require('http');
const https = require('https');

// One HTTP request with a buffered response: resolves { status, headers, body }.
// Status 0 means there was no answer (offline, refused, timed out). Never rejects.
function request(url, { method = 'GET', headers = {}, body, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      resolve({ status: 0, headers: {}, body: err.message });
      return;
    }
    const lib = target.protocol === 'https:' ? https : http;
    // A fresh connection per call, so a short-lived command can exit right away.
    const req = lib.request(target, { method, headers: { connection: 'close', ...headers }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (err) => resolve({ status: 0, headers: {}, body: err.message }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`)));
    req.on('error', (err) => resolve({ status: 0, headers: {}, body: err.message }));
    req.end(body);
  });
}

// Downloads a file to disk, following redirects. Rejects on any failure.
function downloadFile(url, dest, { redirects = 5, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const fs = require('fs');
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.get(target, { headers: { 'user-agent': 'claude-nonstop' }, agent: false }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        resolve(downloadFile(new URL(res.headers.location, target).toString(), dest, { redirects: redirects - 1, timeoutMs }));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`download failed: HTTP ${res.statusCode} from ${target.host}`));
        return;
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', reject);
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('download timed out')));
    req.on('error', reject);
  });
}

module.exports = { request, downloadFile };
