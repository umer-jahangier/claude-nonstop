'use strict';

// The order lines are tried in. Normally: accounts top to bottom, then API keys top to
// bottom. Plugging the rope into a line in the web UI pins it:
//   a pinned account is tried before every other account (new sessions start there);
//   a pinned API key skips the accounts and goes first among the keys, and the gateway
//   switches every request to it at once, running sessions included.
// Either way, if the pinned line runs out, the rest of the relay carries on as usual.

const front = (list, id) => {
  const i = list.findIndex((item) => item.id === id);
  return i < 0 ? list : [list[i], ...list.slice(0, i), ...list.slice(i + 1)];
};

function accountOrder(cfg) {
  const enabled = cfg.accounts.filter((a) => a.enabled !== false);
  const pinned = cfg.pinned;
  if (!pinned) return enabled;
  if (pinned.type === 'key') return [];
  return front(enabled, pinned.id);
}

function keyOrder(cfg, keys) {
  const pinned = cfg.pinned;
  return pinned && pinned.type === 'key' ? front(keys, pinned.id) : keys;
}

module.exports = { accountOrder, keyOrder };
