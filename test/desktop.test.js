'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isolate } = require('./helpers');

isolate();
const desktop = require('../src/desktop');

const v = { gatewayToken: 'cn_test' };

test("the desktop app's Code sessions aren't held to strict sandbox mode unless you ask", () => {
  assert.equal(desktop.settings({ port: 43117 }, v).coworkEgressAllowedHosts, '["*"]');
  assert.equal('coworkEgressAllowedHosts' in desktop.settings({ port: 43117, desktopStrictSandbox: true }, v), false);
});
