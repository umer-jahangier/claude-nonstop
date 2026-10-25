'use strict';

// Keeps every account's and key's status known without anyone pressing Check. The gateway
// checks everything when it starts, the web page asks for a check whenever it opens, and a
// new key or a freshly signed-in account is checked straight away. A line that is already
// being checked isn't checked twice, and open pages are told when a check starts and ends.

const config = require('./config');
const vault = require('./vault');
const keys = require('./keys');
const accounts = require('./accounts');
const state = require('./state');
const claude = require('./claude');
const events = require('./events');
const relay = require('./relay');

const running = new Map();

function once(id, work) {
  if (running.has(id)) return running.get(id);
  const done = Promise.resolve()
    .then(work)
    .catch(() => null)
    .finally(() => {
      running.delete(id);
      events.notify('checks', { id, checking: false });
    });
  running.set(id, done);
  events.notify('checks', { id, checking: true });
  return done;
}

const account = (a, bin = claude.findClaude()) => (bin ? once(a.id, () => accounts.probe(a, bin)) : Promise.resolve(null));
const key = (entry, cfg = config.load()) => once(entry.id, () => keys.check(entry, cfg));

// A result counts as known when it gave a clear answer: usage left or a limit for an
// account, works or used up for a key. Anything else (no network yet, say) is tried again.
const known = (c) => Boolean(c && (c.ok || accounts.isLimitReason(c.reason) || c.verdict === 'ok' || c.verdict === 'used-up'));
const fresh = (c, freshMs) => known(c) && Date.now() - c.at < freshMs;

// Checks every account and key that isn't paused, except those with a clear answer from the
// last `freshMs`. Returns once all the checks it started have finished.
function all({ freshMs = 0 } = {}) {
  const cfg = config.load();
  const s = state.load();
  const bin = claude.findClaude();
  return Promise.all([
    ...cfg.accounts.filter((a) => a.enabled !== false && !fresh(s.accounts[a.id], freshMs)).map((a) => account(a, bin)),
    ...vault.load().keys.filter((k) => !relay.isPaused(cfg, 'key', k) && !fresh(s.keys[k.id], freshMs)).map((k) => key(k, cfg)),
  ]);
}

const checking = () => [...running.keys()];

module.exports = { all, account, key, checking };
