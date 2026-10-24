'use strict';

// Live events from the gateway and the relay, for the web UI's activity feed and the
// pulses that travel along the rope. Kept in memory only: the last 60 events and
// today's request counts.

const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(100);
const recent = [];
let today = { day: new Date().toDateString(), requests: 0, errors: 0, byKey: {} };

function rollDay() {
  const day = new Date().toDateString();
  if (today.day !== day) today = { day, requests: 0, errors: 0, byKey: {} };
}

function emit(type, data = {}) {
  rollDay();
  if (type === 'request') {
    today.requests += 1;
    if (data.status >= 400) today.errors += 1;
    if (data.keyId) today.byKey[data.keyId] = (today.byKey[data.keyId] || 0) + 1;
  }
  const event = { type, at: Date.now(), ...data };
  recent.push(event);
  if (recent.length > 60) recent.shift();
  bus.emit('event', event);
  return event;
}

function stats() {
  rollDay();
  return { requestsToday: today.requests, errorsToday: today.errors, byKey: { ...today.byKey } };
}

module.exports = { bus, emit, stats, recent: () => recent.slice() };
