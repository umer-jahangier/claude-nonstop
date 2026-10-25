'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { isolate } = require('./helpers');

isolate();
const state = require('../src/state');
const usage = require('../src/usage');

const ANSWER = {
  five_hour: { utilization: 6.0, resets_at: '2026-10-25T17:30:00.379427+00:00' },
  seven_day: { utilization: 75.0, resets_at: '2026-10-26T21:00:00.379444+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 12.4, resets_at: '2026-10-26T21:00:00+00:00' },
  extra_usage: { is_enabled: false },
};

let server;
let seen;
let answer;

before(async () => {
  seen = [];
  answer = { status: 200, body: JSON.stringify(ANSWER) };
  server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(answer.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.CLAUDE_NONSTOP_USAGE_URL = `http://127.0.0.1:${server.address().port}/api/oauth/usage`;
});

after(() => server.close());

// An account whose sign-in token sits in its config folder, the way Claude Code keeps it
// where there's no keychain.
function profile(id, { expiresAt = Date.now() + 3600000, token = `tok-${id}` } = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nonstop-usage-'));
  fs.writeFileSync(path.join(configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt } }));
  return { id, label: id, kind: 'profile', configDir, enabled: true };
}

test("the keychain item is named after the account's config folder, as Claude Code names it", () => {
  assert.equal(usage.keychainService(null), 'Claude Code-credentials');
  assert.equal(usage.keychainService('/Users/muhammadumer/.claude-nonstop/profiles/acct-38570908'), 'Claude Code-credentials-730455dc');
});

test('reads the session and the week, with reset times, and any per-model week', () => {
  const u = usage.parse(JSON.stringify(ANSWER));
  assert.equal(u.session.pct, 6);
  assert.equal(u.session.resetsAt, Date.parse('2026-10-25T17:30:00.379Z'));
  assert.equal(u.week.pct, 75);
  assert.equal(u.sonnet.pct, 12);
  assert.equal(u.opus, undefined);
  assert.throws(() => usage.parse('{}'), /no usage/);
});

test('says it in one line', () => {
  const now = Date.parse('2026-10-25T15:00:00Z');
  const u = usage.parse(JSON.stringify(ANSWER));
  assert.equal(usage.describe(u, now), 'Session 6% (resets in 2 h 30 min) · Week 75% (resets in 1 d 6 h) · Sonnet 12%');
  assert.equal(usage.describe(null), '');
});

test("asks with the account's own sign-in and records the answer", async () => {
  const a = profile('acct-one');
  const u = await usage.refresh(a);
  assert.equal(u.session.pct, 6);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.authorization, 'Bearer tok-acct-one');
  assert.equal(seen[0].headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(state.load().usage['acct-one'].week.pct, 75);
});

test("doesn't ask with an expired token, and keeps the last good numbers with a note", async () => {
  const a = profile('acct-two');
  await usage.refresh(a);
  const stale = profile('acct-two', { expiresAt: Date.now() - 1000 });
  const before = seen.length;
  const u = await usage.refresh(stale);
  assert.equal(seen.length, before, 'no request went out');
  assert.equal(u.session.pct, 6, 'the earlier answer stays');
  assert.match(u.error, /expired/);
});

test('a sign-in the server no longer accepts is said plainly', async () => {
  answer = { status: 401, body: '{}' };
  const u = await usage.refresh(profile('acct-three'));
  assert.match(u.error, /sign in again/);
  assert.equal(u.session, undefined);
  answer = { status: 200, body: JSON.stringify(ANSWER) };
});

test('refreshing everything skips accounts with fresh numbers', async () => {
  const config = require('../src/config');
  const a = profile('acct-four');
  config.update((c) => c.accounts.push(a));
  await usage.refreshAll();
  const before = seen.length;
  await usage.refreshAll({ freshMs: 60000 });
  assert.equal(seen.length, before, 'fresh numbers are left alone');
  config.update((c) => (c.accounts = c.accounts.filter((x) => x.id !== 'acct-four')));
});
