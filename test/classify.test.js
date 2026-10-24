'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyResponse } = require('../src/classify');

const error = (message) => JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } });

test('a successful answer means the key works', () => {
  assert.equal(classifyResponse(200, '{}'), 'ok');
});

test('out of credit, past a spend limit, revoked or not allowed means the key is used up', () => {
  assert.equal(classifyResponse(400, error('Your credit balance is too low to access the Anthropic API.')), 'used-up');
  assert.equal(classifyResponse(400, error('You have reached your specified API usage limits.')), 'used-up');
  assert.equal(classifyResponse(401, error('invalid x-api-key')), 'used-up');
  assert.equal(classifyResponse(402, error('billing')), 'used-up');
  assert.equal(classifyResponse(403, error('forbidden')), 'used-up');
});

test("problems that aren't the key's fault keep the key", () => {
  assert.equal(classifyResponse(400, error('messages: field required')), 'keep');
  assert.equal(classifyResponse(500, ''), 'keep');
  assert.equal(classifyResponse(529, ''), 'keep');
  assert.equal(classifyResponse(0, 'connect ECONNREFUSED'), 'keep');
});
