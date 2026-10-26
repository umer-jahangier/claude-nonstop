'use strict';

// Codex (OpenAI's coding agent, the terminal `codex` and the Codex desktop app) is pointed
// at this computer's gateway through its own configuration file, ~/.codex/config.toml: a
// model provider named claude-nonstop that speaks the Responses API at the gateway's
// address with the gateway token, and `model_provider` set to it. Codex then needs no
// OpenAI sign-in of its own: every request walks your order like Claude Code's do.
//
// Only the lines claude-nonstop owns are touched: the top-level `model` and `model_provider`
// (their earlier values are kept in codex.json and put back on uninstall) and the
// [model_providers.claude-nonstop] table. Everything else in the file stays as it is.

const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('./paths');
const config = require('./config');
const vault = require('./vault');
const { readJson, writeJson } = require('./files');

const PROVIDER = 'claude-nonstop';
const STATE = path.join(paths.HOME, 'codex.json');

const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const configFile = () => path.join(codexHome(), 'config.toml');

// Whether Codex is on this computer at all: the command, the app, or its own folder.
function installed() {
  if (fs.existsSync(codexHome())) return true;
  if (process.platform === 'darwin' && (fs.existsSync('/Applications/Codex.app') || fs.existsSync(path.join(os.homedir(), 'Applications', 'Codex.app')))) return true;
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  return (process.env.PATH || '').split(path.delimiter).some((dir) => exts.some((ext) => dir && fs.existsSync(path.join(dir, `codex${ext}`))));
}

const TOP_LEVEL_KEY = /^\s*(model|model_provider)\s*=\s*(.*?)\s*$/;
const TABLE_HEADER = /^\s*\[/;
const OUR_TABLE = new RegExp(`^\\s*\\[model_providers\\.(?:"${PROVIDER}"|${PROVIDER})\\]\\s*$`);

// The file in three parts: the top-level lines (before the first table), the tables, and
// our own table taken out of them.
function split(text) {
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((l) => TABLE_HEADER.test(l));
  const head = first < 0 ? lines : lines.slice(0, first);
  const rest = first < 0 ? [] : lines.slice(first);
  const tables = [];
  let skipping = false;
  for (const line of rest) {
    if (TABLE_HEADER.test(line)) skipping = OUR_TABLE.test(line);
    if (!skipping) tables.push(line);
  }
  return { head, tables };
}

const unquote = (v) => {
  const s = String(v || '').trim();
  const m = /^"(.*)"$/.exec(s) || /^'(.*)'$/.exec(s);
  return m ? m[1] : s;
};

function ourTable(cfg, v) {
  return [
    `[model_providers.${PROVIDER}]`,
    `name = "${PROVIDER}"`,
    `base_url = "http://127.0.0.1:${cfg.port}/v1"`,
    'wire_api = "responses"',
    `experimental_bearer_token = "${v.gatewayToken}"`,
    'requires_openai_auth = false',
  ];
}

// Writes the provider into Codex's configuration. Returns what changed.
function apply(cfg = config.load(), v = vault.loadWithTokens()) {
  const file = configFile();
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const { head, tables } = split(before);
  const saved = readJson(STATE, {});
  const previous = {};
  const kept = [];
  for (const line of head) {
    const m = TOP_LEVEL_KEY.exec(line);
    if (m) previous[m[1]] = unquote(m[2]);
    else kept.push(line);
  }
  // What Codex had before, remembered the first time it's pointed here (a file already
  // pointing here keeps the earlier memory; one that isn't is a fresh start).
  if (!saved.managed || previous.model_provider !== PROVIDER) {
    saved.managed = true;
    saved.previous = { model: previous.model ?? null, model_provider: previous.model_provider ?? null };
  }
  const model = (cfg.models && cfg.models.openai) || 'gpt-5.5';
  const top = [`model = "${model}"`, `model_provider = "${PROVIDER}"`];
  const trimmedKept = kept.join('\n').replace(/^\s*\n/, '').replace(/\s*$/, '');
  const trimmedTables = tables.join('\n').replace(/^\s*\n/, '').replace(/\s*$/, '');
  const after = [top.join('\n'), trimmedKept, trimmedTables, ourTable(cfg, v).join('\n')].filter(Boolean).join('\n\n') + '\n';
  if (after === before && readJson(STATE, {}).managed) return { ok: true, changed: false, file };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeJson(STATE, saved);
  fs.writeFileSync(file, after, { mode: 0o600 });
  return { ok: true, changed: true, file };
}

// Takes the provider out again and puts back the model lines Codex had before.
function remove() {
  const file = configFile();
  const saved = readJson(STATE, null);
  if (!fs.existsSync(file)) {
    fs.rmSync(STATE, { force: true });
    return { ok: true, changed: false, file };
  }
  const before = fs.readFileSync(file, 'utf8');
  const { head, tables } = split(before);
  const kept = head.filter((line) => {
    const m = TOP_LEVEL_KEY.exec(line);
    return !(m && (m[1] === 'model_provider' ? unquote(m[2]) === PROVIDER : saved && saved.managed));
  });
  const top = [];
  if (saved && saved.managed && saved.previous) {
    if (saved.previous.model) top.push(`model = "${saved.previous.model}"`);
    if (saved.previous.model_provider) top.push(`model_provider = "${saved.previous.model_provider}"`);
  }
  const trimmedKept = kept.join('\n').replace(/^\s*\n/, '').replace(/\s*$/, '');
  const trimmedTables = tables.join('\n').replace(/^\s*\n/, '').replace(/\s*$/, '');
  const body = [top.join('\n'), trimmedKept, trimmedTables].filter(Boolean).join('\n\n');
  const after = body ? `${body}\n` : '';
  if (after !== before) {
    if (after) fs.writeFileSync(file, after, { mode: 0o600 });
    else fs.rmSync(file, { force: true });
  }
  fs.rmSync(STATE, { force: true });
  return { ok: true, changed: after !== before, file };
}

// Whether Codex's configuration currently points at this gateway.
function status(cfg = config.load()) {
  const file = configFile();
  if (!fs.existsSync(file)) return { wired: false, file };
  const text = fs.readFileSync(file, 'utf8');
  const { head } = split(text);
  const provider = head.map((l) => TOP_LEVEL_KEY.exec(l)).find((m) => m && m[1] === 'model_provider');
  const wired = Boolean(provider && unquote(provider[2]) === PROVIDER && text.includes(`base_url = "http://127.0.0.1:${cfg.port}/v1"`));
  return { wired, file };
}

module.exports = { PROVIDER, codexHome, configFile, installed, apply, remove, status, split };
