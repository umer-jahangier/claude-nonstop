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
const limited = (process.env.FAKE_CLAUDE_LIMITED || '').split(',').filter(Boolean);

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
if (settingsIndex >= 0) {
  const settings = JSON.parse(args[settingsIndex + 1]);
  if (settings.apiKeyHelper) {
    try {
      // Claude Code runs the helper through /bin/sh, or cmd.exe on Windows.
      entry.helperOutput = execSync(settings.apiKeyHelper, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      entry.helperError = String(err.stderr || err.message);
    }
  }
}
record(entry);
process.exit(Number(process.env.FAKE_CLAUDE_EXIT || 0));
