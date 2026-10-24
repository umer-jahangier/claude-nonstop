'use strict';

// What one answer from the Claude API means for the key that got it:
//   'ok'       the key works
//   'used-up'  the key itself is the problem (out of credit, past its spend limit,
//              revoked): move to the next key. It's checked again after the cooldown,
//              in case you topped it up.
//   'keep'     the problem isn't this key (a malformed request, Anthropic overloaded,
//              you're offline): stay on it, because switching keys wouldn't help.
function classifyResponse(status, body) {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401 || status === 402 || status === 403) return 'used-up';
  if (status === 400) return /credit balance|usage limit|spend limit/i.test(String(body)) ? 'used-up' : 'keep';
  // 429 (rate limited) stays on the key: Claude Code already retries it with backoff, and
  // keys in the same organization share one rate limit, so switching wouldn't help. If your
  // keys belong to separate organizations, returning 'used-up' for 429 here spreads the
  // load across them instead (the key comes back after the cooldown).
  return 'keep';
}

module.exports = { classifyResponse };
