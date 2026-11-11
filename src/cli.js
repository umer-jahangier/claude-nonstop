'use strict';

const pkg = require('../package.json');

const HELP = `claude-nonstop ${pkg.version}
Keeps Claude Code (and Codex, Cursor, any OpenAI-compatible tool) working through plan
limits: each request goes out on the first of your Claude and ChatGPT accounts and API
keys with usage left, in the order you choose.

Run Claude Code (after \`claude-nonstop setup\`, plain \`claude\` does this too):
  claude-nonstop [claude args]       first account or key with usage left
  claude-nonstop --api [claude args] skip subscriptions, use API keys
  claude-nonstop --sub [claude args] subscription accounts only

Accounts and keys:
  claude-nonstop ui                  open the web UI: add, sign in, test, reorder
  claude-nonstop status              what's set up, what's in use, and your order
  claude-nonstop move <n> up|down    move account or key n in the order
  claude-nonstop pause <n>           keep account or key n but stop using it
  claude-nonstop resume <n>          use it again
  claude-nonstop keys                check every API key
  claude-nonstop keys add [label]    save a Claude or OpenAI key (typed hidden, or piped on stdin)
  claude-nonstop keys remove <n>     forget key number n
  claude-nonstop accounts            list subscription accounts
  claude-nonstop accounts add [label]   add a Claude account and sign in to it
  claude-nonstop accounts add [label] --chatgpt   add a ChatGPT account (--import-codex takes Codex's sign-in)
  claude-nonstop accounts login <n>  sign in again
  claude-nonstop accounts check      check which accounts have usage left
  claude-nonstop accounts remove <n> sign out and remove account n
  claude-nonstop connect [codex|cursor]  how to point Codex, Cursor or any OpenAI-compatible tool at the gateway
  claude-nonstop desktop             set the Claude desktop app up to use your keys
  claude-nonstop connectors          list the desktop app's connectors
  claude-nonstop connectors add <name> <https-url> [--no-oauth]
  claude-nonstop connectors remove <name>
  claude-nonstop ssh                 servers the desktop app's SSH sessions can use, and their tunnels
  claude-nonstop ssh add <host>      let SSH sessions on <host> reach the gateway (an ~/.ssh/config name works)
  claude-nonstop ssh remove <host>   undo that on <host>

Setup:
  claude-nonstop setup               everything at once, including the terminal, VS Code, and Cursor
  claude-nonstop service install | uninstall | status
  claude-nonstop shell install | uninstall
  claude-nonstop update               install the newest version now (it also updates itself within the hour)
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
    case 'move':
    case 'pause':
    case 'resume':
    case 'desktop':
    case 'connect':
    case 'connectors':
    case 'ssh':
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
