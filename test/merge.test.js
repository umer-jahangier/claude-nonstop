'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { isolate } = require('./helpers');

const { root } = isolate();
process.env.CLAUDE_NONSTOP_TRANSCRIPTS_HOME = path.join(root, 'claude');
const merge = require('../src/merge');

const proj = path.join(root, 'work');
fs.mkdirSync(proj, { recursive: true });
const other = path.join(root, 'elsewhere');
fs.mkdirSync(other, { recursive: true });

function chat(cwd, id, title, turns) {
  const dir = path.join(root, 'claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  let parent = null;
  const lines = [{ type: 'custom-title', customTitle: title, sessionId: id }];
  turns.forEach(([ask, reply, cmd], i) => {
    const u = `${id}-u${i}`;
    lines.push({ type: 'user', uuid: u, parentUuid: parent, sessionId: id, cwd, message: { role: 'user', content: ask }, timestamp: '2026-11-01T00:00:00Z' });
    const a = `${id}-a${i}`;
    const content = [...(cmd ? [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: cmd } }] : []), { type: 'text', text: reply }];
    lines.push({ type: 'assistant', uuid: a, parentUuid: u, sessionId: id, cwd, message: { role: 'assistant', content }, timestamp: '2026-11-01T00:00:01Z', entrypoint: 'claude-desktop-3p' });
    parent = a;
  });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return `${path.basename(dir)}/${id}.jsonl`;
}

const main = chat(proj, '11111111-1111-4111-8111-111111111111', 'Main build', [['Build the API', 'API built.', 'npm test'], ['Add auth', 'Auth added.']]);
const side = chat(other, '22222222-2222-4222-8222-222222222222', 'Codex side work', [['Write the docs', 'Docs written, marker DOCS-7.', 'ls docs']]);
const third = chat(proj, '33333333-3333-4333-8333-333333333333', 'Bug hunt', [['Fix the crash', 'Crash fixed.']]);

test('lists every chat with its title and folder', () => {
  const chats = merge.listChats();
  assert.equal(chats.length, 3);
  const m = chats.find((c) => c.id === main);
  assert.equal(m.title, 'Main build');
  assert.equal(m.folder, proj);
  assert.equal(merge.listChats({ query: 'codex' }).length, 1);
});

test('merging into a chat continues it, with the others condensed after it', () => {
  const r = merge.mergeChats({ target: main, sources: [side, third] });
  assert.equal(r.folder, proj, 'in the target chat\'s folder');
  const lines = fs.readFileSync(r.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].type, 'custom-title');
  assert.equal(lines[0].customTitle, 'Main build + 2 merged');
  const convo = lines.filter((l) => l.type === 'user' || l.type === 'assistant');
  assert.equal(convo[0].message.content, 'Build the API', 'the target conversation comes first, as it was');
  assert.ok(convo.every((l) => l.sessionId === r.sessionId && l.cwd === proj));
  assert.ok(convo.every((l) => !l.entrypoint), 'no app stamp is carried over');
  assert.deepEqual(convo.map((l) => l.parentUuid).slice(1), convo.map((l) => l.uuid).slice(0, -1), 'one linked chain');
  const merged = convo.at(-2).message.content;
  assert.match(merged, /Codex side work[\s\S]*Write the docs[\s\S]*ran `ls docs`[\s\S]*DOCS-7/);
  assert.match(merged, /Bug hunt[\s\S]*Fix the crash/);
  assert.match(merged, /its files are there/, 'a chat from another folder says where its files are');
  assert.equal(convo.at(-1).type, 'assistant', 'ends ready for your next message');
  assert.equal(merge.listChats().find((c) => c.id === r.id).source, 'merged');
});

test('merging into a new chat puts it in the chosen folder; originals are untouched', () => {
  const before = fs.readFileSync(path.join(root, 'claude', 'projects', main), 'utf8');
  const r = merge.mergeChats({ sources: [main, side], folder: other, title: 'Everything' });
  assert.equal(r.folder, other);
  const lines = fs.readFileSync(r.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].customTitle, 'Everything');
  assert.equal(lines.filter((l) => l.type === 'user').length, 1, 'just the merged record, then your next message');
  assert.equal(fs.readFileSync(path.join(root, 'claude', 'projects', main), 'utf8'), before);
  assert.throws(() => merge.mergeChats({ target: main, sources: [main] }), /at least one/);
  assert.throws(() => merge.mergeChats({ sources: ['../../etc/passwd.jsonl'] }), /no chat/);
});

test('a long chat is condensed to its budget, keeping the start and the latest turns', () => {
  const many = Array.from({ length: 300 }, (_, i) => [`step ${i} ${'x'.repeat(400)}`, `done ${i}`]);
  const id = chat(proj, '44444444-4444-4444-8444-444444444444', 'Long one', many);
  const c = merge.condense(path.join(root, 'claude', 'projects', id), 20000);
  assert.ok(c.text.length <= 21000);
  assert.match(c.text, /step 0 /);
  assert.match(c.text, /step 299 /);
  assert.match(c.text, /turn\(s\) in between left out/);
});
