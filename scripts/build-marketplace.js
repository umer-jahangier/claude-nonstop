'use strict';

// Builds connectors/: a plugin marketplace with one plugin per connector in src/directory.json
// (Anthropic's public connector directory). In third-party mode the Claude desktop app hides
// the claude.ai directory and its button for adding connectors, but it lists plugin
// marketplaces in Directory → Organization, and a plugin can bring a remote MCP server. So
// this is the official directory again: browse it there, install a connector, sign in.
// Run it after build-directory.js: node scripts/build-marketplace.js

const fs = require('fs');
const path = require('path');

const NAME = 'nonstop-connectors';
const ROOT = path.join(__dirname, '..', 'connectors');
const directory = require('../src/directory.json');
const { carriesCredential } = require('../src/connectorcheck');

const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

// Plugin names are kebab-case; the directory's slugs nearly always are already. Names that
// could pass as Anthropic's own (claude-…, anthropic-…) are reserved, so those get a prefix.
function pluginName(slug) {
  const name = slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const reserved = /^(claude|anthropics?|cc-plugin)-|^(claude|anthropics?|claude-code|claude-mods)$|(claude|anthropic).*official|official.*(claude|anthropic)/;
  return reserved.test(name) ? `connector-${name}` : name;
}

// "Made by Anthropic" connectors run on Anthropic's own servers and work only in standard
// Claude Desktop, not in third-party mode (claude.com/docs/third-party/claude-desktop/extensions).
const madeByAnthropic = (c) => c.author === 'Anthropic';

fs.rmSync(path.join(ROOT, 'plugins'), { recursive: true, force: true });
const version = directory.checkedAt.replace(/-/g, '.').replace(/\.0(\d)/g, '.$1');
const plugins = [];
const seen = new Set();
for (const c of directory.connectors) {
  if (madeByAnthropic(c) || carriesCredential(c.url)) continue;
  const name = pluginName(c.slug);
  if (!name || seen.has(name)) continue;
  seen.add(name);
  const description = `${c.name}: ${c.description}`.replace(/\s+/g, ' ').trim();
  const author = { name: c.author || c.name };
  // The app registers itself with the connector's sign-in (dynamic client registration). The
  // desktop app reads `{ mode: 'dcr' }` the same as `true`, and Claude Code, which runs the
  // desktop app's Code sessions, drops a server whose `oauth` isn't an object.
  const server = { type: c.transport, url: c.url, ...(c.auth === 'oauth' ? { oauth: { mode: 'dcr' } } : {}) };
  write(path.join(ROOT, 'plugins', name, '.claude-plugin', 'plugin.json'), { name, version, description, author, keywords: c.categories });
  write(path.join(ROOT, 'plugins', name, '.mcp.json'), { mcpServers: { [name]: server } });
  plugins.push({ name, source: `./plugins/${name}`, description, version, author, category: c.categories[0] || 'other', keywords: c.categories });
}
write(path.join(ROOT, '.claude-plugin', 'marketplace.json'), {
  name: NAME,
  owner: { name: 'claude-nonstop' },
  metadata: {
    description: `The connectors in Anthropic's directory (${directory.source}) that work in the Claude desktop app's third-party mode, checked ${directory.checkedAt}.`,
    version,
  },
  plugins,
});
console.log(`${plugins.length} connectors -> ${path.relative(process.cwd(), ROOT)}`);
