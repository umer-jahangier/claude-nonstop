'use strict';

const pkg = require('../package.json');

const HELP = `claude-nonstop ${pkg.version}
Keeps Claude Code working through plan limits: it starts each session on your first
subscription account with usage left, then on your API keys, one by one.

Run Claude Code (after \`claude-nonstop setup\`, plain \`claude\` does this too):
  claude-nonstop [claude args]       first account or key with usage left
  claude-nonstop --api [claude args] skip subscriptions, use API keys
  claude-nonstop --sub [claude args] subscription accounts only

Accounts and keys:
  claude-nonstop ui                  open the web UI: add, sign in, test, reorder
  claude-nonstop status              what's set up and what's in use
  claude-nonstop keys                check every API key
  claude-nonstop keys add [label]    save a key (typed hidden, or piped on stdin)
  claude-nonstop keys remove <n>     forget key number n
  claude-nonstop accounts            list subscription accounts
  claude-nonstop accounts add [label]   add an account and sign in to it
  claude-nonstop accounts login <n>  sign in again
  claude-nonstop accounts check      check which accounts have usage left
  claude-nonstop accounts remove <n> sign out and remove account n
  claude-nonstop desktop             set the Claude desktop app up to use your keys

Setup:
  claude-nonstop setup               everything at once (the installers run this)
  claude-nonstop service install | uninstall | status
  claude-nonstop shell install | uninstall
  claude-nonstop update               install the newest version now (it also updates itself daily)
  claude-nonstop uninstall [--purge]
`;

async function main(argv) {
  const [cmd, ...rest] = argv;
  const launch = () => require('./launch');
  const commands = () => require('./commands');
  switch (cmd) {
    case 'run':
      return launch().launch(rest[0] === '--' ? rest.slice(1) : rest);
    case '--':
      return launch().launch(rest);
    case '--api':
      return launch().launch(rest, { mode: 'api' });
    case '--sub':
      return launch().launch(rest, { mode: 'sub' });
    case 'key-helper':
      return launch().keyHelper();
    case 'hook':
      return require('./supervise').hook();
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return 0;
    case 'version':
    case '--version':
    case '-v':
      process.stdout.write(`${pkg.version}\n`);
      return 0;
    case 'serve':
    case 'ui':
    case 'status':
    case 'keys':
    case 'accounts':
    case 'desktop':
    case 'setup':
    case 'service':
    case 'shell':
    case 'update':
    case 'uninstall':
    case 'reset':
      return commands()[cmd](rest);
    default:
      return launch().launch(argv);
  }
}

module.exports = { main, HELP };
