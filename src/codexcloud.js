'use strict';

// A ChatGPT account's Codex Cloud threads: the Codex work at chatgpt.com/local/<id> and in the
// Codex app's cloud workspaces. They live on Codex's hosted app-server
// (wss://codex-cloud-backend.chatgpt.com), which speaks the same app-server protocol as a local
// `codex app-server`, signed in with the account's ChatGPT token. Each thread's conversation
// (thread/turns/list) becomes a Claude Code transcript, so `claude --resume`, the Claude desktop
// app's import and Codex's own importer all take it; its cloud workspace's files (fs/readDirectory,
// fs/readFile in the thread's environment) are copied into the thread's project folder.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WS_URL = () => process.env.CLAUDE_NONSTOP_CODEX_CLOUD_WS || 'wss://codex-cloud-backend.chatgpt.com/';

// Workspace folders that hold credentials or tool state, not the project: never copied.
const SKIP_TOP = new Set(['.aws', '.codex', '.agents', '.git', '.config', '.ssh', '.cache', '.npm']);
const SKIP_ANY = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.git', '.next', 'dist-cache']);
const LIMITS = { files: 5000, bytes: 200 * 1024 * 1024, fileBytes: 25 * 1024 * 1024 };

// One connection to the hosted app-server: call(method, params) -> result.
function connect(accessToken, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== 'function') return reject(new Error('this Node has no WebSocket (Node 22 or newer is needed)'));
    const ws = new WebSocket(WS_URL(), ['codex-app-server', 'codex-client.browser', `openai-bearer.${accessToken}`]);
    let next = 0;
    const pending = new Map();
    const call = (method, params) => new Promise((res, rej) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(new Error(`Codex Cloud didn't answer ${method}`));
      }, timeoutMs);
      pending.set(id, { res, rej, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const close = () => {
      try {
        ws.close();
      } catch {}
    };
    ws.onmessage = (m) => {
      let j;
      try {
        j = JSON.parse(m.data);
      } catch {
        return;
      }
      const p = j.id !== undefined && pending.get(j.id);
      if (!p) return;
      pending.delete(j.id);
      clearTimeout(p.timer);
      if (j.error) p.rej(new Error(j.error.message || JSON.stringify(j.error)));
      else p.res(j.result);
    };
    ws.onerror = (e) => reject(new Error(`couldn't reach Codex Cloud${e && e.message ? ` (${e.message})` : ''}`));
    ws.onclose = () => {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.rej(new Error('Codex Cloud closed the connection'));
      }
      pending.clear();
    };
    ws.onopen = async () => {
      try {
        await call('initialize', { clientInfo: { name: 'claude-nonstop', version: require('../package.json').version } });
        ws.send(JSON.stringify({ method: 'initialized' }));
        resolve({ call, close });
      } catch (err) {
        close();
        reject(err);
      }
    };
  });
}

async function listThreads(rpc) {
  const all = [];
  let cursor = null;
  for (let page = 0; page < 200; page++) {
    const r = await rpc.call('thread/list', { limit: 50, ...(cursor ? { cursor } : {}) });
    all.push(...(r.data || []));
    if (!r.nextCursor || r.nextCursor === cursor) break;
    cursor = r.nextCursor;
  }
  return all;
}

async function threadTurns(rpc, threadId) {
  const all = [];
  let cursor = null;
  for (let page = 0; page < 500; page++) {
    const r = await rpc.call('thread/turns/list', { threadId, itemsView: 'full', sortDirection: 'asc', limit: 50, ...(cursor ? { cursor } : {}) });
    all.push(...(r.data || []));
    if (!r.nextCursor || r.nextCursor === cursor) break;
    cursor = r.nextCursor;
  }
  return all;
}

// Copies a cloud workspace folder into dest. Returns { files, bytes, skipped }.
async function copyTree(rpc, environmentId, src, dest, budget = { files: 0, bytes: 0, skipped: [] }, top = true) {
  let listing;
  try {
    listing = await rpc.call('fs/readDirectory', { path: src, environmentId });
  } catch (err) {
    budget.skipped.push(`${src} (${err.message})`);
    return budget;
  }
  for (const e of listing.entries || []) {
    const name = e.fileName;
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) continue;
    if ((top && SKIP_TOP.has(name)) || (e.isDirectory && SKIP_ANY.has(name))) continue;
    const from = `${src.replace(/\/+$/, '')}/${name}`;
    const to = path.join(dest, name);
    if (e.isDirectory) {
      await copyTree(rpc, environmentId, from, to, budget, false);
      continue;
    }
    if (!e.isFile) continue;
    if (budget.files >= LIMITS.files || budget.bytes >= LIMITS.bytes) {
      budget.skipped.push(`${from} (import size limit reached)`);
      continue;
    }
    try {
      const r = await rpc.call('fs/readFile', { path: from, environmentId });
      const data = Buffer.from(r.dataBase64 || '', 'base64');
      if (data.length > LIMITS.fileBytes) {
        budget.skipped.push(`${from} (over ${LIMITS.fileBytes / 1024 / 1024} MB)`);
        continue;
      }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, data);
      budget.files++;
      budget.bytes += data.length;
    } catch (err) {
      budget.skipped.push(`${from} (${err.message})`);
    }
  }
  return budget;
}

const clip = (t, n) => (t.length > n ? `${t.slice(0, n)}\n… (${t.length - n} more characters)` : t);
const toolId = (seed) => `toolu_${crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 24)}`;
const resultText = (r) => {
  if (!r) return '';
  if (typeof r === 'string') return r;
  if (Array.isArray(r.content)) return r.content.map((c) => (c && typeof c.text === 'string' ? c.text : JSON.stringify(c))).join('\n');
  return JSON.stringify(r);
};

// The thread's turns as Claude Code transcript lines: what you asked, what Codex said, and each
// command or app action it took with its output, in order. Reasoning isn't carried over.
function transcript(turns, { sessionId, cwd, title, model = 'codex-cloud' }) {
  const lines = [];
  let parent = null;
  let n = 0;
  const push = (type, message, at, extra = {}) => {
    const uuid = crypto.randomUUID();
    lines.push({ parentUuid: parent, isSidechain: false, userType: 'external', cwd, sessionId, version: 'claude-nonstop-import', type, message, uuid, timestamp: new Date(at || Date.now()).toISOString(), ...extra });
    parent = uuid;
  };
  const say = (content, at) => push('assistant', { id: `msg_codexcloud_${++n}`, type: 'message', role: 'assistant', model, content, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }, at);
  const tool = (id, name, input, output, isError, at, done) => {
    say([{ type: 'tool_use', id, name, input }], at);
    push('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: clip(String(output || ''), 20000), is_error: !!isError }] }, done || at);
  };
  for (const turn of turns) {
    for (const it of turn.items || []) {
      const at = it.startedAtMs;
      if (it.type === 'userMessage') {
        const text = (it.content || []).map((c) => (c && c.type === 'text' ? c.text : c && c.type === 'image' ? '[image]' : '')).join('\n').trim();
        if (text) push('user', { role: 'user', content: text }, at);
      } else if (it.type === 'agentMessage') {
        if (it.text && it.text.trim()) say([{ type: 'text', text: it.text }], at);
      } else if (it.type === 'commandExecution') {
        const cmd = (it.commandActions && it.commandActions[0] && it.commandActions[0].command) || it.command || '';
        tool(toolId(it.id), 'Bash', { command: cmd, description: `Ran in Codex Cloud (${it.cwd || 'workspace'})` },
          `${it.aggregatedOutput || ''}${it.exitCode !== undefined && it.exitCode !== null ? `\n(exit ${it.exitCode})` : ''}`, it.exitCode && it.exitCode !== 0, at, it.completedAtMs);
      } else if (it.type === 'mcpToolCall') {
        tool(toolId(it.id), `mcp__${it.server || 'codex'}__${String(it.tool || 'tool').replace(/[^A-Za-z0-9_-]/g, '_')}`, it.arguments || {},
          it.error ? resultText(it.error) : resultText(it.result), it.status === 'failed' || !!it.error, at, it.completedAtMs);
      } else if (it.type === 'fileChange') {
        const changes = (it.changes || []).map((c) => `${c.kind && c.kind.type ? c.kind.type : c.kind || 'change'} ${c.path}\n${c.diff || ''}`).join('\n');
        tool(toolId(it.id), 'ApplyPatch', { changes: (it.changes || []).map((c) => c.path) }, changes, it.status === 'failed', at, it.completedAtMs);
      } else if (it.type === 'reasoning') {
        // Not carried over.
      } else if (it.type) {
        say([{ type: 'text', text: `[${it.type}] ${clip(JSON.stringify(it), 4000)}` }], at);
      }
    }
  }
  if (title) lines.push({ type: 'custom-title', customTitle: title, sessionId });
  return lines;
}

module.exports = { WS_URL, connect, listThreads, threadTurns, copyTree, transcript, SKIP_TOP };
