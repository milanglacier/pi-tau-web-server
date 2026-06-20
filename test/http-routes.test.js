const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Loopback host so computeUrls() sets a localhost mirrorUrl; isolate settings.
process.env.TAU_HOST = '127.0.0.1';
process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-http-'));
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions');

const { server, computeUrls, liveManager } = require('../bin/tau.js');

let base = '';

function fakeSession(id) {
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

before((t, done) => {
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    computeUrls(port);
    base = `http://127.0.0.1:${port}`;
    done();
  });
});

after((t, done) => {
  server.close(done);
});

beforeEach(() => {
  liveManager.sessions.clear();
});

async function jsonBody(res) {
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

test('cross-origin API preflight is rejected with 403', async () => {
  const res = await fetch(`${base}/api/live-sessions`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://evil.example', Host: new URL(base).host, 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(res.status, 403);
});

test('same-origin API preflight is allowed with 200', async () => {
  const host = new URL(base).host;
  const res = await fetch(`${base}/api/live-sessions`, {
    method: 'OPTIONS',
    headers: { Origin: base, Host: host, 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(res.status, 200);
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
