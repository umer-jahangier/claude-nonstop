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

module.exports = { request };
