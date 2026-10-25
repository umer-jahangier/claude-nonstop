'use strict';

// The order lines are tried in: one list you arrange yourself, mixing subscription accounts
// and API keys freely (say Work account, then a key, then the Main account). It's saved as
// `cfg.order`, entries like "account:default" or "key:3a4e47…". Lines missing from it (new
// ones, or a config from before you could mix them) go at the end: accounts, then keys.
//
// A paused line stays in the list but is never used: accounts have `enabled: false`, keys
// are listed in `cfg.pausedKeys`.
//
// Keys next to each other in the order form a group. Within a group the gateway moves to the
// next key in the middle of a request; when the whole group is out, the session moves on to
// the line after the group (an account, or another group of keys).
//
// Plugging the rope into a line in the web UI pins it: it's tried before everything else,
// and if it's a key the gateway switches every request to it at once, running sessions
// included. If the pinned line runs out, the rest of the order carries on as usual.

const lineId = (type, id) => `${type}:${id}`;

const isPaused = (cfg, type, item) => (type === 'account' ? item.enabled === false : (cfg.pausedKeys || []).includes(item.id));

// Every line, paused or not, in your order.
function lines(cfg, keys) {
  const all = [...cfg.accounts.map((item) => ({ type: 'account', item })), ...keys.map((item) => ({ type: 'key', item }))];
  const byId = new Map(all.map((l) => [lineId(l.type, l.item.id), l]));
  const out = [];
  for (const id of cfg.order || []) {
    const l = byId.get(id);
    if (!l) continue;
    out.push(l);
    byId.delete(id);
  }
  return [...out, ...byId.values()];
}

// The lines that can be used, in the order they're tried, with the pinned line first.
function active(cfg, keys) {
  const list = lines(cfg, keys).filter((l) => !isPaused(cfg, l.type, l.item));
  const p = cfg.pinned;
  const i = p ? list.findIndex((l) => l.type === p.type && l.item.id === p.id) : -1;
  return i < 0 ? list : [list[i], ...list.slice(0, i), ...list.slice(i + 1)];
}

// The relay as sessions walk it: { kind: 'account', account } or { kind: 'keys', keys }.
function groups(cfg, keys) {
  const out = [];
  for (const l of active(cfg, keys)) {
    const last = out[out.length - 1];
    if (l.type === 'account') out.push({ kind: 'account', account: l.item });
    else if (last && last.kind === 'keys') last.keys.push(l.item);
    else out.push({ kind: 'keys', keys: [l.item] });
  }
  return out;
}

const accountOrder = (cfg) => active(cfg, []).filter((l) => l.type === 'account').map((l) => l.item);
const keyOrder = (cfg, keys) => active(cfg, keys).filter((l) => l.type === 'key').map((l) => l.item);

// The saved order with one line moved one place up or down, as `cfg.order` entries.
function moved(cfg, keys, type, id, direction) {
  const order = lines(cfg, keys).map((l) => lineId(l.type, l.item.id));
  const i = order.indexOf(lineId(type, id));
  if (i < 0) return null;
  const j = direction === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= order.length) return order;
  [order[i], order[j]] = [order[j], order[i]];
  return order;
}

// A whole new order sent by the web UI: it must name exactly the lines that exist.
function validOrder(cfg, keys, order) {
  const want = lines(cfg, keys).map((l) => lineId(l.type, l.item.id));
  if (!Array.isArray(order) || order.length !== want.length || new Set(order).size !== order.length) return false;
  return order.every((id) => want.includes(id));
}

module.exports = { lineId, isPaused, lines, active, groups, accountOrder, keyOrder, moved, validOrder };
