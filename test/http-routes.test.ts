const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

// Loopback host so computeUrls() sets a localhost mirrorUrl; isolate settings.
process.env.TAU_HOST = '127.0.0.1';
process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-http-'));
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions');
// Configure a projects dir so /api/projects has something to list.
const PROJECTS_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'projects');
process.env.TAU_PROJECTS_DIR = PROJECTS_DIR;

const { server, computeUrls, liveManager, SESSIONS_DIR, _setSpawnPiForTest } = require('../bin/tau.js');
import type { TestContext } from 'node:test';

let base = '';

const PROJ_DIR = path.join(SESSIONS_DIR, '--tmp--httpproj');
const SESSION_FILE = path.join(PROJ_DIR, 's.jsonl');

function writeSessionFileAt(projectDir: string, fileName: string, lines: Array<Record<string, unknown>>) {
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, fileName);
  fs.writeFileSync(filePath, lines.map((l: Record<string, unknown>) => JSON.stringify(l)).join('\n') + '\n');
  return filePath;
}

function writeSessionFile(lines: Array<Record<string, unknown>>) {
  writeSessionFileAt(PROJ_DIR, 's.jsonl', lines);
}

interface FakeHttpSession {
  id: string;
  cwd: string;
  model: string;
  modelSpec: string;
  thinkingLevel: string;
  isStreaming: boolean;
  sessionFile: string;
  sessionName: string | null;
  contextUsage: { tokens?: number; usage?: { input_tokens: number; output_tokens: number } } | null;
  metadata: () => { id: string; cwd: string; model: string; isStreaming: boolean; sessionFile: string };
  snapshot: () => { session: { id: string }; entries: unknown[]; model: string; isStreaming: boolean; sessionFile: string };
  terminate: () => Promise<void>;
}

function fakeSession(id: string): FakeHttpSession {
  return {
    id,
    cwd: '/tmp/proj',
    model: 'openai/gpt-5.5',
    modelSpec: '',
    thinkingLevel: 'off',
    isStreaming: false,
    sessionFile: `/tmp/${id}.jsonl`,
    sessionName: null,
    contextUsage: null,
    metadata: () => ({ id, cwd: '/tmp/proj', model: 'openai/gpt-5.5', isStreaming: false, sessionFile: `/tmp/${id}.jsonl` }),
    snapshot: () => ({ session: { id }, entries: [], model: 'openai/gpt-5.5', isStreaming: false, sessionFile: `/tmp/${id}.jsonl` }),
    terminate: async () => {},
  };
}

// A realistic fake `pi` child: real streams so start()'s setEncoding/on('data')
// wiring works, and an EventEmitter so on('error')/on('exit') resolve startup.
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12345;
  child.kill = (sig: string) => { child.killedSignal = sig; };
  return child;
}

before((t: TestContext, done: () => void) => {
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    computeUrls(port);
    base = `http://127.0.0.1:${port}`;
    done();
  });
});

after((t: TestContext, done: () => void) => {
  server.close(done);
});

beforeEach(() => {
  liveManager.sessions.clear();
});

async function jsonBody(res: Response) {
  return JSON.parse(await res.text());
}

test('GET /api/health reports standalone mode and live session count', async () => {
  liveManager.sessions.set('tau_1', fakeSession('tau_1'));
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.status, 'ok');
  assert.equal(body.mode, 'standalone');
  assert.equal(body.liveSessionCount, 1);
});

test('GET /api/live-sessions lists managed sessions', async () => {
  liveManager.sessions.set('tau_1', fakeSession('tau_1'));
  const res = await fetch(`${base}/api/live-sessions`);
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0].id, 'tau_1');
});

test('POST /api/live-sessions requires cwd', async () => {
  const res = await fetch(`${base}/api/live-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  const body = await jsonBody(res);
  assert.match(body.error, /cwd required/);
});

test('GET /api/live-sessions/:id/snapshot returns 404 for missing session', async () => {
  const res = await fetch(`${base}/api/live-sessions/tau_missing/snapshot`);
  assert.equal(res.status, 404);
});

test('GET /api/live-sessions/:id/snapshot returns snapshot for a live session', async () => {
  liveManager.sessions.set('tau_1', fakeSession('tau_1'));
  const res = await fetch(`${base}/api/live-sessions/tau_1/snapshot`);
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.session.id, 'tau_1');
  assert.deepEqual(body.entries, []);
});

test('DELETE /api/live-sessions/:id terminates and returns 200', async () => {
  const s = fakeSession('tau_1');
  let terminated = false;
  s.terminate = async () => { terminated = true; };
  liveManager.sessions.set('tau_1', s);
  const res = await fetch(`${base}/api/live-sessions/tau_1`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.success, true);
  assert.equal(terminated, true);
  assert.equal(liveManager.sessions.has('tau_1'), false);
});

test('DELETE /api/live-sessions/:id returns 404 for missing session', async () => {
  const res = await fetch(`${base}/api/live-sessions/tau_missing`, { method: 'DELETE' });
  assert.equal(res.status, 404);
});

test('DELETE /api/live-sessions/:id/snapshot is not a termination route and falls through', async () => {
  const s = fakeSession('tau_1');
  let terminated = false;
  s.terminate = async () => { terminated = true; };
  liveManager.sessions.set('tau_1', s);
  const res = await fetch(`${base}/api/live-sessions/tau_1/snapshot`, { method: 'DELETE' });
  // snapshot subroute has no DELETE handler -> falls through to 404
  assert.equal(res.status, 404);
  assert.equal(terminated, false, 'snapshot DELETE must not terminate the child');
  assert.equal(liveManager.sessions.has('tau_1'), true);
});

test('GET /api/files without sessionId is rejected with 400', async () => {
  const res = await fetch(`${base}/api/files`);
  assert.equal(res.status, 400);
  assert.match((await jsonBody(res)).error, /No live session selected/);
});

test('GET /api/file/preview without sessionId is rejected with 400', async () => {
  const res = await fetch(`${base}/api/file/preview?path=/x.png`);
  assert.equal(res.status, 400);
  assert.match((await jsonBody(res)).error, /No live session selected/);
});

test('malformed static URL returns 400 instead of crashing the server', async () => {
  const res = await fetch(`${base}/%E0%A4%A`);
  assert.equal(res.status, 400);
  // server stays up for subsequent requests
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
});

test('malformed live-session id returns 400 instead of crashing the server', async () => {
  const res = await fetch(`${base}/api/live-sessions/%E0%A4%A`);
  assert.equal(res.status, 400);
  assert.match((await jsonBody(res)).error, /Malformed live session id/);
  // server stays up
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
});

test('cross-origin API preflight is rejected with 403 and no CORS headers', async () => {
  const res = await fetch(`${base}/api/live-sessions`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://evil.example', Host: new URL(base).host, 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(res.status, 403);
  // a rejected origin must not get an Access-Control-Allow-Origin header
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('same-origin API preflight is allowed with 200 and full CORS headers', async () => {
  const host = new URL(base).host;
  const res = await fetch(`${base}/api/live-sessions`, {
    method: 'OPTIONS',
    headers: { Origin: base, Host: host, 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), base);
  assert.equal(res.headers.get('vary'), 'Origin');
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, DELETE, OPTIONS');
  assert.equal(res.headers.get('access-control-allow-headers'), 'Content-Type');
});

test('cross-origin POST is rejected with 403', async () => {
  const res = await fetch(`${base}/api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example', Host: new URL(base).host },
    body: JSON.stringify({ type: 'get_auth' }),
  });
  assert.equal(res.status, 403);
});

test('same-origin POST /api/rpc proxies to handleRpcCommand', async () => {
  const host = new URL(base).host;
  const res = await fetch(`${base}/api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: host },
    body: JSON.stringify({ type: 'get_auth' }),
  });
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.success, true);
  assert.equal(body.data.configured, false);
});

test('GET /api/qr returns HTML once the server URL is known', async () => {
  const res = await fetch(`${base}/api/qr`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html');
  const text = await res.text();
  assert.match(text, /<img/);
});

test('GET /api/sessions returns an empty project list when no sessions exist', async () => {
  const res = await fetch(`${base}/api/sessions`);
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.deepEqual(body.projects, []);
});

test('POST /api/sessions/delete removes the session file from disk', async () => {
  writeSessionFile([{ type: 'session', id: 's' }]);
  assert.equal(fs.existsSync(SESSION_FILE), true);
  const res = await fetch(`${base}/api/sessions/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ filePath: SESSION_FILE }),
  });
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.success, true);
  assert.equal(fs.existsSync(SESSION_FILE), false);
});

test('POST /api/sessions/delete rejects an invalid filePath with 400', async () => {
  const res = await fetch(`${base}/api/sessions/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ filePath: '/etc/hosts' }),
  });
  assert.equal(res.status, 400);
  assert.match((await jsonBody(res)).error, /Invalid session file/);
});

test('POST /api/sessions/delete rejects a missing filePath with 400', async () => {
  const res = await fetch(`${base}/api/sessions/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  assert.match((await jsonBody(res)).error, /filePath required/);
});

test('POST /api/sessions/switch returns success in standalone mode', async () => {
  const res = await fetch(`${base}/api/sessions/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.success, true);
  assert.equal(body.standalone, true);
});

test('GET /api/sessions/:project/:file streams the parsed session entries', async () => {
  writeSessionFile([{ type: 'session', id: 's' }, { type: 'message', message: { role: 'user', content: 'hi' } }]);
  const res = await fetch(`${base}/api/sessions/--tmp--httpproj/s.jsonl`);
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.entries.length, 2);
  assert.equal(body.entries[0].type, 'session');
});

test('GET /api/sessions/:project/:file returns 404 for a missing file', async () => {
  const res = await fetch(`${base}/api/sessions/--tmp--httpproj/nope.jsonl`);
  assert.equal(res.status, 404);
});

test('GET /api/search returns matching session entries', async () => {
  writeSessionFile([
    { type: 'session', id: 's', timestamp: '2026-01-01T00:00:00.000Z' },
    { type: 'message', message: { role: 'user', content: 'please find the unique keyword here' } },
  ]);
  const res = await fetch(`${base}/api/search?q=keyword`);
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].sessionId, 's');
  assert.match(body.results[0].matches[0].snippet, /keyword/);
});

test('GET /api/search returns an empty result list for a too-short query', async () => {
  writeSessionFile([{ type: 'session', id: 's' }]);
  const res = await fetch(`${base}/api/search?q=a`);
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.deepEqual(body.results, []);
});

test('GET /api/sessions preserves hyphenated project cwd from the session header', async () => {
  const projectPath = path.join(PROJECTS_DIR, 'agent-scratch');
  const encodedDir = path.join(SESSIONS_DIR, '--tmp--agent-scratch');
  writeSessionFileAt(encodedDir, 'hyphen.jsonl', [
    { type: 'session', id: 'hyphen', timestamp: '2026-01-01T00:00:00.000Z', cwd: projectPath },
    { type: 'message', message: { role: 'user', content: 'first message' } },
    { type: 'message', message: { role: 'assistant', content: 'reply' } },
    { type: 'message', message: { role: 'user', content: 'second message' } },
  ]);

  const res = await fetch(`${base}/api/sessions`);
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  const project = body.projects.find((p: { path: string }) => p.path === path.resolve(projectPath));
  assert.ok(project);
  assert.equal(path.basename(project.path), 'agent-scratch');
  assert.ok(!project.path.includes(`${path.sep}agent${path.sep}scratch`));
});

test('GET /api/search returns the hyphenated project cwd from the session header', async () => {
  const projectPath = path.join(PROJECTS_DIR, 'agent-scratch');
  const encodedDir = path.join(SESSIONS_DIR, '--tmp--agent-scratch-search');
  writeSessionFileAt(encodedDir, 'hyphen-search.jsonl', [
    { type: 'session', id: 'hyphen-search', timestamp: '2026-01-01T00:00:00.000Z', cwd: projectPath },
    { type: 'message', message: { role: 'user', content: 'please find hyphenneedle here' } },
  ]);

  const res = await fetch(`${base}/api/search?q=hyphenneedle`);
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].project, path.resolve(projectPath));
});

test('GET /api/projects lists project directories under the configured projects dir', async () => {
  fs.mkdirSync(path.join(PROJECTS_DIR, 'myproj'), { recursive: true });
  const res = await fetch(`${base}/api/projects`);
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  const names = body.projects.map((p: { name: string; active: boolean }) => p.name);
  assert.ok(names.includes('myproj'));
  const proj = body.projects.find((p: { name: string; active: boolean }) => p.name === 'myproj');
  assert.equal(proj.active, false);
});

test('GET /api/projects counts sessions for hyphenated project names using header cwd', async () => {
  const projectPath = path.join(PROJECTS_DIR, 'agent-scratch');
  fs.mkdirSync(projectPath, { recursive: true });
  writeSessionFileAt(path.join(SESSIONS_DIR, '--tmp--agent-scratch-projects'), 'hyphen-projects.jsonl', [
    { type: 'session', id: 'hyphen-projects', timestamp: '2026-01-01T00:00:00.000Z', cwd: projectPath },
    { type: 'message', message: { role: 'user', content: 'project count message' } },
  ]);

  const res = await fetch(`${base}/api/projects`);
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  const proj = body.projects.find((p: { name: string; sessionCount: number }) => p.name === 'agent-scratch');
  assert.ok(proj);
  assert.ok(proj.sessionCount >= 1);
});

test('GET /api/files lists the directory for a live session', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-files-'));
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'hi');
  const s = fakeSession('tau_1');
  s.cwd = cwd;
  liveManager.sessions.set('tau_1', s);
  const res = await fetch(`${base}/api/files?sessionId=tau_1`);
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.ok(body.items.some((i: { name: string }) => i.name === 'a.txt'));
});

test('GET /api/file/preview streams a previewable image inside the session cwd', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-prev-'));
  const png = path.join(cwd, 'img.png');
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const s = fakeSession('tau_1');
  s.cwd = cwd;
  liveManager.sessions.set('tau_1', s);
  const res = await fetch(`${base}/api/file/preview?sessionId=tau_1&path=${encodeURIComponent(png)}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
});

test('POST /api/open rejects a missing filePath with 400', async () => {
  const res = await fetch(`${base}/api/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  assert.match((await jsonBody(res)).error, /filePath required/);
});

test('static-file path traversal is rejected with 403', async () => {
  // %2e%2e decodes to '..'; the decoded path resolves outside STATIC_DIR and
  // must be blocked by serveStaticFile's containment guard.
  const res = await fetch(`${base}/%2e%2e%2fsecret`);
  assert.equal(res.status, 403);
  // server stays up for subsequent requests
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
});

test('GET /api/file/preview rejects a non-image with 415', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-prev415-'));
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'hi');
  const s = fakeSession('tau_1');
  s.cwd = cwd;
  liveManager.sessions.set('tau_1', s);
  const res = await fetch(`${base}/api/file/preview?sessionId=tau_1&path=${encodeURIComponent(path.join(cwd, 'notes.txt'))}`);
  assert.equal(res.status, 415);
  assert.match((await jsonBody(res)).error, /Not a previewable image/);
});

test('POST /api/rpc with a malformed JSON body returns 400', async () => {
  const res = await fetch(`${base}/api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  const body = await jsonBody(res);
  assert.ok(body.error);
});

test('POST /api/live-sessions creates a live session and returns 200', async (t: TestContext) => {
  const child = makeFakeChild();
  _setSpawnPiForTest(() => child);
  t.after(() => _setSpawnPiForTest(null));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-post-create-'));
  const res = await fetch(`${base}/api/live-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ cwd, model: 'openai/gpt-5.5' }),
  });
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.session.id.startsWith('tau_'), true);
  assert.equal(body.session.cwd, path.resolve(cwd));
  assert.equal(body.session.modelSpec, 'openai/gpt-5.5');
  // end the fake stdin so start()'s 250ms get_session_stats probe rejects
  // immediately instead of scheduling a long pending timer.
  child.stdin.end();
});

test('POST /api/live-sessions/resume rejects missing filePath with 400', async () => {
  const res = await fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  assert.match((await jsonBody(res)).error, /filePath required/);
});

test('POST /api/live-sessions/resume rejects a filePath outside SESSIONS_DIR with 400', async () => {
  const res = await fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ filePath: '/etc/hosts' }),
  });
  assert.equal(res.status, 400);
  assert.match((await jsonBody(res)).error, /Invalid session file/);
});

test('POST /api/live-sessions/resume creates a live session with matching sessionFile', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-resume-http-'));
  writeSessionFileAt(PROJ_DIR, 'resume.jsonl', [
    { type: 'session', id: 'resume-sess', timestamp: '2026-01-01T00:00:00.000Z', cwd },
    { type: 'message', message: { role: 'user', content: 'first message' } },
    { type: 'message', message: { role: 'assistant', content: 'reply' } },
    { type: 'session_info', name: 'Named Chat' },
  ]);
  const sessionFile = path.join(PROJ_DIR, 'resume.jsonl');

  const child = makeFakeChild();
  _setSpawnPiForTest(() => child);
  t.after(() => _setSpawnPiForTest(null));

  const res = await fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ filePath: sessionFile }),
  });
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.session.id.startsWith('tau_'), true);
  assert.equal(body.session.sessionFile, path.resolve(sessionFile));
  assert.equal(body.session.sessionName, 'Named Chat');
  assert.equal(body.reused, undefined);
  // Verify the session was added to liveManager.
  assert.equal(liveManager.get(body.session.id)?.sessionFile, path.resolve(sessionFile));
  child.stdin.end();
});

test('POST /api/live-sessions/resume exposes historical entries through the live snapshot', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-resume-snapshot-'));
  const entries = [
    { type: 'session', id: 'resume-snapshot-sess', timestamp: '2026-01-01T00:00:00.000Z', cwd },
    { type: 'message', message: { role: 'user', content: 'resume this historical thread' } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'historical reply' }] } },
    { type: 'session_info', name: 'Snapshot Chat' },
  ];
  writeSessionFileAt(PROJ_DIR, 'resume-snapshot.jsonl', entries);
  const sessionFile = path.join(PROJ_DIR, 'resume-snapshot.jsonl');

  const child = makeFakeChild();
  _setSpawnPiForTest(() => child);
  t.after(() => _setSpawnPiForTest(null));

  const resumeRes = await fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ filePath: sessionFile }),
  });
  assert.equal(resumeRes.status, 200);
  const resumeBody = await jsonBody(resumeRes);

  const snapshotRes = await fetch(`${base}/api/live-sessions/${encodeURIComponent(resumeBody.session.id)}/snapshot`);
  assert.equal(snapshotRes.status, 200);
  const snapshot = await jsonBody(snapshotRes);
  assert.equal(snapshot.session.id, resumeBody.session.id);
  assert.equal(snapshot.session.sessionFile, path.resolve(sessionFile));
  assert.equal(snapshot.session.sessionName, 'Snapshot Chat');
  assert.deepEqual(snapshot.entries, entries);
  child.stdin.end();
});

test('POST /api/live-sessions/resume falls back to the first user message for generic or missing names', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-resume-title-'));
  writeSessionFileAt(PROJ_DIR, 'resume-title.jsonl', [
    { type: 'session', id: 'resume-title-sess', timestamp: '2026-01-01T00:00:00.000Z', cwd },
    { type: 'message', message: { role: 'user', content: 'please investigate the flaky tab switching behavior\nwith details' } },
    { type: 'session_info', name: 'chat' },
  ]);
  const sessionFile = path.join(PROJ_DIR, 'resume-title.jsonl');

  const child = makeFakeChild();
  _setSpawnPiForTest(() => child);
  t.after(() => _setSpawnPiForTest(null));

  const res = await fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ filePath: sessionFile }),
  });
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.session.sessionName, 'Investigate the flaky tab switching behavior');
  child.stdin.end();
});

test('POST /api/live-sessions/resume returns reused:true when a live session already exists for the file', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-resume-reuse-'));
  writeSessionFileAt(PROJ_DIR, 'reuse.jsonl', [
    { type: 'session', id: 'reuse-sess', timestamp: '2026-01-01T00:00:00.000Z', cwd },
  ]);
  const sessionFile = path.join(PROJ_DIR, 'reuse.jsonl');

  const child = makeFakeChild();
  _setSpawnPiForTest(() => child);
  t.after(() => _setSpawnPiForTest(null));

  // First resume creates the session.
  const res1 = await fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ filePath: sessionFile }),
  });
  assert.equal(res1.status, 200);
  const body1 = await jsonBody(res1);
  assert.equal(body1.reused, undefined);

  // Second resume returns the same session with reused:true.
  const res2 = await fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ filePath: sessionFile }),
  });
  assert.equal(res2.status, 200);
  const body2 = await jsonBody(res2);
  assert.equal(body2.reused, true);
  assert.equal(body2.session.id, body1.session.id);
  // Only one session in the manager.
  assert.equal(liveManager.sessions.size, 1);
  child.stdin.end();
});

test('POST /api/live-sessions/resume rejects when the session header cwd no longer exists', async () => {
  writeSessionFileAt(PROJ_DIR, 'gone-cwd.jsonl', [
    { type: 'session', id: 'gone-sess', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/definitely/not/a/real/path/tau' },
  ]);
  const sessionFile = path.join(PROJ_DIR, 'gone-cwd.jsonl');

  const res = await fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ filePath: sessionFile }),
  });
  assert.equal(res.status, 400);
  assert.match((await jsonBody(res)).error, /Cannot resume session because its project directory no longer exists/);
});

test('POST /api/live-sessions returns 400 when the cwd does not exist', async (t: TestContext) => {
  _setSpawnPiForTest(() => makeFakeChild());
  t.after(() => _setSpawnPiForTest(null));
  const res = await fetch(`${base}/api/live-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ cwd: '/definitely/not/a/real/path/tau' }),
  });
  assert.equal(res.status, 400);
  assert.match((await jsonBody(res)).error, /Directory not found/);
});

test('GET /api/files filters dotfiles and ignored directories from the listing', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-filter-'));
  fs.mkdirSync(path.join(cwd, 'node_modules'));
  fs.mkdirSync(path.join(cwd, '.hidden'));
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'hi');
  const s = fakeSession('tau_1');
  s.cwd = cwd;
  liveManager.sessions.set('tau_1', s);
  const res = await fetch(`${base}/api/files?sessionId=tau_1`);
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  const names = body.items.map((i: { name: string }) => i.name);
  assert.ok(names.includes('a.txt'));
  assert.ok(!names.includes('node_modules'));
  assert.ok(!names.includes('.hidden'));
});
