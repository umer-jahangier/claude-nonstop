'use strict';

// Merging chats: you pick Claude Code chats on this computer (your own, imported cloud sessions,
// Codex Cloud threads) and what they merge into: one of them to continue, or a new chat in a
// folder. The result is one new chat: the target's conversation as it was, then a condensed record
// of every other picked chat (what was asked, what was done, the commands and files it touched, the
// account it ran on, where its files are). The originals stay as they are. A whole other chat isn't
// pasted in: several long chats would overflow the context window, so each is condensed to a share
// of a fixed budget, and its full history stays resumable on its own.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');

const claudeHome = () => process.env.CLAUDE_NONSTOP_TRANSCRIPTS_HOME || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const projectsDir = () => path.join(claudeHome(), 'projects');
const projectFolderName = (cwd) => String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
const MERGES = () => path.join(paths.HOME, 'merges.json');
const IMPORTS = () => path.join(paths.HOME, 'imports.json');
const BUDGET = 160000; // characters of condensed history in one merged chat, about 40k tokens

const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
const clip = (t, n) => (t.length > n ? `${t.slice(0, n).trimEnd()}…` : t);
const oneLine = (t) => String(t || '').replace(/\s+/g, ' ').trim();

function parse(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

const textOf = (message) => {
  const c = message && message.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '';
};
// Text Claude Code itself put in a user turn, not something you typed.
const injected = (t) => /^(<|Caveat: |Base directory for this skill|This session is being continued|\[Request interrupted)/.test(t);

// Every chat Claude Code keeps on this computer, newest first: id (its path under projects/),
// title, folder, when, size, and where it came from when an import brought it.
function listChats({ query = '' } = {}) {
  const root = projectsDir();
  if (!fs.existsSync(root)) return [];
  const imported = {};
  for (const v of Object.values(readJson(IMPORTS(), {}))) if (v.file) imported[path.resolve(v.file)] = v;
  const merged = {};
  for (const m of readJson(MERGES(), [])) if (m.file) merged[path.resolve(m.file)] = m;
  const chats = [];
  for (const dir of fs.readdirSync(root)) {
    const full = path.join(root, dir);
    let files;
    try {
      files = fs.readdirSync(full).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(full, f);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (stat.size < 200) continue;
      const head = readHead(file);
      if (!head.messages) continue;
      const imp = imported[path.resolve(file)];
      const mg = merged[path.resolve(file)];
      chats.push({
        id: `${dir}/${f}`,
        title: head.title || head.firstAsk || 'Untitled chat',
        folder: head.cwd || '',
        updatedAt: stat.mtime.toISOString(),
        bytes: stat.size,
        source: mg ? 'merged' : imp ? (imp.kind === 'codex-cloud' ? 'Codex Cloud' : `from ${imp.accountLabel || 'cloud'}`) : 'this computer',
      });
    }
  }
  const q = query.toLowerCase();
  return chats.filter((c) => !q || `${c.title} ${c.folder} ${c.source}`.toLowerCase().includes(q)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// Title, folder and first ask from a chat's first 256 KB and its last line; enough for a list.
function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, 262144));
    fs.readSync(fd, buf, 0, buf.length, 0);
    const tail = Buffer.alloc(Math.min(size, 65536));
    fs.readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length));
    const r = { title: null, cwd: null, firstAsk: null, messages: 0 };
    for (const text of [buf.toString('utf8'), tail.toString('utf8')]) {
      for (const line of text.split('\n')) {
        if (!line.startsWith('{')) continue;
        let j;
        try {
          j = JSON.parse(line);
        } catch {
          continue;
        }
        if (j.type === 'custom-title' && j.customTitle) r.title = j.customTitle;
        if (j.type === 'user' || j.type === 'assistant') {
          r.messages++;
          if (!r.cwd && j.cwd) r.cwd = j.cwd;
          if (!r.firstAsk && j.type === 'user' && !j.isMeta) {
            const t = oneLine(textOf(j.message));
            if (t && !injected(t)) r.firstAsk = clip(t, 80);
          }
        }
      }
    }
    return r;
  } finally {
    fs.closeSync(fd);
  }
}

const fileOf = (id) => {
  const file = path.resolve(projectsDir(), id);
  if (!file.startsWith(path.resolve(projectsDir()) + path.sep) || !file.endsWith('.jsonl') || !fs.existsSync(file)) throw new Error(`no chat ${id}`);
  return file;
};

// A chat condensed to about `budget` characters: each turn's ask, what was done (commands, files)
// and the reply, oldest first; when it's too long, the start and the end are kept.
function condense(file, budget) {
  const lines = parse(file).filter((l) => (l.type === 'user' || l.type === 'assistant') && !l.isSidechain);
  const turns = [];
  let cur = null;
  for (const l of lines) {
    const c = l.message && l.message.content;
    if (l.type === 'user') {
      const t = oneLine(textOf(l.message));
      if (t && !l.isMeta && !injected(t)) {
        cur = { at: l.timestamp, ask: clip(t, 1200), did: [], reply: '' };
        turns.push(cur);
      }
      continue;
    }
    if (!cur) {
      cur = { at: l.timestamp, ask: '', did: [], reply: '' };
      turns.push(cur);
    }
    for (const b of Array.isArray(c) ? c : []) {
      if (b.type === 'text' && b.text && b.text.trim()) cur.reply = b.text.trim();
      if (b.type === 'tool_use') {
        const i = b.input || {};
        const what = i.command ? `ran \`${clip(oneLine(i.command), 160)}\`` : i.file_path ? `${b.name === 'Read' ? 'read' : 'changed'} ${i.file_path}` : `used ${b.name}`;
        if (cur.did.length < 12 && !cur.did.includes(what)) cur.did.push(what);
      }
    }
  }
  const render = (t) => [
    t.ask ? `- **Asked:** ${t.ask}` : null,
    t.did.length ? `  - Did: ${t.did.join('; ')}` : null,
    t.reply ? `  - **Replied:** ${clip(oneLine(t.reply), 1500)}` : null,
  ].filter(Boolean).join('\n');
  const parts = turns.map(render);
  let total = parts.reduce((n, p) => n + p.length + 1, 0);
  if (total <= budget) return { text: parts.join('\n'), turns: turns.length, kept: turns.length };
  // Keep the first two turns and as many of the latest as fit.
  const head = parts.slice(0, 2);
  const tail = [];
  total = head.reduce((n, p) => n + p.length + 1, 0) + 80;
  for (let i = parts.length - 1; i >= 2 && total + parts[i].length + 1 <= budget; i--) {
    tail.unshift(parts[i]);
    total += parts[i].length + 1;
  }
  const skipped = parts.length - head.length - tail.length;
  return { text: [...head, `- … ${skipped} turn(s) in between left out; resume the original chat for them.`, ...tail].join('\n'), turns: turns.length, kept: head.length + tail.length };
}

// Merges `sources` (chat ids) into `target` (a chat id, continued as a new chat) or, with no
// target, into a new chat in `folder`. Returns the new chat's { id, file, folder, sessionId, title }.
function mergeChats({ target = null, sources = [], folder = null, title = null }) {
  const sourceIds = [...new Set(sources)].filter((s) => s !== target);
  if (!sourceIds.length) throw new Error('pick at least one chat to merge in');
  const chats = Object.fromEntries(listChats().map((c) => [c.id, c]));
  const targetFile = target ? fileOf(target) : null;
  const targetInfo = target ? chats[target] || { title: 'chat', folder: readHead(targetFile).cwd } : null;
  const cwd = path.resolve(folder || (targetInfo && targetInfo.folder) || (chats[sourceIds[0]] || {}).folder || os.homedir());
  if (!fs.existsSync(cwd)) throw new Error(`the folder ${cwd} doesn't exist`);
  const sessionId = crypto.randomUUID();
  const out = [];
  let parent = null;
  const name = title || (targetInfo ? `${targetInfo.title} + ${sourceIds.length} merged` : `Merged: ${sourceIds.length} chats`);
  out.push({ type: 'custom-title', customTitle: name, sessionId });

  // The target's own conversation, as it was, now in the new chat.
  if (targetFile) {
    const used = new Set();
    for (const l of parse(targetFile)) {
      if ((l.type !== 'user' && l.type !== 'assistant') || l.isSidechain) continue;
      let uuid = l.uuid && !used.has(l.uuid) ? l.uuid : crypto.randomUUID();
      used.add(uuid);
      const copy = { ...l, parentUuid: parent, sessionId, cwd, uuid };
      delete copy.entrypoint;
      copy.version = 'claude-nonstop-merge';
      out.push(copy);
      parent = uuid;
    }
  }

  // Then every other chat, condensed.
  const share = Math.floor(BUDGET / sourceIds.length);
  const blocks = sourceIds.map((id) => {
    const file = fileOf(id);
    const info = chats[id] || { title: id, folder: readHead(file).cwd, source: '' };
    const c = condense(file, share);
    return [
      `## ${info.title}`,
      `- Came from: ${String(info.source || 'this computer').replace(/^from /, '')}; worked in ${info.folder || 'an unknown folder'}${info.folder && path.resolve(info.folder) !== cwd ? ' (its files are there)' : ''}; last active ${info.updatedAt || 'unknown'}.`,
      `- ${c.turns} turn(s)${c.kept < c.turns ? `, ${c.kept} shown` : ''}. Full chat: resume "${info.title}" on its own.`,
      '',
      c.text,
    ].join('\n');
  });
  const now = new Date().toISOString();
  const intro = [
    `Merged by claude-nonstop: the work below happened in ${sourceIds.length} other chat${sourceIds.length === 1 ? '' : 's'}${targetFile ? ', alongside this one' : ''}, possibly on other accounts or in Codex. Treat it as part of this conversation: don't redo what was done, and carry on from where each left off. Each is condensed; ask me to resume the original if you need its full detail.`,
    '',
    ...blocks,
  ].join('\n');
  const u = crypto.randomUUID();
  out.push({ parentUuid: parent, isSidechain: false, userType: 'external', cwd, sessionId, version: 'claude-nonstop-merge', type: 'user', message: { role: 'user', content: intro }, uuid: u, timestamp: now });
  const a = crypto.randomUUID();
  out.push({ parentUuid: u, isSidechain: false, userType: 'external', cwd, sessionId, version: 'claude-nonstop-merge', type: 'assistant', message: { id: `msg_merge_${sessionId.slice(0, 8)}`, type: 'message', role: 'assistant', model: 'claude-nonstop-merge', content: [{ type: 'text', text: `I have the work from ${sourceIds.length === 1 ? 'that chat' : `all ${sourceIds.length} chats`} in context${targetFile ? ' along with this conversation' : ''}. What should we do next?` }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }, uuid: a, timestamp: now });
  out.push({ type: 'custom-title', customTitle: name, sessionId });

  const dir = path.join(projectsDir(), projectFolderName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(`${file}.tmp`, out.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.renameSync(`${file}.tmp`, file);
  const record = { file, folder: cwd, sessionId, title: name, target, sources: sourceIds, at: now };
  const all = readJson(MERGES(), []);
  all.push(record);
  fs.mkdirSync(path.dirname(MERGES()), { recursive: true });
  fs.writeFileSync(MERGES(), JSON.stringify(all, null, 2));
  return { id: `${path.basename(dir)}/${sessionId}.jsonl`, ...record };
}

// After a merge: Codex gets the new chat too, and the folder is trusted when the import made it.
async function shareMerged(m) {
  const cloud = require('./cloudsessions');
  if (path.resolve(m.folder).startsWith(path.resolve(cloud.IMPORT_ROOT()))) cloud.trustFolder(m.folder);
  try {
    const r = await cloud.toCodex([{ cwd: m.folder, path: m.file, title: m.title }]);
    return r && r.ok ? r.imported.length : 0;
  } catch {
    return 0;
  }
}

module.exports = { listChats, mergeChats, shareMerged, condense, readHead };
