'use strict';

// Builds src/directory.json: the connectors in Anthropic's public directory
// (claude.com/connectors) that work in the Claude desktop app's third-party mode, which
// claude-nonstop uses. Each remote server is checked for how it signs users in:
//   'oauth'  it lets the app register itself (dynamic client registration): works
//   'none'   no sign-in needed: works, but its tools load in every conversation
//   others   need a sign-in app only Anthropic has registered, or didn't answer: left out
// Run it before a release: node scripts/build-directory.js

const fs = require('fs');
const path = require('path');

const PAGE = 'https://claude.com/connectors';
const OUT = path.join(__dirname, '..', 'src', 'directory.json');
const { check, carriesCredential } = require('../src/connectorcheck');

function entries(html) {
  const s = html.replace(/\\"/g, '"').replace(/\\u0026/g, '&');
  const seen = new Map();
  for (const m of s.match(/\{"_id":"[^"]+","title":.*?"addedAt":"[^"]*"\}/g) || []) {
    try {
      const o = JSON.parse(m);
      if (!seen.has(o.slug)) seen.set(o.slug, o);
    } catch {}
  }
  return [...seen.values()];
}

async function pool(items, n, work) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const j = i++;
      out[j] = await work(items[j], j);
    }
  }));
  return out;
}

(async () => {
  const html = await (await fetch(PAGE)).text();
  const remote = entries(html).filter((o) => o.type === 'remote' && /^https:\/\//.test(o.serverUrl || ''));
  let done = 0;
  const results = await pool(remote, 24, async (o) => {
    const transport = /\/sse\/?$/.test(o.serverUrl) ? 'sse' : 'http';
    const { auth } = carriesCredential(o.serverUrl) ? { auth: 'credential-in-url' } : await check(o.serverUrl, transport);
    if (++done % 50 === 0) process.stderr.write(`${done}/${remote.length}\n`);
    return { o, transport, auth };
  });
  const tally = {};
  for (const r of results) tally[r.auth] = (tally[r.auth] || 0) + 1;
  const keep = results
    .filter((r) => r.auth === 'oauth' || r.auth === 'none')
    .sort((a, b) => (b.o.popularityScore || 0) - (a.o.popularityScore || 0))
    .map(({ o, transport, auth }) => ({
      slug: o.slug,
      name: o.title,
      description: o.oneLiner || '',
      author: o.author || '',
      icon: o.iconUrl ? o.iconUrl.replace(/\?.*$/, '?w=64&fit=max&auto=format') : null,
      url: o.serverUrl,
      transport,
      auth,
      categories: o.categories || [],
    }));
  const unavailable = results.filter((r) => r.auth !== 'oauth' && r.auth !== 'none').map((r) => ({ name: r.o.title, why: r.auth }));
  fs.writeFileSync(OUT, `${JSON.stringify({ source: PAGE, checkedAt: new Date().toISOString().slice(0, 10), connectors: keep, unavailable }, null, 1)}\n`);
  console.log(`checked ${results.length}:`, tally, `-> ${keep.length} kept in ${path.relative(process.cwd(), OUT)}`);
})();
