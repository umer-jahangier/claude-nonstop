'use strict';

// Brings an account's Claude Code cloud sessions to this computer, so adding or switching
// accounts never strands a project. Claude.ai keeps every Claude Code session an account has
// run through Remote Control, the web or the desktop app, including ones started on other
// computers, with its whole conversation. Claude Code reads that list itself (it's how
// `claude --teleport` and Remote Control work); claude-nonstop reads it the same way, with
// the account's own sign-in, and writes each session as an ordinary Claude Code transcript
// under ~/.claude/projects, where `claude --resume` lists it.
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
// Claude Code's own state file, where a folder's trust is kept (the Claude desktop app reads it too).
const stateFile = () => process.env.CLAUDE_NONSTOP_TRANSCRIPTS_HOME ? path.join(process.env.CLAUDE_NONSTOP_TRANSCRIPTS_HOME, '.claude.json')
  : process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');

// Claude Code files a session under its folder's path with every other character a dash.
const projectFolderName = (cwd) => String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
const slug = (s) => String(s || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'session';

// ---------------------------------------------------------------- the account's cloud

async function connect(account) {
  const cfg = config.load();
  const { token, why } = await require('./gateway').claudeToken(account, cfg, { evenIfLimited: true });
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
      if (r.status === 429) throw new Error(`${account.label}: Anthropic is turning away reads of this account's cloud sessions for now (HTTP 429). Nothing was lost; try again in a few minutes`);
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
  // The title goes first as well as last: the Claude desktop app's importer reads it from the
  // start of the file, `claude --resume` from the end.
  if (title) {
    lines.unshift({ type: 'custom-title', customTitle: title, sessionId });
    lines.push({ type: 'custom-title', customTitle: title, sessionId });
  }
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
  // A project folder can already hold imported notes; clone beside it and move the clone in.
  const occupied = fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  const target = occupied ? `${dir}.clone-${process.pid}` : dir;
  const args = ['clone', '--quiet', ...(source.revision ? ['--branch', source.revision] : []), source.url, target];
  const r = spawnSync('git', args, { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 600000 });
  if (r.status !== 0) {
    if (occupied) fs.rmSync(target, { recursive: true, force: true });
    return { ok: false, why: (r.stderr || '').trim().split('\n').pop() || `git exited with ${r.status}` };
  }
  if (occupied) {
    for (const name of fs.readdirSync(target)) if (!fs.existsSync(path.join(dir, name))) fs.renameSync(path.join(target, name), path.join(dir, name));
    fs.rmSync(target, { recursive: true, force: true });
  }
  return { ok: true };
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
  // Sessions that name their repository first, so the ones that don't can join its project.
  const hasRepo = (s) => (((s.config && s.config.sources) || []).some((x) => x && x.type === 'git_repository') ? 0 : 1);
  const sessions = (await listSessions(cloud)).filter((s) => !ids || ids.includes(s.id)).sort((a, b) => hasRepo(a) - hasRepo(b));
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
  const sharedRepo = ((s.config && s.config.sources) || []).find((x) => x && x.type === 'git_repository' && x.url);
  // Up to date only if it's also where it belongs now: an import from before projects were
  // merged (no recorded work folder), or one whose project has since been found, comes again.
  if (before && before.updatedAt === s.updated_at && fs.existsSync(before.file) && 'root' in before) {
    const want = before.local ? before.folder : targetFolder({ repo: sharedRepo, root: before.root, account, s, before });
    if (path.resolve(want) === path.resolve(before.folder)) return { id: s.id, title: s.title, outcome: 'up to date', file: before.file, folder: before.folder };
  }
  const events = await sessionEvents(cloud, s.id);
  const original = originalCwd(events);
  if (!before && alreadyLocal(original, events)) return { id: s.id, title: s.title, outcome: 'already here', folder: original };
  const conversation = events.filter((e) => (e.event_type === 'user' || e.event_type === 'assistant') && !(e.payload || {}).parent_tool_use_id);
  if (!conversation.length) return { id: s.id, title: s.title, outcome: 'empty' };

  const title = s.title || s.id;
  const repo = ((s.config && s.config.sources) || []).find((x) => x && x.type === 'git_repository' && x.url);
  const local = !!(original && fs.existsSync(original) && fs.statSync(original).isDirectory());
  // Sessions of the same project, from any account, share one folder (and one clone), so
  // `claude --resume` there lists them all and the handoff note covers them all.
  const root = workRoot(events, original);
  const folder = local ? original : targetFolder({ repo, root, account, s, before });
  const grouped = !local && !!(repo || root);
  fs.mkdirSync(folder, { recursive: true });

  const notes = [];
  if (!local) {
    const extras = grouped ? path.join(folder, '.claude-nonstop', 'sessions', `${slug(title)}-${slug(s.id.slice(-6))}`) : folder;
    if (repo) {
      const r = cloneRepo(repo, folder);
      notes.push(r.ok ? `Repository ${repo.url} is cloned here${repo.revision ? `; this session worked on branch ${repo.revision}` : ''}.` : `Repository ${repo.url} couldn't be cloned (${r.why}); clone it here yourself.`);
    }
    const files = writtenFiles(events);
    for (const [orig, content] of files) {
      const dest = path.join(extras, 'recovered-files', recoveredPath(orig));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content);
    }
    if (files.size) notes.push(`${files.size} file(s) the session wrote whole are rebuilt in ${path.relative(folder, path.join(extras, 'recovered-files')) || 'recovered-files'}/, at their last written version.`);
    if (root) notes.push(`It worked in ${root} on the computer it ran on.`);
    if (!grouped) {
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
  }

  // An earlier import into a different folder (the layout before projects were shared)
  // moves here; the old folder and anything in it are left alone.
  if (before && before.file && path.resolve(before.folder) !== path.resolve(folder)) fs.rmSync(before.file, { force: true });
  const sessionId = before ? before.sessionId : crypto.randomUUID();
  const dir = path.join(projectsDir(), projectFolderName(folder));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const lines = transcript(events, { sessionId, cwd: folder, title: `${title} (from ${account.label})` });
  fs.writeFileSync(`${file}.tmp`, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.renameSync(`${file}.tmp`, file);

  if (!local) {
    const note = trustNote(trustFolder(folder));
    if (note) notes.push(note);
  }
  const next = readJson(STATE(), {});
  next[s.id] = {
    account: account.id, sessionId, file, folder, updatedAt: s.updated_at, at: new Date().toISOString(),
    kind: 'claude', local, root, rootKey: root ? rootKey(root) : null, title, accountLabel: account.label, branch: repo && repo.revision, repo: repo && repo.url,
    lastActive: s.last_event_at || s.updated_at, ...recap(events), notes,
  };
  writeJson(STATE(), next);
  if (grouped) writeHandoff(folder);
  if (before && before.folder && path.resolve(before.folder) !== path.resolve(folder)) writeHandoff(before.folder);
  return { id: s.id, title, outcome: before ? 'updated' : 'imported', file, folder, sessionId, messages: lines.length - 1, notes };
}

// ---------------------------------------------------------------- trust

// Whether a folder's own project settings would run something when trusted: hooks, MCP servers
// or an .mcp.json. Those folders are left for you to trust yourself, the first time you open them.
function runsThings(folder) {
  if (fs.existsSync(path.join(folder, '.mcp.json'))) return true;
  for (const f of ['settings.json', 'settings.local.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(folder, '.claude', f), 'utf8'));
      if (j && (j.hooks || j.mcpServers || j.enabledMcpjsonServers || j.apiKeyHelper || j.statusLine)) return true;
    } catch {}
  }
  return false;
}

// Marks a folder the import made as trusted for Claude Code, so `claude` opens it without the
// trust question and the Claude desktop app offers its sessions (Help > Troubleshooting > Import
// Claude Code CLI Sessions, or the Code tab's import banner). Returns 'trusted', 'already',
// 'runs-things' (left to you) or 'unwritable'.
function trustFolder(folder) {
  if (runsThings(folder)) return 'runs-things';
  const file = stateFile();
  let real = file;
  try {
    real = fs.realpathSync(file);
  } catch {}
  let j = {};
  try {
    j = JSON.parse(fs.readFileSync(real, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') return 'unwritable';
  }
  const key = path.resolve(folder);
  const projects = j.projects && typeof j.projects === 'object' ? j.projects : {};
  if (projects[key] && projects[key].hasTrustDialogAccepted === true) return 'already';
  // Read and written back at once, keeping every other field, so a running Claude Code's own
  // writes aren't lost.
  try {
    const fresh = fs.existsSync(real) ? JSON.parse(fs.readFileSync(real, 'utf8')) : {};
    fresh.projects = fresh.projects && typeof fresh.projects === 'object' ? fresh.projects : {};
    fresh.projects[key] = { ...(fresh.projects[key] || {}), hasTrustDialogAccepted: true };
    const tmp = `${real}.claude-nonstop-${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(fresh, null, 2), { mode: fs.existsSync(real) ? fs.statSync(real).mode & 0o777 : 0o600 });
    fs.renameSync(tmp, real);
    return 'trusted';
  } catch {
    return 'unwritable';
  }
}

const trustNote = (r) => r === 'runs-things'
  ? 'Not marked trusted: this project\'s settings run hooks or MCP servers, so open it with `claude` once and answer the trust question yourself.'
  : null;

// Earlier imports wrote their title only at the end; put it first too.
function titleFirst() {
  for (const v of Object.values(readJson(STATE(), {}))) {
    if (!v.file || !fs.existsSync(v.file)) continue;
    try {
      const text = fs.readFileSync(v.file, 'utf8');
      const first = JSON.parse(text.slice(0, text.indexOf('\n')));
      if (first.type === 'custom-title') continue;
      const titles = text.split('\n').filter((l) => l.includes('"custom-title"')).map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      }).filter((l) => l && l.type === 'custom-title');
      const last = titles[titles.length - 1];
      if (!last) continue;
      fs.writeFileSync(`${v.file}.tmp`, `${JSON.stringify({ type: 'custom-title', customTitle: last.customTitle, sessionId: last.sessionId })}\n${text}`);
      fs.renameSync(`${v.file}.tmp`, v.file);
    } catch {}
  }
}

// Trusts every folder earlier imports made (they predate trusting), skipping ones that run things.
function trustImported() {
  const done = {};
  for (const v of Object.values(readJson(STATE(), {}))) {
    if (!v.folder || v.local || !path.resolve(v.folder).startsWith(path.resolve(IMPORT_ROOT())) || done[v.folder] || !fs.existsSync(v.folder)) continue;
    done[v.folder] = trustFolder(v.folder);
  }
  return done;
}

// ---------------------------------------------------------------- shared projects and handoff

// host/owner/name for a repository URL, however it was written.
function repoKey(url) {
  const u = String(url).trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const m = u.match(/^(?:[a-z]+:\/\/)?(?:[^@/]+@)?([^/:]+)[/:](.+)$/i);
  return (m ? `${m[1]}/${m[2]}` : u).toLowerCase();
}

function projectFolder(url) {
  const parts = repoKey(url).split('/').filter(Boolean);
  const name = parts.length >= 3 ? `${parts[parts.length - 2]}-${parts[parts.length - 1]}` : parts[parts.length - 1];
  return path.join(IMPORT_ROOT(), slug(name));
}

const textOf = (message) => {
  const c = message && message.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '';
};
const clip = (t, n) => (t.length > n ? `${t.slice(0, n).trimEnd()}…` : t);

// What the session was last asked and where it ended, for the handoff note.
function recap(events) {
  const asks = [];
  let ended = '';
  for (const e of events) {
    const p = e.payload || {};
    if (p.parent_tool_use_id || !p.message) continue;
    const t = textOf(p.message).trim();
    if (!t) continue;
    if (e.event_type === 'user' && !p.isMeta && !t.startsWith('<') && !/^(Base directory for this skill|Caveat: |This session is being continued)/.test(t)) asks.push(clip(t, 500));
    if (e.event_type === 'assistant') ended = clip(t, 2000);
  }
  return { firstAsk: asks[0] || '', lastAsks: asks.slice(-3), ended };
}

// Where a session belongs: its repository's project; else the project that worked in the
// same folder on the computer it ran on, or a project named after that folder; else its own.
function targetFolder({ repo, root, account, s, before }) {
  if (repo) return projectFolder(repo.url);
  if (root) {
    const key = rootKey(root);
    const base = key.split('/').pop();
    const known = Object.values(readJson(STATE(), {})).filter((v) => v.repo);
    const match = known.find((v) => v.rootKey === key) || known.find((v) => repoKey(v.repo).split('/').pop() === base);
    return match ? projectFolder(match.repo) : path.join(IMPORT_ROOT(), slug(root.split(/[\\/]+/).filter(Boolean).pop()));
  }
  if (before && before.folder && !before.local) return before.folder;
  return path.join(IMPORT_ROOT(), slug(account.label), `${slug(s.title || s.id)}-${slug(s.id.slice(-6))}`);
}

const rootKey = (root) => String(root).replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1').replace(/\/+$/, '').toLowerCase();
const BROAD = new Set(['documents', 'desktop', 'downloads', 'onedrive', 'source', 'repos', 'projects', 'code', 'dev', 'src', 'work']);
const NOT_WORK = /[\\/](appdata|\.claude|\.codex|\.config|tmp|temp|var[\\/]folders|library)[\\/]/i;

// The folder the session worked in on the computer it ran on: its recorded starting folder,
// unless that's just a home folder, else the folder most of its file edits were under.
function workRoot(events, original) {
  const specific = (p) => {
    const parts = String(p).split(/[\\/]+/).filter(Boolean);
    const drive = /^[A-Za-z]:?$/.test(parts[0]) ? 1 : 0;
    // Past a home folder (or, outside one, past the first folder that holds projects).
    let i = /^(users|home)$/i.test(parts[drive] || '') ? drive + 2 : drive + 1;
    while (parts[i] && BROAD.has(parts[i].toLowerCase())) i++;
    return parts.length > i ? { parts, depth: i + 1 } : null;
  };
  if (original && specific(original) && !NOT_WORK.test(`${original}/`)) return String(original).replace(/[\\/]+$/, '');
  const counts = new Map();
  for (const e of events) {
    const p = e.payload || {};
    if (e.event_type !== 'assistant' || !p.message || !Array.isArray(p.message.content)) continue;
    for (const b of p.message.content) {
      const f = b && b.type === 'tool_use' && b.input && (b.input.file_path || b.input.notebook_path);
      if (typeof f !== 'string' || NOT_WORK.test(f)) continue;
      const sp = specific(f);
      if (!sp || sp.parts.length <= sp.depth) continue;
      const sep = f.includes('\\') ? '\\' : '/';
      const lead = /^[A-Za-z]:/.test(f) ? `${sp.parts[0]}${sp.parts[0].endsWith(':') ? '' : ':'}` : '';
      const head = /^[A-Za-z]:/.test(f) ? [lead, ...sp.parts.slice(1, sp.depth)] : sp.parts.slice(0, sp.depth);
      const r = (f.startsWith('/') ? '/' : '') + head.join(sep);
      counts.set(r, (counts.get(r) || 0) + 1);
    }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

// .claude-nonstop/HANDOFF.md: every imported session and Codex task of this project, newest
// first, loaded into new Claude Code sessions here through CLAUDE.local.md. Neither file is
// committed: both go in the clone's .git/info/exclude.
function writeHandoff(folder) {
  const all = Object.entries(readJson(STATE(), {})).map(([id, v]) => ({ id, ...v })).filter((v) => v.folder && path.resolve(v.folder) === path.resolve(folder));
  if (!all.length) {
    fs.rmSync(path.join(folder, '.claude-nonstop', 'HANDOFF.md'), { force: true });
    return;
  }
  all.sort((a, b) => String(b.lastActive || b.updatedAt || '').localeCompare(String(a.lastActive || a.updatedAt || '')));
  const accountsUsed = [...new Set(all.map((v) => v.accountLabel).filter(Boolean))];
  const out = [
    '# Handoff: earlier work on this project',
    '',
    `This project was worked on in ${all.length} cloud session${all.length === 1 ? '' : 's'}${accountsUsed.length ? ` on ${accountsUsed.join(', ')}` : ''} before it was brought to this computer by claude-nonstop. Read this before continuing, so nothing done there is redone or lost. Newest first.`,
    '',
    'Each Claude session\'s full conversation can be reopened with `claude --resume` in this folder.',
    '',
  ];
  for (const v of all) {
    out.push(`## ${v.kind === 'codex' ? 'Codex task' : v.kind === 'codex-cloud' ? 'Codex Cloud thread' : 'Claude session'}: ${v.title || v.id}`, '');
    out.push(`- Account: ${v.accountLabel || 'unknown'}; last active ${v.lastActive || v.updatedAt || 'unknown'}${v.branch ? `; branch \`${v.branch}\`` : ''}`);
    for (const n of v.notes || []) out.push(`- ${n}`);
    if (v.firstAsk) out.push('', '**Started with:**', '', quote(v.firstAsk));
    const later = (v.lastAsks || []).filter((a) => a !== v.firstAsk);
    if (later.length) out.push('', '**Last asked:**', '', ...later.map(quote));
    if (v.ended) out.push('', '**Where it ended:**', '', quote(v.ended));
    out.push('');
  }
  const hand = path.join(folder, '.claude-nonstop', 'HANDOFF.md');
  fs.mkdirSync(path.dirname(hand), { recursive: true });
  fs.writeFileSync(hand, out.join('\n'));
  const local = path.join(folder, 'CLAUDE.local.md');
  const line = '@.claude-nonstop/HANDOFF.md';
  const existing = fs.existsSync(local) ? fs.readFileSync(local, 'utf8') : '';
  if (!existing.includes(line)) fs.writeFileSync(local, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${line}\n`);
  const exclude = path.join(folder, '.git', 'info', 'exclude');
  if (fs.existsSync(path.join(folder, '.git'))) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    const ex = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    const add = ['CLAUDE.local.md', '.claude-nonstop/'].filter((x) => !ex.split('\n').includes(x));
    if (add.length) fs.appendFileSync(exclude, `${ex && !ex.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`);
  }
}
const diffFiles = (diff) => [...new Set([...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]))].slice(0, 50);
const quote = (t) => t.split('\n').map((l) => `> ${l}`).join('\n');

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

// A ChatGPT account's cloud work: its Codex Cloud threads (chatgpt.com/local/..., the Codex
// app's cloud workspaces) and its Codex cloud tasks (chatgpt.com/codex, read through `codex cloud`).
async function importCodexAccount(account, options = {}) {
  const results = [];
  let threadsError = null;
  try {
    results.push(...await importCodexCloudThreads(account, options));
  } catch (err) {
    threadsError = err;
    log(`imports: ${account.label}: Codex Cloud threads: ${err.message}`);
  }
  if (findCodex()) results.push(...await importCodexTasks(account, options));
  else if (threadsError) throw threadsError;
  return results;
}

async function importCodexCloudThreads(account, { onProgress = () => {} } = {}) {
  if (process.env.NODE_TEST_CONTEXT && !process.env.CLAUDE_NONSTOP_CODEX_CLOUD_WS) return [];
  const cc = require('./codexcloud');
  const openaiAuth = require('./openai-auth');
  const creds = await openaiAuth.current(account.id);
  if (!creds) throw new Error(`${account.label}: not signed in`);
  const rpc = await cc.connect(creds.accessToken);
  const results = [];
  try {
    const threads = (await cc.listThreads(rpc)).filter((t) => !t.ephemeral && !t.parentThreadId);
    for (const [i, t] of threads.entries()) {
      const title = String(t.name || t.preview || t.id).split('\n')[0].slice(0, 120);
      onProgress({ index: i, total: threads.length, title });
      try {
        results.push(await importCodexCloudThread(rpc, cc, account, t, title));
      } catch (err) {
        results.push({ id: t.id, title, outcome: 'failed', why: err.message });
      }
    }
  } finally {
    rpc.close();
  }
  log(`imports: ${account.label}: ${results.filter((r) => r.outcome === 'imported' || r.outcome === 'updated').length} of ${results.length} Codex Cloud threads brought here`);
  return results;
}

async function importCodexCloudThread(rpc, cc, account, t, title) {
  const key = `codexcloud:${t.id}`;
  const before = readJson(STATE(), {})[key];
  const updated = String(t.updatedAt || '');
  if (before && before.updatedAt === updated && fs.existsSync(before.file)) return { id: t.id, title, outcome: 'up to date', file: before.file, folder: before.folder };
  const turns = await cc.threadTurns(rpc, t.id);
  if (!turns.some((x) => (x.items || []).some((it) => it.type === 'userMessage' || it.type === 'agentMessage'))) return { id: t.id, title, outcome: 'empty' };
  const repo = t.gitInfo && (t.gitInfo.originUrl || t.gitInfo.repositoryUrl);
  const folder = before ? before.folder : repo ? projectFolder(repo) : path.join(IMPORT_ROOT(), slug(account.label), `codex-${slug(title)}-${slug(t.id.slice(-6))}`);
  fs.mkdirSync(folder, { recursive: true });
  const notes = [];
  if (repo) {
    const r = cloneRepo({ url: repo, revision: t.gitInfo.branch }, folder);
    notes.push(r.ok ? `Repository ${repo} is cloned here.` : `Repository ${repo} couldn't be cloned (${r.why}).`);
  }
  // The thread's cloud workspace, copied in: what Codex made there, as it is now.
  for (const env of t.environments || []) {
    const roots = env.runtimeWorkspaceRoots && env.runtimeWorkspaceRoots.length ? env.runtimeWorkspaceRoots : [env.cwd].filter(Boolean);
    for (const root of roots) {
      const into = repo ? path.join(folder, '.claude-nonstop', 'workspace') : folder;
      const copied = await cc.copyTree(rpc, env.environmentId, root, into);
      notes.push(copied.files ? `${copied.files} file(s) from its cloud workspace ${root} are copied ${repo ? 'into .claude-nonstop/workspace/' : 'here'}.` : `Its cloud workspace ${root} had no files to copy.`);
      if (copied.skipped.length) notes.push(`Not copied: ${copied.skipped.slice(0, 10).join('; ')}${copied.skipped.length > 10 ? `; and ${copied.skipped.length - 10} more` : ''}.`);
    }
  }
  const sessionId = before ? before.sessionId : crypto.randomUUID();
  const dir = path.join(projectsDir(), projectFolderName(folder));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const lines = cc.transcript(turns, { sessionId, cwd: folder, title: `${title} (from ${account.label}, Codex Cloud)`, model: t.model || 'codex-cloud' });
  fs.writeFileSync(`${file}.tmp`, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.renameSync(`${file}.tmp`, file);
  const note = trustNote(trustFolder(folder));
  if (note) notes.push(note);
  const asks = [];
  let ended = '';
  for (const turn of turns) for (const it of turn.items || []) {
    if (it.type === 'userMessage') asks.push(clip((it.content || []).map((c) => c.text || '').join('\n').trim(), 500));
    if (it.type === 'agentMessage' && it.text) ended = clip(it.text, 2000);
  }
  const next = readJson(STATE(), {});
  next[key] = {
    account: account.id, sessionId, file, folder, updatedAt: updated, at: new Date().toISOString(),
    kind: 'codex-cloud', title, accountLabel: account.label, repo: repo || null, lastActive: new Date((t.updatedAt || 0) * 1000).toISOString(),
    firstAsk: asks[0] || '', lastAsks: asks.slice(-3), ended, notes, url: `https://chatgpt.com/local/${t.id}`,
  };
  writeJson(STATE(), next);
  writeHandoff(folder);
  return { id: t.id, title, outcome: before ? 'updated' : 'imported', file, folder, sessionId, notes };
}

async function importCodexTasks(account, { ids = null, onProgress = () => {} } = {}) {
  const bin = findCodex();
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
        const taskRepoUrl = taskRepo(t);
        const moved = before && taskRepoUrl && path.resolve(before.folder) !== path.resolve(projectFolder(taskRepoUrl));
        if (before && !moved && before.updatedAt === updated && fs.existsSync(before.folder)) {
          results.push({ id, title, outcome: 'up to date', folder: before.folder });
          continue;
        }
        const repo = taskRepoUrl;
        const folder = repo ? projectFolder(repo) : before ? before.folder : path.join(IMPORT_ROOT(), slug(account.label), `codex-${slug(title)}-${slug(id.slice(-6))}`);
        const taskDir = repo ? path.join(folder, '.claude-nonstop', 'codex', `${slug(title)}-${slug(id.slice(-6))}`) : folder;
        fs.mkdirSync(taskDir, { recursive: true });
        let diff = '';
        try {
          diff = codexCloud(bin, home, ['diff', id]);
        } catch (err) {
          diff = '';
        }
        const diffFile = path.join(taskDir, 'changes.diff');
        if (diff.trim()) fs.writeFileSync(diffFile, diff);
        const notes = [];
        const rel = path.relative(folder, diffFile);
        if (repo) {
          const r = cloneRepo({ url: repo }, folder);
          if (!r.ok) notes.push(`${repo} couldn't be cloned (${r.why}); the task's changes are in ${rel}.`);
          else if (diff.trim()) {
            // Applied only to a clean working tree, so no other session's changes are mixed in.
            const dirty = spawnSync('git', ['-C', folder, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).stdout.trim();
            const applied = dirty ? null : spawnSync('git', ['-C', folder, 'apply', '--3way', diffFile], { encoding: 'utf8' });
            notes.push(applied && applied.status === 0 ? `This task's changes are applied to the working tree here (not committed); they're also in ${rel}.` : `This task's changes are in ${rel}${applied ? `; they didn't apply cleanly (${(applied.stderr || '').trim().split('\n').pop()})` : ' (not applied: the working tree already had changes)'}. Apply with \`git apply --3way ${rel}\`.`);
          }
        } else if (diff.trim()) notes.push('The changes are in changes.diff; apply them in your copy of the repository with `git apply changes.diff`.');
        fs.writeFileSync(path.join(taskDir, 'TASK.md'), [
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
        const trusted = trustNote(trustFolder(folder));
        if (trusted) notes.push(trusted);
        const prompt = pick(t, ['prompt', 'input', 'task.prompt']);
        const next = readJson(STATE(), {});
        next[`codex:${id}`] = {
          account: account.id, folder, updatedAt: updated, at: new Date().toISOString(),
          kind: 'codex', title, accountLabel: account.label, repo, lastActive: updated,
          firstAsk: typeof prompt === 'string' ? clip(prompt, 600) : title, lastAsks: [], ended: diff.trim() ? `Changed files:\n${diffFiles(diff).join('\n')}` : '', notes,
        };
        writeJson(STATE(), next);
        if (repo) writeHandoff(folder);
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
// ---------------------------------------------------------------- into Codex and the desktop app

// Hands imported Claude Code chats to Codex's own importer (its app-server's
// externalAgentConfig/import, what "Import from Claude Code" uses), so they're Codex threads too:
// in the Codex app and `codex resume`. Codex keeps a ledger, so a chat it has is updated, not doubled.
function toCodex(sessions, { timeoutMs = 300000 } = {}) {
  const bin = findCodex();
  if (!bin || !sessions.length) return Promise.resolve({ ok: !!bin, imported: [], failed: [] });
  if (process.env.NODE_TEST_CONTEXT && !process.env.CLAUDE_NONSTOP_TEST_CODEX) return Promise.resolve({ ok: false, imported: [], failed: [] });
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const p = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        p.kill();
      } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, imported: [], failed: [], why: 'Codex took too long' }), timeoutMs);
    const send = (o) => {
      try {
        p.stdin.write(`${JSON.stringify(o)}\n`);
      } catch {}
    };
    p.on('error', () => finish({ ok: false, imported: [], failed: [], why: "Codex couldn't be started" }));
    p.on('exit', () => finish({ ok: false, imported: [], failed: [], why: 'Codex stopped' }));
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'externalAgentConfig/import', params: {
            source: 'claude-nonstop',
            migrationItems: [{ itemType: 'SESSIONS', description: 'Cloud sessions brought here by claude-nonstop', cwd: null, details: { sessions: sessions.map((x) => ({ cwd: x.cwd, path: x.path, title: x.title })) } }],
          } });
        } else if (m.id === 2 && m.error) finish({ ok: false, imported: [], failed: [], why: m.error.message });
        else if (m.method === 'externalAgentConfig/import/completed') {
          const r = (m.params.itemTypeResults || []).find((x) => x.itemType === 'SESSIONS') || { successes: [], failures: [] };
          finish({ ok: true, imported: r.successes.map((x) => ({ path: x.source, thread: x.target })), failed: r.failures.map((x) => ({ path: x.source, why: x.message })) });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'claude-nonstop', version: require('../package.json').version } } });
  });
}

// Opens the Claude desktop app's Import page, where one click adds the chats to its sidebar.
// The app adds sessions only through its own importer, which asks first.
function openDesktopImport() {
  const url = 'claude://claude.ai/settings/import';
  if (process.platform === 'darwin') {
    if (!fs.existsSync('/Applications/Claude.app') && !fs.existsSync(path.join(os.homedir(), 'Applications', 'Claude.app'))) return false;
    return spawnSync('open', [url]).status === 0;
  }
  if (process.platform === 'win32') return spawnSync('cmd', ['/c', 'start', '', url], { windowsHide: true }).status === 0;
  return false;
}

// After an import: newly brought or updated chats go to Codex too, and are noted there.
async function shareWithCodex(results) {
  if (config.load().importIntoCodex === false) return null;
  const fresh = results.filter((r) => (r.outcome === 'imported' || r.outcome === 'updated') && r.file);
  const state = readJson(STATE(), {});
  // Also any earlier import Codex doesn't have yet.
  const missing = Object.entries(state).filter(([, v]) => (v.kind === 'claude' || v.kind === 'codex-cloud') && v.file && fs.existsSync(v.file) && !v.codexThread)
    .map(([id, v]) => ({ id, file: v.file, folder: v.folder, title: v.title, accountLabel: v.accountLabel }));
  const all = new Map();
  for (const r of fresh) all.set(r.file, { id: r.id, file: r.file, folder: r.folder, title: r.title, accountLabel: (state[r.id] || {}).accountLabel });
  for (const m of missing) if (!all.has(m.file)) all.set(m.file, m);
  if (!all.size) return null;
  const list = [...all.values()];
  const r = await toCodex(list.map((x) => ({ cwd: x.folder, path: x.file, title: x.accountLabel ? `${x.title} (from ${x.accountLabel})` : x.title })));
  if (!r.ok) return r;
  const next = readJson(STATE(), {});
  for (const done of r.imported) {
    const item = list.find((x) => path.resolve(x.file) === path.resolve(done.path));
    if (item && next[item.id]) next[item.id].codexThread = done.thread;
  }
  writeJson(STATE(), next);
  log(`imports: ${r.imported.length} chat(s) handed to Codex${r.failed.length ? `, ${r.failed.length} not` : ''}`);
  return r;
}

const importAny = async (account, options) => {
  titleFirst();
  trustImported();
  const results = await (accounts.isChatgpt(account) ? importCodexAccount(account, options) : importAccount(account, options));
  try {
    const codex = await shareWithCodex(results);
    if (codex && codex.ok) results.codex = { imported: codex.imported.length, failed: codex.failed.length };
  } catch (err) {
    log(`imports: handing chats to Codex failed: ${err.message}`);
  }
  return results;
};

module.exports = { titleFirst, toCodex, shareWithCodex, openDesktopImport, trustFolder, trustImported, workRoot, repoKey, projectFolder, writeHandoff, survey, importAccount, importCodexAccount, importAny, importable, taskRepo, transcript, writtenFiles, recoveredPath, projectFolderName, originalCwd, STATE, IMPORT_ROOT };
