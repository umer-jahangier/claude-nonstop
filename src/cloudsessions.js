'use strict';

// Brings an account's Claude Code cloud sessions to this computer, so adding or switching
// accounts never strands a project. Claude.ai keeps every Claude Code session an account has
// run through Remote Control, the web or the desktop app, including ones started on other
// computers, with its whole conversation. Claude Code reads that list itself (it's how
// `claude --teleport` and Remote Control work); claude-nonstop reads it the same way, with
// the account's own sign-in, and writes each session as an ordinary Claude Code transcript
// under ~/.claude/projects, where `claude --resume` (and the desktop app's Code tab) list it.
//
// Where a session's code is:
//   - its folder still exists here: the session is filed under that folder;
//   - it was cloned from a git repository: the repository is cloned into the import folder
//     (with your own git credentials), at the revision the session started from;
//   - neither (another computer's folder): the import folder holds every file the session
//     wrote whole, rebuilt from its transcript, marked as recovered.
// Import folders live in ~/Claude Imports/<account>/<session>. A session already on this
// computer is never imported twice, and re-importing refreshes one that has grown since.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const paths = require('./paths');
const config = require('./config');
const accounts = require('./accounts');
const { request } = require('./http');
const { readJson, writeJson, log } = require('./files');

const API = () => (process.env.CLAUDE_NONSTOP_CLOUD_API || 'https://api.anthropic.com').replace(/\/+$/, '');
const STATE = () => path.join(paths.HOME, 'imports.json');
const IMPORT_ROOT = () => process.env.CLAUDE_NONSTOP_IMPORT_DIR || path.join(os.homedir(), 'Claude Imports');
const claudeHome = () => process.env.CLAUDE_NONSTOP_TRANSCRIPTS_HOME || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const projectsDir = () => path.join(claudeHome(), 'projects');

// Claude Code files a session under its folder's path with every other character a dash.
const projectFolderName = (cwd) => String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
const slug = (s) => String(s || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'session';

// ---------------------------------------------------------------- the account's cloud

async function connect(account) {
  const cfg = config.load();
  const { token, why } = await require('./gateway').claudeToken(account, cfg);
  if (!token) throw new Error(`${account.label}: ${why}`);
  const base = { authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20,ccr-byoc-2025-07-29' };
  const profile = await request(`${API()}/api/oauth/profile`, { headers: base });
  let org = null;
  try {
    org = JSON.parse(profile.body).organization.uuid;
  } catch {}
  if (!org) throw new Error(`${account.label}: couldn't read the account's organization (HTTP ${profile.status})`);
  const headers = { ...base, 'x-organization-uuid': org };
  const get = async (p) => {
    for (let attempt = 0; ; attempt++) {
      const r = await request(`${API()}${p}`, { headers, timeoutMs: 60000 });
      if (r.status === 200) return JSON.parse(r.body);
      if ((r.status === 429 || r.status >= 500 || r.status === 0) && attempt < 4) {
        await new Promise((done) => setTimeout(done, 1000 * 2 ** attempt));
        continue;
      }
      throw new Error(`${account.label}: ${p.split('?')[0]} answered HTTP ${r.status}`);
    }
  };
  return { get };
}

async function listSessions(cloud) {
  const all = [];
  let cursor = null;
  for (let page = 0; page < 200; page++) {
    const j = await cloud.get(`/v1/code/sessions?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const data = Array.isArray(j.data) ? j.data : [];
    all.push(...data);
    if (data.length < 100 || !j.resume_token || j.resume_token === cursor) break;
    cursor = j.resume_token;
  }
  return all;
}

// Every event of a session, oldest first.
async function sessionEvents(cloud, id) {
  const events = [];
  let cursor = null;
  for (let page = 0; page < 10000; page++) {
    const j = await cloud.get(`/v1/code/sessions/${encodeURIComponent(id)}/events?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const data = Array.isArray(j.data) ? j.data : [];
    events.push(...data);
    if (!data.length || !j.next_cursor || j.next_cursor === cursor) break;
    cursor = j.next_cursor;
  }
  const seen = new Set();
  return events
    .filter((e) => e && !seen.has(e.event_id) && seen.add(e.event_id))
    .sort((a, b) => Number(a.sequence_num) - Number(b.sequence_num));
}

// ---------------------------------------------------------------- a transcript

// The session's working folder as its first init event recorded it.
const originalCwd = (events) => {
  const init = events.find((e) => e.payload && e.payload.subtype === 'init' && e.payload.cwd);
  return init ? init.payload.cwd : null;
};

// The conversation as Claude Code's transcript lines: the main thread's user and assistant
// messages in order, each linked to the one before. Subagent messages, tool progress and
// control traffic aren't part of the conversation a resumed session reads.
function transcript(events, { sessionId, cwd, title }) {
  const lines = [];
  let parent = null;
  const used = new Set();
  for (const e of events) {
    const p = e.payload || {};
    if ((e.event_type !== 'user' && e.event_type !== 'assistant') || p.parent_tool_use_id || !p.message) continue;
    let uuid = typeof p.uuid === 'string' && !used.has(p.uuid) ? p.uuid : e.event_id;
    if (used.has(uuid)) uuid = crypto.randomUUID();
    used.add(uuid);
    const line = {
      parentUuid: parent,
      isSidechain: false,
      userType: 'external',
      cwd,
      sessionId,
      version: 'claude-nonstop-import',
      type: e.event_type,
      message: p.message,
      uuid,
      timestamp: p.timestamp || e.created_at,
    };
    if (p.tool_use_result !== undefined) line.toolUseResult = p.tool_use_result;
    lines.push(line);
    parent = uuid;
  }
  if (title) lines.push({ type: 'custom-title', customTitle: title, sessionId });
  return lines;
}

// Files the session wrote whole (the Write tool), last version of each, by original path.
function writtenFiles(events) {
  const files = new Map();
  for (const e of events) {
    const p = e.payload || {};
    if (e.event_type !== 'assistant' || !p.message || !Array.isArray(p.message.content)) continue;
    for (const block of p.message.content) {
      if (block && block.type === 'tool_use' && block.name === 'Write' && block.input && typeof block.input.file_path === 'string' && typeof block.input.content === 'string') {
        files.set(block.input.file_path, block.input.content);
      }
    }
  }
  return files;
}

// An original absolute path (POSIX or Windows) as a safe relative path under the import folder.
function recoveredPath(original) {
  const parts = String(original).replace(/^[A-Za-z]:/, (d) => d[0]).split(/[\\/]+/).filter((s) => s && s !== '.' && s !== '..');
  return path.join(...parts.map((s) => s.replace(/[<>:"|?*\x00-\x1f]/g, '_')));
}

// Whether a session from this computer is already in Claude Code's own transcripts.
function alreadyLocal(cwd, events) {
  const first = events.find((e) => (e.event_type === 'user' || e.event_type === 'assistant') && e.payload && typeof e.payload.uuid === 'string');
  if (!first || !cwd) return false;
  const dir = path.join(projectsDir(), projectFolderName(cwd));
  if (!fs.existsSync(dir)) return false;
  const r = spawnSync('grep', ['-rlF', '--include=*.jsonl', first.payload.uuid, dir], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) {
    const imported = Object.values(readJson(STATE(), {})).map((s) => s.file);
    return r.stdout.trim().split('\n').some((f) => !imported.includes(f));
  }
  return false;
}

function cloneRepo(source, dir) {
  if (fs.existsSync(path.join(dir, '.git'))) {
    const r = spawnSync('git', ['-C', dir, 'fetch', '--all', '--quiet'], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 600000 });
    return r.status === 0 ? { ok: true } : { ok: false, why: (r.stderr || '').trim().split('\n').pop() };
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const args = ['clone', '--quiet', ...(source.revision ? ['--branch', source.revision] : []), source.url, dir];
  const r = spawnSync('git', args, { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 600000 });
  return r.status === 0 ? { ok: true } : { ok: false, why: (r.stderr || '').trim().split('\n').pop() || `git exited with ${r.status}` };
}

// ---------------------------------------------------------------- public

// Where each of an account's cloud sessions stands on this computer.
async function survey(account) {
  const cloud = await connect(account);
  const sessions = await listSessions(cloud);
  const state = readJson(STATE(), {});
  return sessions.map((s) => ({
    id: s.id,
    title: s.title || s.id,
    updatedAt: s.updated_at,
    status: s.status,
    origin: s.config && s.config.origin,
    repo: ((s.config && s.config.sources) || []).find((x) => x && x.type === 'git_repository') || null,
    imported: state[s.id] ? { at: state[s.id].at, file: state[s.id].file, upToDate: state[s.id].updatedAt === s.updated_at } : null,
  }));
}

// Imports one account's sessions (all, or those with `ids`). Reports per session.
async function importAccount(account, { ids = null, onProgress = () => {} } = {}) {
  const cloud = await connect(account);
  const sessions = (await listSessions(cloud)).filter((s) => !ids || ids.includes(s.id));
  const results = [];
  for (const [i, s] of sessions.entries()) {
    onProgress({ index: i, total: sessions.length, title: s.title });
    try {
      results.push(await importOne(cloud, account, s));
    } catch (err) {
      results.push({ id: s.id, title: s.title, outcome: 'failed', why: err.message });
    }
  }
  log(`imports: ${account.label}: ${results.filter((r) => r.outcome === 'imported' || r.outcome === 'updated').length} of ${results.length} cloud sessions brought here`);
  return results;
}

async function importOne(cloud, account, s) {
  const state = readJson(STATE(), {});
  const before = state[s.id];
  if (before && before.updatedAt === s.updated_at && fs.existsSync(before.file)) return { id: s.id, title: s.title, outcome: 'up to date', file: before.file, folder: before.folder };
  const events = await sessionEvents(cloud, s.id);
  const original = originalCwd(events);
  if (!before && alreadyLocal(original, events)) return { id: s.id, title: s.title, outcome: 'already here', folder: original };
  const conversation = events.filter((e) => (e.event_type === 'user' || e.event_type === 'assistant') && !(e.payload || {}).parent_tool_use_id);
  if (!conversation.length) return { id: s.id, title: s.title, outcome: 'empty' };

  const title = s.title || s.id;
  const repo = ((s.config && s.config.sources) || []).find((x) => x && x.type === 'git_repository' && x.url);
  const local = original && fs.existsSync(original) && fs.statSync(original).isDirectory();
  const folder = local ? original : path.join(IMPORT_ROOT(), slug(account.label), `${slug(title)}-${s.id.slice(-6).toLowerCase()}`);
  fs.mkdirSync(folder, { recursive: true });

  const notes = [];
  if (!local) {
    if (repo) {
      const r = cloneRepo(repo, path.join(folder, 'repo'));
      notes.push(r.ok ? `Repository ${repo.url} cloned into repo/ at ${repo.revision || 'its default branch'}.` : `Repository ${repo.url} couldn't be cloned (${r.why}); clone it into repo/ yourself.`);
    }
    const files = writtenFiles(events);
    for (const [orig, content] of files) {
      const dest = path.join(folder, 'recovered-files', recoveredPath(orig));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content);
    }
    if (files.size) notes.push(`${files.size} file(s) the session wrote whole are rebuilt in recovered-files/, at their last written version. Edits made with other tools aren't applied.`);
    fs.writeFileSync(path.join(folder, 'SESSION.md'), [
      `# ${title}`,
      '',
      `Imported by claude-nonstop from ${account.label}'s cloud session ${s.id}.`,
      `Originally run in: ${original || 'unknown folder'}`,
      `Started ${s.created_at}, last active ${s.last_event_at || s.updated_at}.`,
      '',
      ...notes.map((n) => `- ${n}`),
      '',
      'Resume the conversation here with `claude --resume`.',
      '',
    ].join('\n'));
  }

  const sessionId = before ? before.sessionId : crypto.randomUUID();
  const dir = path.join(projectsDir(), projectFolderName(folder));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const lines = transcript(events, { sessionId, cwd: folder, title: `${title} (from ${account.label})` });
  fs.writeFileSync(`${file}.tmp`, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.renameSync(`${file}.tmp`, file);

  const next = readJson(STATE(), {});
  next[s.id] = { account: account.id, sessionId, file, folder, updatedAt: s.updated_at, at: new Date().toISOString() };
  writeJson(STATE(), next);
  return { id: s.id, title, outcome: before ? 'updated' : 'imported', file, folder, sessionId, messages: lines.length - 1, notes };
}

// ---------------------------------------------------------------- Codex cloud tasks

// A ChatGPT account's Codex cloud tasks (chatgpt.com/codex), read through Codex's own
// `codex cloud` with the account's sign-in in a private, throwaway CODEX_HOME. Each task is
// saved as TASK.md and its whole diff (changes.diff); when the task names a git repository,
// the repository is cloned and the diff applied there. Codex's local sessions already live
// in ~/.codex, shared by every account. OpenAI sign-ins rotate their refresh token, so one
// Codex renews here is written back to the vault.

const findCodex = () => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['codex'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim().split('\n')[0] : null;
};

async function codexHomeFor(account) {
  const openaiAuth = require('./openai-auth');
  const creds = await openaiAuth.current(account.id);
  if (!creds) throw new Error(`${account.label}: not signed in`);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nonstop-codex-'));
  fs.chmodSync(home, 0o700);
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: creds.idToken, access_token: creds.accessToken, refresh_token: creds.refreshToken, account_id: creds.accountId }, last_refresh: new Date().toISOString() }), { mode: 0o600 });
  const done = () => {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')).tokens;
      if (t && t.refresh_token && t.refresh_token !== creds.refreshToken) {
        openaiAuth.store(account.id, openaiAuth.credentials({ access_token: t.access_token, refresh_token: t.refresh_token, id_token: t.id_token, account_id: t.account_id }));
      }
    } catch {}
    fs.rmSync(home, { recursive: true, force: true });
  };
  return { home, done };
}

function codexCloud(bin, home, args) {
  const r = spawnSync(bin, ['cloud', ...args], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: home }, input: '', timeout: 120000, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `codex exited with ${r.status}`).trim().split('\n').pop());
  return r.stdout;
}

// A field of a task, wherever this version of Codex put it.
const pick = (o, names) => {
  for (const n of names) {
    const v = n.split('.').reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};
const taskRepo = (t) => {
  const v = pick(t, ['repo_url', 'repository_url', 'repo', 'repository', 'environment.repo_url', 'environment.repository', 'environment_label', 'environment.label']);
  if (typeof v !== 'string') return null;
  if (/^(https?:\/\/|git@|file:)/.test(v)) return v;
  return /^[\w.-]+\/[\w.-]+$/.test(v) ? `https://github.com/${v}` : null;
};

async function listCodexTasks(bin, home) {
  const tasks = [];
  let cursor = null;
  for (let page = 0; page < 500; page++) {
    const j = JSON.parse(codexCloud(bin, home, ['list', '--json', '--limit', '20', ...(cursor ? ['--cursor', cursor] : [])]));
    tasks.push(...(j.tasks || []));
    if (!j.cursor || j.cursor === cursor || !(j.tasks || []).length) break;
    cursor = j.cursor;
  }
  return tasks;
}

async function importCodexAccount(account, { ids = null, onProgress = () => {} } = {}) {
  const bin = findCodex();
  if (!bin) throw new Error(`${account.label}: Codex isn't installed, and its cloud tasks are read through it (install Codex, then try again)`);
  const { home, done } = await codexHomeFor(account);
  const results = [];
  try {
    const tasks = (await listCodexTasks(bin, home)).filter((t) => !ids || ids.includes(String(pick(t, ['id', 'task_id']))));
    for (const [i, t] of tasks.entries()) {
      const id = String(pick(t, ['id', 'task_id']));
      const title = String(pick(t, ['title', 'name', 'prompt']) || id).split('\n')[0].slice(0, 120);
      onProgress({ index: i, total: tasks.length, title });
      try {
        const updated = String(pick(t, ['updated_at', 'updatedAt', 'created_at']) || '');
        const state = readJson(STATE(), {});
        const before = state[`codex:${id}`];
        if (before && before.updatedAt === updated && fs.existsSync(before.folder)) {
          results.push({ id, title, outcome: 'up to date', folder: before.folder });
          continue;
        }
        const folder = before ? before.folder : path.join(IMPORT_ROOT(), slug(account.label), `codex-${slug(title)}-${id.slice(-6).toLowerCase()}`);
        fs.mkdirSync(folder, { recursive: true });
        let diff = '';
        try {
          diff = codexCloud(bin, home, ['diff', id]);
        } catch (err) {
          diff = '';
        }
        if (diff.trim()) fs.writeFileSync(path.join(folder, 'changes.diff'), diff);
        const notes = [];
        const repo = taskRepo(t);
        if (repo && diff.trim()) {
          const r = cloneRepo({ url: repo }, path.join(folder, 'repo'));
          if (r.ok) {
            const applied = spawnSync('git', ['-C', path.join(folder, 'repo'), 'apply', '--3way', path.join(folder, 'changes.diff')], { encoding: 'utf8' });
            notes.push(applied.status === 0 ? `The task's changes are applied to a clone of ${repo} in repo/ (not committed).` : `Cloned ${repo} into repo/, but its changes didn't apply cleanly (${(applied.stderr || '').trim().split('\n').pop()}); they're in changes.diff.`);
          } else notes.push(`${repo} couldn't be cloned (${r.why}); the changes are in changes.diff.`);
        } else if (diff.trim()) notes.push('The changes are in changes.diff; apply them in your copy of the repository with `git apply changes.diff`.');
        fs.writeFileSync(path.join(folder, 'TASK.md'), [
          `# ${title}`,
          '',
          `Imported by claude-nonstop from ${account.label}'s Codex cloud task ${id}.`,
          `Status: ${pick(t, ['status', 'state']) || 'unknown'}${repo ? `, repository ${repo}` : ''}.`,
          pick(t, ['url', 'task_url']) ? `Open it online: ${pick(t, ['url', 'task_url'])}` : '',
          '',
          ...notes.map((n) => `- ${n}`),
          '',
          '## Task as Codex reported it',
          '',
          '```json',
          JSON.stringify(t, null, 2),
          '```',
          '',
        ].join('\n'));
        const next = readJson(STATE(), {});
        next[`codex:${id}`] = { account: account.id, folder, updatedAt: updated, at: new Date().toISOString() };
        writeJson(STATE(), next);
        results.push({ id, title, outcome: before ? 'updated' : 'imported', folder, notes });
      } catch (err) {
        results.push({ id, title, outcome: 'failed', why: err.message });
      }
    }
  } finally {
    done();
  }
  log(`imports: ${account.label}: ${results.filter((r) => r.outcome === 'imported' || r.outcome === 'updated').length} of ${results.length} Codex cloud tasks brought here`);
  return results;
}

// Every connected account whose cloud work can be brought here: Claude accounts' sessions,
// ChatGPT accounts' Codex tasks.
const importable = (cfg = config.load()) => cfg.accounts.slice();

// Imports any account: a Claude account's sessions or a ChatGPT account's Codex tasks.
const importAny = (account, options) => (accounts.isChatgpt(account) ? importCodexAccount(account, options) : importAccount(account, options));

module.exports = { survey, importAccount, importCodexAccount, importAny, importable, taskRepo, transcript, writtenFiles, recoveredPath, projectFolderName, originalCwd, STATE, IMPORT_ROOT };
