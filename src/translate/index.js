'use strict';

// The formats the gateway speaks, by name, and which one a request is in.
//
//   messages   Anthropic's Messages API        POST /v1/messages
//   chat       OpenAI's Chat Completions API   POST /v1/chat/completions
//   responses  OpenAI's Responses API          POST /v1/responses
//
// A request in any of them can go out on a line of either provider: Anthropic lines take
// `messages`, OpenAI lines take `responses`. Same format in and out: the body goes through
// as it came (with the line's identity on it). Different: it's read into the shared shape
// and written in the other, and the answer comes back the same way.

const ir = require('./ir');
const messages = require('./messages');
const chat = require('./chat');
const responses = require('./responses');
const gemini = require('./gemini');

// gemini is a wire only: requests go out in it, no client sends it.
const FORMATS = { messages, chat, responses, gemini };

function detect(req) {
  const path = String(req.url || '').split('?')[0];
  if (req.method === 'GET' && /^\/v1\/models(\/|$)/.test(path)) return 'models';
  if (req.method !== 'POST') return null;
  if (path === '/v1/messages') return 'messages';
  if (path === '/v1/chat/completions') return 'chat';
  if (path === '/v1/responses') return 'responses';
  return null;
}

const readRequest = (format, json) => FORMATS[format].readRequest(json);
const writeRequest = (wire, req, options) => FORMATS[wire].writeRequest(req, options);
const readAnswer = (wire, json) => FORMATS[wire].readAnswer(json);
const writeAnswer = (format, answer, options) => FORMATS[format].writeAnswer(answer, options);
const streamReader = (wire) => FORMATS[wire].streamReader();
const streamWriter = (format, options) => FORMATS[format].streamWriter(options);

// An error the way a client of this format expects it.
function errorBody(format, type, message) {
  if (format === 'chat' || format === 'responses') return responses.errorBody(type, message);
  return messages.errorBody(type, message);
}

// The model list as a client of this format reads it.
function modelList(format, models) {
  if (format === 'messages' || format === 'anthropic') {
    return { data: models.map(([id, display_name]) => ({ type: 'model', id, display_name, created_at: '2026-01-01T00:00:00Z' })), has_more: false, first_id: models[0] && models[0][0], last_id: models[models.length - 1] && models[models.length - 1][0] };
  }
  return { object: 'list', data: models.map(([id, , owned_by]) => ({ id, object: 'model', created: 1767225600, owned_by: owned_by || 'claude-nonstop' })) };
}

module.exports = { FORMATS, detect, readRequest, writeRequest, readAnswer, writeAnswer, streamReader, streamWriter, errorBody, modelList, ir };
