const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-lsp-'));
process.env.PI_CODING_AGENT_DIR = TMP;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(TMP, 'sessions');

const { resolveLiveSessionPath } = require('../bin/tau.js');

const CWD = path.join(TMP, 'proj');
const SUB = path.join(CWD, 'sub');
const OUTSIDE = path.join(TMP, 'outside');

before(() => {
  fs.mkdirSync(SUB, { recursive: true });
  fs.mkdirSync(OUTSIDE, { recursive: true });
  fs.writeFileSync(path.join(CWD, 'readme.md'), 'hi');
  fs.writeFileSync(path.join(SUB, 'nested.txt'), 'hi');
  fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'hi');
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const session = { id: 'tau_x', cwd: CWD };

test('resolveLiveSessionPath resolves the session cwd itself', () => {
  assert.equal(resolveLiveSessionPath(session, CWD), fs.realpathSync(CWD));
});

test('resolveLiveSessionPath resolves nested paths inside cwd', () => {
  assert.equal(
    resolveLiveSessionPath(session, path.join(CWD, 'sub')),
    fs.realpathSync(SUB),
  );
  assert.equal(
    resolveLiveSessionPath(session, path.join(CWD, 'readme.md')),
    fs.realpathSync(path.join(CWD, 'readme.md')),
  );
});

test('resolveLiveSessionPath defaults to session.cwd when no path given', () => {
  assert.equal(resolveLiveSessionPath(session), fs.realpathSync(CWD));
});

test('resolveLiveSessionPath rejects paths outside the session cwd with 403', () => {
  assert.throws(
    () => resolveLiveSessionPath(session, OUTSIDE),
    (err) => err.status === 403 && /outside the active session directory/.test(err.message),
  );
  // traversal escape
  assert.throws(
    () => resolveLiveSessionPath(session, path.join(CWD, '..', 'outside')),
    (err) => err.status === 403,
  );
});

test('resolveLiveSessionPath rejects with 404 when no session is provided', () => {
  assert.throws(
    () => resolveLiveSessionPath(null, CWD),
    (err) => err.status === 404 && /Live session not found/.test(err.message),
  );
});
