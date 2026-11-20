'use strict';

// Bringing an account's Claude Code cloud sessions to this computer, against a stand-in for
// the sessions API that answers the way Anthropic's does (newest events first, in pages).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { isolate, signInFakeAccount } = require('./helpers');

const { root } = isolate();
process.env.CLAUDE_NONSTOP_TRANSCRIPTS_HOME = path.join(root, 'claude');
process.env.CLAUDE_NONSTOP_IMPORT_DIR = path.join(root, 'imports');

const config = require('../src/config');
const cloud = require('../src/cloudsessions');

const here = path.join(root, 'existing-project');
fs.mkdirSync(here, { recursive: true });

// A bare git repository standing in for the session's GitHub repository.
const bare = path.join(root, 'remote.git');
spawnSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
const work = path.join(root, 'seed');
spawnSync('git', ['init', '-q', '-b', 'main', work]);
fs.writeFileSync(path.join(work, 'app.js'), 'console.log(1);\n');
spawnSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'x', '--allow-empty']);
spawnSync('git', ['-C', work, 'add', '.']);
spawnSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'app']);
spawnSync('git', ['-C', work, 'push', '-q', bare, 'main']);

const msg = (seq, type, uuid, content, extra = {}) => ({
  event_id: `ev-${seq}`,
  sequence_num: String(seq),
  event_type: type,
  created_at: `2026-11-01T00:00:${String(seq).padStart(2, '0')}Z`,
  payload: { type, uuid, session_id: 'x', parent_tool_use_id: null, message: { role: type, content }, ...extra },
});
const init = (seq, cwd) => ({ event_id: `ev-${seq}`, sequence_num: String(seq), event_type: 'system', payload: { type: 'system', subtype: 'init', cwd } });

const sessions = {
  // Run on another computer, from a git repository, writing one file whole.
  cse_remote: {
    meta: { id: 'cse_remote', title: 'ERP build', created_at: '2026-11-01T00:00:00Z', updated_at: 'u1', config: { sources: [{ type: 'git_repository', url: `file://${bare}`, revision: 'main' }] } },
    events: [
      init(1, 'D:\\GitHub\\ERP'),
      msg(2, 'user', 'u-1', 'Build the ERP'),
      msg(3, 'assistant', 'a-1', [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'D:\\GitHub\\ERP\\src\\index.js', content: 'export default 1;\n' } }]),
      { ...msg(4, 'assistant', 'sub-1', 'a subagent step'), payload: { ...msg(4, 'assistant', 'sub-1', 'x').payload, parent_tool_use_id: 't1' } },
      msg(5, 'user', 'u-2', [{ type: 'tool_result', tool_use_id: 't1', content: 'written' }]),
      msg(6, 'assistant', 'a-2', [{ type: 'text', text: 'Done.' }]),
    ],
  },
  // Run on this computer, in a folder that still exists, not yet in its transcripts.
  cse_local: {
    meta: { id: 'cse_local', title: 'Local work', created_at: '2026-11-01T00:00:00Z', updated_at: 'u1', config: { sources: [] } },
    events: [init(1, here), msg(2, 'user', 'l-1', 'hello'), msg(3, 'assistant', 'l-2', [{ type: 'text', text: 'hi' }])],
  },
  // Already in this computer's own transcripts.
  cse_known: {
    meta: { id: 'cse_known', title: 'Known', created_at: '2026-11-01T00:00:00Z', updated_at: 'u1', config: { sources: [] } },
    events: [init(1, here), msg(2, 'user', 'known-uuid', 'old'), msg(3, 'assistant', 'k-2', [{ type: 'text', text: 'ok' }])],
  },
  cse_empty: { meta: { id: 'cse_empty', title: 'Empty', updated_at: 'u1', config: {} }, events: [init(1, here)] },
};

let server;
before(async () => {
  // The known session's transcript, as Claude Code itself wrote it.
  const dir = path.join(root, 'claude', 'projects', cloud.projectFolderName(here));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'own.jsonl'), `${JSON.stringify({ type: 'user', uuid: 'known-uuid' })}\n`);

  server = http.createServer((req, res) => {
    const send = (v) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    if (req.headers.authorization !== 'Bearer sk-ant-oat-test-ok') return res.writeHead(401).end('{}');
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/oauth/profile') return send({ organization: { uuid: 'org-1' } });
    if (req.headers['x-organization-uuid'] !== 'org-1') return res.writeHead(403).end('{}');
    if (url.pathname === '/v1/code/sessions') return send({ data: Object.values(sessions).map((s) => s.meta), resume_token: 'r' });
    const m = /^\/v1\/code\/sessions\/([^/]+)\/events$/.exec(url.pathname);
    if (m) {
      // Newest first, two per page.
      const all = [...sessions[m[1]].events].reverse();
      const start = Number(url.searchParams.get('cursor') || 0);
      const page = all.slice(start, start + 2);
      return send({ data: page, next_cursor: start + 2 < all.length ? String(start + 2) : null });
    }
    res.writeHead(404).end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.CLAUDE_NONSTOP_CLOUD_API = `http://127.0.0.1:${server.address().port}`;
  const configDir = path.join(root, 'profile');
  signInFakeAccount(configDir, 'ok');
  config.update((c) => (c.accounts = [{ id: 'acct-1', label: 'Work', kind: 'profile', configDir, enabled: true }]));
});
after(() => server.close());

const account = () => config.load().accounts[0];
const readLines = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test("an account's cloud sessions become Claude Code transcripts, code included", async () => {
  const results = Object.fromEntries((await cloud.importAccount(account())).map((r) => [r.id, r]));
  assert.equal(results.cse_known.outcome, 'already here');
  assert.equal(results.cse_empty.outcome, 'empty');

  const remote = results.cse_remote;
  assert.equal(remote.outcome, 'imported');
  assert.ok(remote.folder.startsWith(path.join(root, 'imports')), 'a session of a repository goes to that project\'s folder');
  const lines = readLines(remote.file);
  const convo = lines.filter((l) => l.type === 'user' || l.type === 'assistant');
  assert.deepEqual(convo.map((l) => l.uuid), ['u-1', 'a-1', 'u-2', 'a-2'], 'the main thread in order, subagent steps left out');
  assert.deepEqual(convo.map((l) => l.parentUuid), [null, 'u-1', 'a-1', 'u-2'], 'each message linked to the one before');
  assert.ok(convo.every((l) => l.sessionId === remote.sessionId && l.cwd === remote.folder));
  assert.equal(lines.at(-1).customTitle, 'ERP build (from Work)');
  assert.equal(path.basename(path.dirname(remote.file)), cloud.projectFolderName(remote.folder), 'filed where claude --resume looks for that folder');
  const extras = path.join(remote.folder, '.claude-nonstop', 'sessions', 'erp-build-remote');
  assert.equal(fs.readFileSync(path.join(extras, 'recovered-files', 'D', 'GitHub', 'ERP', 'src', 'index.js'), 'utf8'), 'export default 1;\n');
  assert.equal(fs.readFileSync(path.join(remote.folder, 'app.js'), 'utf8'), 'console.log(1);\n', 'the repository is cloned as the project folder');
  const handoff = fs.readFileSync(path.join(remote.folder, '.claude-nonstop', 'HANDOFF.md'), 'utf8');
  assert.match(handoff, /Claude session: ERP build/);
  assert.match(handoff, /Build the ERP/);
  assert.match(handoff, /Done\./);
  assert.match(fs.readFileSync(path.join(remote.folder, 'CLAUDE.local.md'), 'utf8'), /@\.claude-nonstop\/HANDOFF\.md/, 'new sessions here load the handoff');
  assert.match(fs.readFileSync(path.join(remote.folder, '.git', 'info', 'exclude'), 'utf8'), /CLAUDE\.local\.md\n\.claude-nonstop\//, 'and none of it is committed');

  const local = results.cse_local;
  assert.equal(local.folder, here, 'a session whose folder is still here is filed under it');
  assert.equal(fs.existsSync(path.join(here, 'SESSION.md')), false, 'nothing is added to your own folder');
});

test("an account at its usage limit still brings its cloud sessions here: reading them spends none of it", async () => {
  const state = require('../src/state');
  state.recordAccount('acct-1', { ok: false, reason: "You've hit your usage limit" });
  try {
    const gateway = require('../src/gateway');
    assert.equal((await gateway.claudeToken(account(), config.load())).token, null, 'chats still skip the limited account');
    const results = await cloud.importAccount(account(), { ids: ['cse_remote'] });
    assert.equal(results.length, 1);
    assert.ok(['imported', 'updated', 'up to date'].includes(results[0].outcome), results[0].outcome);
  } finally {
    state.recordAccount('acct-1', { ok: true, reason: '' });
  }
});

test('importing again skips what is up to date and refreshes what has grown', async () => {
  let results = Object.fromEntries((await cloud.importAccount(account())).map((r) => [r.id, r]));
  assert.equal(results.cse_remote.outcome, 'up to date');
  const file = results.cse_remote.file;

  sessions.cse_remote.events.push(msg(7, 'user', 'u-3', 'One more thing'));
  sessions.cse_remote.meta.updated_at = 'u2';
  results = Object.fromEntries((await cloud.importAccount(account(), { ids: ['cse_remote'] })).map((r) => [r.id, r]));
  assert.equal(results.cse_remote.outcome, 'updated');
  assert.equal(results.cse_remote.file, file, 'the same transcript, so resuming keeps its place');
  assert.equal(readLines(file).filter((l) => l.type === 'user').length, 3);
});

test('the survey says which sessions are here', async () => {
  const list = await cloud.survey(account());
  assert.equal(list.length, 4);
  assert.deepEqual(list.find((s) => s.id === 'cse_remote').imported.upToDate, true);
  assert.equal(list.find((s) => s.id === 'cse_known').imported, null);
});

test('a session with no repository joins the project that worked in the same folder', async () => {
  sessions.cse_fork = {
    meta: { id: 'cse_fork', title: 'ERP docs', created_at: '2026-11-02T00:00:00Z', updated_at: 'u1', config: { sources: [] } },
    events: [
      msg(1, 'user', 'f-1', 'Write the ERP docs'),
      msg(2, 'user', 'f-skill', 'Base directory for this skill: C:\\x'),
      msg(3, 'assistant', 'f-2', [{ type: 'tool_use', id: 't9', name: 'Write', input: { file_path: 'D:\\GitHub\\ERP\\docs\\guide.md', content: '# Guide\n' } }]),
      msg(4, 'assistant', 'f-3', [{ type: 'text', text: 'Docs written.' }]),
    ],
  };
  const [r] = await cloud.importAccount(account(), { ids: ['cse_fork'] });
  const remote = JSON.parse(fs.readFileSync(cloud.STATE(), 'utf8')).cse_remote;
  assert.equal(r.folder, remote.folder, 'filed with the ERP project, where it worked');
  const handoff = fs.readFileSync(path.join(r.folder, '.claude-nonstop', 'HANDOFF.md'), 'utf8');
  assert.match(handoff, /Claude session: ERP docs[\s\S]*Write the ERP docs[\s\S]*Docs written\./);
  assert.doesNotMatch(handoff, /Base directory for this skill/, 'text Claude Code injected is not shown as something you asked');
  assert.equal((await cloud.importAccount(account(), { ids: ['cse_fork'] }))[0].outcome, 'up to date');
  delete sessions.cse_fork;
});

test('imported folders are trusted for Claude Code, except ones whose settings run things', () => {
  const trust = () => JSON.parse(fs.readFileSync(path.join(root, 'claude', '.claude.json'), 'utf8')).projects;
  const remote = JSON.parse(fs.readFileSync(cloud.STATE(), 'utf8')).cse_remote;
  assert.equal(trust()[path.resolve(remote.folder)].hasTrustDialogAccepted, true, 'so the desktop app offers its sessions');
  assert.equal(trust()[here], undefined, 'your own folders are left as they are');
  const risky = path.join(root, 'imports', 'risky');
  fs.mkdirSync(path.join(risky, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(risky, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [] } }));
  assert.equal(cloud.trustFolder(risky), 'runs-things');
  assert.equal(trust()[risky], undefined);
  fs.writeFileSync(path.join(root, 'claude', '.claude.json'), JSON.stringify({ theme: 'dark', projects: { '/x': { allowedTools: ['a'] } } }));
  assert.equal(cloud.trustFolder(remote.folder), 'trusted');
  const after = JSON.parse(fs.readFileSync(path.join(root, 'claude', '.claude.json'), 'utf8'));
  assert.equal(after.theme, 'dark', 'everything else in the file is kept');
  assert.deepEqual(after.projects['/x'], { allowedTools: ['a'] });
  assert.equal(cloud.trustFolder(remote.folder), 'already');
});

test('paths from any computer stay inside the import folder', () => {
  assert.equal(cloud.recoveredPath('C:\\Users\\a\\..\\..\\x.txt'), path.join('C', 'Users', 'a', 'x.txt'));
  assert.equal(cloud.recoveredPath('/etc/../../passwd'), path.join('etc', 'passwd'));
});

test("a ChatGPT account's Codex task on the same repository joins that project, merged into its handoff", async () => {
  const { signInFakeChatgpt } = require('./helpers');
  const bin = path.join(root, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  const diff = 'diff --git a/app.js b/app.js\n--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-console.log(1);\n+console.log(2);\n';
  fs.writeFileSync(path.join(root, 'task.diff'), diff);
  const tasks = { tasks: [{ id: 'task_e_1', title: 'Change the log', status: 'ready', repo_url: `file://${bare}`, updated_at: 't1' }, { id: 'task_e_2', title: 'No repo', status: 'ready', updated_at: 't1' }], cursor: null };
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify(tasks));
  // A stand-in for `codex cloud`: it needs the ChatGPT sign-in in CODEX_HOME.
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh
grep -q oat-test-ok "$CODEX_HOME/auth.json" || { echo "not signed in" >&2; exit 1; }
case "$2" in
  list) cat "${root}/tasks.json" ;;
  diff) cat "${root}/task.diff" ;;
esac
`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  config.update((c) => c.accounts.push({ id: 'gpt-1', label: 'GPT', kind: 'chatgpt', provider: 'openai', enabled: true }));
  signInFakeChatgpt('gpt-1', 'ok');
  const gpt = config.load().accounts.find((a) => a.id === 'gpt-1');

  const results = Object.fromEntries((await cloud.importAny(gpt)).map((r) => [r.id, r]));
  const withRepo = results.task_e_1;
  assert.equal(withRepo.outcome, 'imported');
  const claudeSession = JSON.parse(fs.readFileSync(cloud.STATE(), 'utf8')).cse_remote;
  assert.equal(withRepo.folder, claudeSession.folder, 'the Claude session and the Codex task share one project folder');
  const taskDir = path.join(withRepo.folder, '.claude-nonstop', 'codex', 'change-the-log-sk-e-1');
  assert.equal(fs.readFileSync(path.join(taskDir, 'changes.diff'), 'utf8'), diff);
  assert.equal(fs.readFileSync(path.join(withRepo.folder, 'app.js'), 'utf8'), 'console.log(2);\n', 'the task\'s changes are applied to the clean working tree');
  assert.match(fs.readFileSync(path.join(taskDir, 'TASK.md'), 'utf8'), /Change the log/);
  const handoff = fs.readFileSync(path.join(withRepo.folder, '.claude-nonstop', 'HANDOFF.md'), 'utf8');
  assert.match(handoff, /3 cloud sessions on Work, GPT/);
  assert.match(handoff, /Codex task: Change the log[\s\S]*app\.js/);
  assert.match(handoff, /Claude session: ERP build/);
  assert.equal(results.task_e_2.outcome, 'imported');
  assert.equal(fs.existsSync(path.join(results.task_e_2.folder, 'changes.diff')), true);
  assert.equal(fs.readdirSync(require('os').tmpdir()).some((n) => n.startsWith('claude-nonstop-codex-') && fs.existsSync(path.join(require('os').tmpdir(), n, 'auth.json'))), false, 'the throwaway sign-in is removed');

  assert.equal((await cloud.importAny(gpt)).every((r) => r.outcome === 'up to date'), true);
});

test('a Codex Cloud thread becomes a Claude Code transcript: messages, commands and app actions in order', () => {
  const cc = require('../src/codexcloud');
  const turns = [{ items: [
    { type: 'userMessage', content: [{ type: 'text', text: 'make a test project' }], startedAtMs: 1 },
    { type: 'reasoning', summary: [], startedAtMs: 2 },
    { type: 'commandExecution', id: 'e1', command: 'python3 app.py', commandActions: [{ command: 'python3 app.py' }], aggregatedOutput: 'Total quantity: 42\n', exitCode: 0, cwd: '/workspace', startedAtMs: 3, completedAtMs: 4 },
    { type: 'mcpToolCall', id: 'e2', server: 'codex_apps', tool: 'sites.create_site', arguments: { slug: 's' }, status: 'completed', result: { content: [{ type: 'text', text: 'Action completed' }] }, startedAtMs: 5 },
    { type: 'agentMessage', text: 'Marker CODEX-1', startedAtMs: 6 },
  ] }];
  const lines = cc.transcript(turns, { sessionId: 's1', cwd: '/p', title: 'T' });
  const convo = lines.filter((l) => l.type === 'user' || l.type === 'assistant');
  assert.deepEqual(convo.map((l) => l.type), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  assert.equal(convo[0].message.content, 'make a test project');
  assert.equal(convo[1].message.content[0].name, 'Bash');
  assert.equal(convo[2].message.content[0].tool_use_id, convo[1].message.content[0].id, 'each result answers its call');
  assert.match(convo[2].message.content[0].content, /Total quantity: 42/);
  assert.equal(convo[3].message.content[0].name, 'mcp__codex_apps__sites_create_site');
  assert.equal(convo.at(-1).message.content[0].text, 'Marker CODEX-1');
  assert.deepEqual(convo.map((l) => l.parentUuid).slice(1), convo.map((l) => l.uuid).slice(0, -1), 'one linked chain');
  assert.ok(cc.SKIP_TOP.has('.aws') && cc.SKIP_TOP.has('.codex'), 'credential and tool folders are never copied');
});
