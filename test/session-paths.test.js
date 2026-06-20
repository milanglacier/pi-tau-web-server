const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Point the module at an isolated temp tree BEFORE requiring it, since
// SESSIONS_DIR / PI_AGENT_DIR are computed at load time from env vars.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-session-'));
const SESSIONS = path.join(TMP, 'sessions');
process.env.PI_CODING_AGENT_DIR = TMP;
process.env.PI_CODING_AGENT_SESSION_DIR = SESSIONS;

const {
  resolveSessionFile,
  appendSessionName,
  resolveExportOutputPath,
  resolveExportedSessionPath,
  SESSIONS_DIR,
} = require('../bin/tau.js');

const PROJ_DIR = path.join(SESSIONS_DIR, '--srv--proj'); // encoded /srv/proj
const SESSION_FILE = path.join(PROJ_DIR, 'abc.jsonl');

before(() => {
  fs.mkdirSync(PROJ_DIR, { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ type: 'session', id: 'abc' }) + '\n');
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('resolveSessionFile accepts a valid .jsonl under SESSIONS_DIR', () => {
  assert.equal(resolveSessionFile(SESSION_FILE), path.resolve(SESSION_FILE));
});

test('resolveSessionFile rejects paths outside the session directory', () => {
  assert.throws(() => resolveSessionFile('/etc/hosts'), /Invalid session file/);
  assert.throws(() => resolveSessionFile(path.join(TMP, 'outside.jsonl')), /Invalid session file/);
});

test('resolveSessionFile rejects non-jsonl and missing files', () => {
  const txt = path.join(PROJ_DIR, 'notes.txt');
  fs.writeFileSync(txt, 'hi');
  assert.throws(() => resolveSessionFile(txt), /Invalid session file/);
  assert.throws(() => resolveSessionFile(path.join(PROJ_DIR, 'missing.jsonl')), /Session not found/);
});

test('resolveSessionFile rejects non-string input', () => {
  assert.throws(() => resolveSessionFile(null), /filePath required/);
  assert.throws(() => resolveSessionFile(undefined), /filePath required/);
});

test('appendSessionName appends a session_info line to a valid file', () => {
  appendSessionName(SESSION_FILE, 'My plan');
  const lines = fs.readFileSync(SESSION_FILE, 'utf8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.type, 'session_info');
  assert.equal(last.name, 'My plan');
});

test('appendSessionName rejects invalid paths', () => {
  assert.throws(() => appendSessionName('/etc/hosts', 'x'), /Invalid session file/);
});

test('resolveExportOutputPath accepts an .html file inside the session dir', () => {
  const out = resolveExportOutputPath('export.html', SESSION_FILE);
  assert.equal(out, path.resolve(path.dirname(SESSION_FILE), 'export.html'));
});

test('resolveExportOutputPath rejects non-html and outside-dir targets', () => {
  assert.throws(() => resolveExportOutputPath('export.txt', SESSION_FILE), /\.html/);
  // absolute path outside the session dir
  assert.throws(() => resolveExportOutputPath('/tmp/out.html', SESSION_FILE), /session directory/);
  // parent traversal
  assert.throws(() => resolveExportOutputPath('../out.html', SESSION_FILE), /session directory/);
});

test('resolveExportedSessionPath only allows existing .html under SESSIONS_DIR', () => {
  const html = path.join(PROJ_DIR, 'exp.html');
  fs.writeFileSync(html, '<html></html>');
  assert.equal(resolveExportedSessionPath(html), path.resolve(html));
  assert.throws(() => resolveExportedSessionPath('/tmp/x.html'), /without a live session|session directory/i);
  assert.throws(() => resolveExportedSessionPath(path.join(PROJ_DIR, 'nope.html')), /File not found/);
  // non-html even if exists
  assert.throws(() => resolveExportedSessionPath(SESSION_FILE), /without a live session/i);
});
