'use strict';

// A stand-in for the `claude` command, used by the tests. It records how it was
// started, answers the usage probe and `auth status`, and, like Claude Code, runs an
// apiKeyHelper from --settings through the system shell to get a key.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR || '';
const account = configDir && configDir.includes(`${path.sep}profiles${path.sep}`) ? path.basename(configDir) : 'default';
// Accounts out of usage: from the environment, plus any that hit their limit mid-session
// (written to FAKE_CLAUDE_LIMITED_FILE, so later probes see it).
const limitedFile = process.env.FAKE_CLAUDE_LIMITED_FILE;
const limited = [
  ...(process.env.FAKE_CLAUDE_LIMITED || '').split(','),
  ...(limitedFile && fs.existsSync(limitedFile) ? fs.readFileSync(limitedFile, 'utf8').split('\n') : []),
].filter(Boolean);

function record(entry) {
  if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(entry)}\n`);
}

if (args.includes('-p')) {
  const isLimited = limited.includes(account) || limited.includes('all');
  record({ kind: 'probe', account });
  process.stdout.write(
    `${JSON.stringify({ type: 'result', is_error: isLimited, result: isLimited ? "You've hit your session limit · resets 3:45pm" : 'OK' })}\n`,
  );
  process.exit(isLimited ? 1 : 0);
}

if (args[0] === 'auth' && args[1] === 'status') {
  record({ kind: 'auth-status', account });
  // Pretty-printed across several lines, exactly like the real `claude auth status --json`.
  const signedOut = (process.env.FAKE_CLAUDE_SIGNED_OUT || '').split(',').includes(account);
  const status = signedOut
    ? { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }
    : { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: `${account}@example.com` };
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  process.exit(0);
}

const entry = {
  kind: 'session',
  account,
  args,
  env: {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || null,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || null,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ? 'set' : null,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? 'set' : null,
    CLAUDE_CODE_API_KEY_HELPER_TTL_MS: process.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS || null,
  },
};
const settingsIndex = args.indexOf('--settings');
const settings = settingsIndex >= 0 ? JSON.parse(args[settingsIndex + 1]) : {};
if (settings.apiKeyHelper) {
  try {
    // Claude Code runs the helper through /bin/sh, or cmd.exe on Windows.
    entry.helperOutput = execSync(settings.apiKeyHelper, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    entry.helperError = String(err.stderr || err.message);
  }
}

// Hooks, run the way Claude Code runs them: through the shell, with JSON on stdin.
const resumeIndex = args.indexOf('--resume');
const sessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : `session-${process.pid}`;
function fire(event, extra = {}) {
  for (const group of (settings.hooks && settings.hooks[event]) || []) {
    if (group.matcher && !group.matcher.split('|').includes(extra.error)) continue;
    for (const h of group.hooks) {
      const input = JSON.stringify({ session_id: sessionId, hook_event_name: event, cwd: process.cwd(), ...extra });
      try {
        execSync(h.command, { input, stdio: ['pipe', 'ignore', 'ignore'] });
      } catch {}
    }
  }
}
entry.session = sessionId;
record(entry);
fire('SessionStart');

// FAKE_CLAUDE_HIT_LIMIT lists accounts whose usage runs out during the session. Like
// Claude Code, the turn stops with StopFailure, then the session waits for the reset and
// continues on its own (FAKE_CLAUDE_WAIT_MS later), unless it's stopped first.
const hits = (process.env.FAKE_CLAUDE_HIT_LIMIT || '').split(',').filter(Boolean);
const onKeys = Boolean(entry.env.ANTHROPIC_AUTH_TOKEN || settings.apiKeyHelper);
if (hits.includes(onKeys ? 'keys' : account)) {
  if (limitedFile && !onKeys) fs.appendFileSync(limitedFile, `${account}\n`);
  process.on('SIGTERM', () => {
    record({ kind: 'stopped', account, session: sessionId });
    process.exit(143);
  });
  setTimeout(() => {
    const error = onKeys ? 'billing_error' : 'rate_limit';
    fire('StopFailure', { error, last_assistant_message: error === 'rate_limit' ? "You've hit your session limit · resets 3:45pm" : 'API Error: Your credit balance is too low' });
    setTimeout(() => {
      fire('UserPromptSubmit', { prompt: 'continue' });
      record({ kind: 'continued', account, session: sessionId });
      process.exit(0);
    }, Number(process.env.FAKE_CLAUDE_WAIT_MS || 4000));
  }, 200);
} else {
  if (args.includes('Continue where you left off.')) fire('UserPromptSubmit', { prompt: 'continue' });
  process.exit(Number(process.env.FAKE_CLAUDE_EXIT || 0));
}
