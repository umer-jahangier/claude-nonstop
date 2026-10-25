
'use strict';


const crypto = require('crypto');
const http = require('http');
const https = require('https');

const { classifyResponse } = require('./classify');
const keys = require('./keys');
const relay = require('./relay');
const events = require('./events');
const state = require('./state');
const { log } = require('./files');

const MAX_BODY = 64 * 1024 * 1024;
const MAX_ERROR_BODY = 4 * 1024 * 1024;

// Upstream CLI identity.
// Matches the successful terminal request supplied for comparison.
const CLI_USER_AGENT = 'claude-cli/2.1.310 (external, sdk-cli)';
const CLI_APP = 'cli';

// Never forwarded upstream:
// hop-by-hop headers, client credentials, internal gateway headers,
// and incoming client identity headers.
const DROP_REQUEST = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'accept-encoding',
  'authorization',
  'x-api-key',
  'x-claude-nonstop-keys',
  'user-agent',
  'x-app',
]);

const KEYS_HEADER = 'x-claude-nonstop-keys';

const DROP_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
]);

const agents = {
  'http:': new http.Agent({ keepAlive: true }),
  'https:': new https.Agent({ keepAlive: true }),
};

// -----------------------------------------------------------------------------
// Key selection
// -----------------------------------------------------------------------------

function keysFor(req, cfg, all) {
  const order = relay.keyOrder(cfg, all);
  const named = req.headers[KEYS_HEADER];

  if (!named) return order;

  const ids = new Set(
    String(named)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  return order.filter((k) => ids.has(k.id));
}

// Identify the originating client for local session tracking.
// Requests without the key-selection header retain desktop-style tracking.
function isDesktopClient(req) {
  return !req.headers[KEYS_HEADER];
}

// All upstream requests use the same CLI identity, irrespective of origin.
function usesClaudeCodeIdentity() {
  return true;
}

// Listing models is treated as free for gateway key selection.
const isFree = (req) =>
  req.method === 'GET' &&
  /^\/v1\/models(\/|\?|$)/.test(req.url);

const isCreditMessage = (text) =>
  /credit balance/i.test(text);

// -----------------------------------------------------------------------------
// Authentication
// -----------------------------------------------------------------------------

function sameToken(given, expected) {
  if (!given || !expected) return false;

  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function clientToken(req) {
  const auth = String(req.headers.authorization || '');

  return (
    req.headers['x-api-key'] ||
    (/^bearer /i.test(auth) ? auth.slice(7).trim() : '')
  );
}

// -----------------------------------------------------------------------------
// HTTP helpers
// -----------------------------------------------------------------------------

function sendError(res, status, type, message) {
  const body = JSON.stringify({
    type: 'error',
    error: {
      type,
      message,
    },
  });

  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });

  res.end(body);
}

function readBody(stream, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    stream.on('data', (chunk) => {
      if (settled) return;

      size += chunk.length;

      if (size > limit) {
        settled = true;
        reject(new Error('too large'));
        stream.destroy();
        return;
      }

      chunks.push(chunk);
    });

    stream.on('end', () => {
      if (settled) return;

      settled = true;
      resolve(Buffer.concat(chunks));
    });

    stream.on('error', (error) => {
      if (settled) return;

      settled = true;
      reject(error);
    });

    stream.on('close', () => {
      if (settled) return;

      settled = true;
      reject(new Error('request stream closed unexpectedly'));
    });
  });
}

// -----------------------------------------------------------------------------
// Upstream headers
// -----------------------------------------------------------------------------

function upstreamHeaders(headers, key, length) {
  const out = {};

  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();

    if (!DROP_REQUEST.has(normalizedName)) {
      out[normalizedName] = value;
    }
  }

  // Requests forwarded with an API key should not retain OAuth-only flags.
  if (out['anthropic-beta']) {
    const betas = String(out['anthropic-beta'])
      .split(',')
      .map((b) => b.trim())
      .filter((b) => b && !b.startsWith('oauth-'));

    if (betas.length) {
      out['anthropic-beta'] = betas.join(',');
    } else {
      delete out['anthropic-beta'];
    }
  }

  // Always use CLI headers, including for Desktop-originated requests.
  out['user-agent'] = CLI_USER_AGENT;
  out['x-app'] = CLI_APP;

  // Authenticate the selected upstream API key.
  out['x-api-key'] = key;

  // Maintain existing compression behavior.
  out['accept-encoding'] = 'identity';

  if (length !== undefined && length !== null) {
    out['content-length'] = String(length);
  }

  return out;
}

function responseHeaders(headers, length) {
  const out = {};

  for (const [name, value] of Object.entries(headers)) {
    if (!DROP_RESPONSE.has(name.toLowerCase())) {
      out[name] = value;
    }
  }

  if (length !== undefined) {
    out['content-length'] = String(length);
  }

  return out;
}

// -----------------------------------------------------------------------------
// Forward one request to the upstream API
// -----------------------------------------------------------------------------

function forward(cfg, req, body, key) {
  return new Promise((resolve) => {
    let target;

    try {
      target = new URL(`${cfg.upstream}${req.url}`);
    } catch (error) {
      resolve({ error });
      return;
    }

    const lib =
      target.protocol === 'https:'
        ? https
        : target.protocol === 'http:'
          ? http
          : null;

    if (!lib) {
      resolve({
        error: new Error(
          `Unsupported upstream protocol: ${target.protocol}`,
        ),
      });
      return;
    }

    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const upstream = lib.request(
      target,
      {
        method: req.method,
        headers: upstreamHeaders(req.headers, key, body.length),
        agent: agents[target.protocol],
      },
      (res) => {
        finish({ res, upstream });
      },
    );

    upstream.on('error', (error) => {
      finish({ error });
    });

    upstream.end(body.length ? body : undefined);
  });
}

// -----------------------------------------------------------------------------
// Main gateway request handler
// -----------------------------------------------------------------------------

async function handle(req, res, ctx) {
  const { cfg, vault } = ctx.current();

  // Verify local gateway access.
  if (!sameToken(clientToken(req), vault.gatewayToken)) {
    sendError(
      res,
      401,
      'authentication_error',
      'claude-nonstop gateway: missing or incorrect gateway token. ' +
        'Copy the token from `claude-nonstop desktop` or the web UI.',
    );
    return;
  }

  let body;

  try {
    body = await readBody(req, MAX_BODY);
  } catch (error) {
    if (res.destroyed) return;

    if (error.message === 'too large') {
      sendError(
        res,
        413,
        'request_too_large',
        'claude-nonstop gateway: request body exceeds the 64 MB limit.',
      );
    } else {
      sendError(
        res,
        400,
        'invalid_request_error',
        'claude-nonstop gateway: could not read the request body.',
      );
    }

    return;
  }

  // Preserve original client information for internal session tracking.
  const desktop = isDesktopClient(req);

  // Use the actual outgoing identity for credit and cooldown classification.
  const claudeCode = usesClaudeCodeIdentity();

  const free = isFree(req);

  // Preserve configured relay ordering and session key restrictions.
  const availableKeys = keysFor(req, cfg, vault.keys);

  if (desktop) {
    log(
      'gateway: desktop/unrestricted request received; ' +
        'forwarding using Claude CLI headers',
    );
  }

  let attempted = 0;
  let skipped = 0;
  let lastCreditError = null;

  // Attempt available API keys sequentially.
  for (const entry of availableKeys) {
    // Apply cooldown checks using the outgoing CLI identity.
    if (
      !free &&
      state.isCoolingDown(entry.id, cfg.cooldownMinutes, {
        claudeCode,
      })
    ) {
      skipped++;
      continue;
    }

    attempted++;

    const {
      res: upRes,
      upstream,
      error,
    } = await forward(cfg, req, body, entry.key);

    // Connection errors are not treated as depleted API credits.
    if (error) {
      log(
        `gateway: upstream connection failed for key "${entry.label}": ` +
          error.message,
      );

      if (!res.destroyed && !res.headersSent) {
        sendError(
          res,
          502,
          'api_error',
          `claude-nonstop gateway could not reach ${cfg.upstream}: ` +
            error.message,
        );
      }

      return;
    }

    // -------------------------------------------------------------------------
    // Handle upstream HTTP errors
    // -------------------------------------------------------------------------

    if (upRes.statusCode >= 400) {
      const errBody = await readBody(
        upRes,
        MAX_ERROR_BODY,
      ).catch(() => Buffer.alloc(0));

      const text = errBody.toString('utf8');
      const verdict = classifyResponse(upRes.statusCode, text);

      // Credit exhaustion or other retryable key exhaustion.
      if (verdict === 'used-up') {
        const creditError = isCreditMessage(text);

        // Credit-balance errors observed on CLI-identified requests use
        // Claude Code cooldown scope, consistent with the outgoing headers.
        const scope =
          claudeCode && creditError
            ? { scope: 'claude-code' }
            : {};

        const detail = keys.errorMessage(text);

        lastCreditError = {
          status: upRes.statusCode,
          detail,
          creditError,
          keyId: entry.id,
          label: entry.label,
        };

        state.recordKey(entry.id, {
          verdict: 'used-up',
          status: upRes.statusCode,
          detail,
          ...scope,
        });

        log(
          `gateway: key "${entry.label}" cannot process this ` +
            `CLI-identified request (HTTP ${upRes.statusCode}); ` +
            'retrying the request with the next eligible key',
        );

        // Keep the original event contract for the desktop UI.
        events.emit('switch', {
          keyId: entry.id,
          label: entry.label,
          status: upRes.statusCode,
          detail,
        });

        continue;
      }

      // Return non-credit failures to the requesting client.
      log(
        `gateway: upstream returned HTTP ${upRes.statusCode} ` +
          `for key "${entry.label}" using CLI headers`,
      );

      events.emit('request', {
        keyId: entry.id,
        label: entry.label,
        status: upRes.statusCode,
        path: req.url,
      });

      if (res.destroyed || res.headersSent) return;

      res.writeHead(
        upRes.statusCode,
        responseHeaders(upRes.headers, errBody.length),
      );

      res.end(errBody);
      return;
    }

    // -------------------------------------------------------------------------
    // Successful upstream response
    // -------------------------------------------------------------------------

    if (!free) {
      // This parameter represents the incoming gateway client,
      // not the identity used in the upstream HTTP headers.
      ctx.noteKeyInUse(entry, { desktop });
    }

    log(
      `gateway: request succeeded using key "${entry.label}" ` +
        `(HTTP ${upRes.statusCode}, upstream identity: Claude CLI)`,
    );

    events.emit('request', {
      keyId: entry.id,
      label: entry.label,
      status: upRes.statusCode,
      path: req.url,
    });

    if (res.destroyed || res.headersSent) {
      upstream.destroy();
      return;
    }

    res.writeHead(
      upRes.statusCode,
      responseHeaders(upRes.headers),
    );

    // Forward the upstream stream directly to the client.
    upRes.pipe(res);

    // Stop the upstream request if the client disconnects.
    res.on('close', () => {
      if (!res.writableFinished) {
        upstream.destroy();
      }
    });

    return;
  }

  // ---------------------------------------------------------------------------
  // All eligible keys were exhausted, restricted, or cooling down
  // ---------------------------------------------------------------------------

  events.emit('exhausted', {});

  // Every request goes out as Claude Code, the desktop app's included, so a key needs
  // credit that covers Claude Code whoever asked.
  const creditDetail = lastCreditError ? ` (last error: ${lastCreditError.detail})` : '';
  const message = desktop
    ? `claude-nonstop: no API key has credit for this right now. API keys need credit that covers Claude Code (promotional API credit often does not). Top up a key in the claude-nonstop web UI, or sign in to Claude.ai in the desktop app to use your subscription.${creditDetail}`
    : `claude-nonstop: every API key is used up or cooling down. API keys need credit that covers Claude Code. Top one up or add another in the claude-nonstop web UI (\`claude-nonstop ui\`).${creditDetail}`;

  log(
    'gateway: all eligible keys exhausted for a CLI-identified request; ' +
      `attempted=${attempted}, coolingDown=${skipped}`,
  );

  if (!res.destroyed && !res.headersSent) {
    sendError(
      res,
      402,
      'billing_error',
      message,
    );
  }
}

// -----------------------------------------------------------------------------
// Public exports
// -----------------------------------------------------------------------------

module.exports = {
  handle,
  sameToken,
  sendError,
  readBody,
  KEYS_HEADER,
};
