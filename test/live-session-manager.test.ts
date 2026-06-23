const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { WebSocket } = require('ws');
const { LiveSessionManager, _setSpawnPiForTest } = require('../bin/tau.js');
import type { TestContext } from 'node:test';

interface StubClient {
  readyState: number;
  send: (data: string) => void;
  sent: string[];
}

function openClient(): StubClient {
  // stub ws client that looks open to the broadcaster
  const sent: string[] = [];
  return { readyState: WebSocket.OPEN, send: (data: string) => sent.push(data), sent };
}
function closedClient(): StubClient {
  return { readyState: WebSocket.CLOSING, sent: [], send: () => { throw new Error('should not send to closed client'); } };
}

function fakeSession(id: string, opts: { name?: string } = {}) {
  const meta: {
    id: string; pid: number; cwd: string; modelSpec: string; model: string; modelLabel: string;
    thinkingLevel: string; sessionFile: string; sessionName: string | null; isStreaming: boolean;
    createdAt: string; lastActiveAt: string; contextUsage: null;
  } = {
    id,
    pid: 123,
    cwd: '/tmp',
    modelSpec: '',
    model: 'openai/gpt-5.5',
    modelLabel: 'openai/gpt-5.5',
    thinkingLevel: 'off',
    sessionFile: `/tmp/${id}.jsonl`,
    sessionName: opts.name || null,
    isStreaming: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    contextUsage: null,
  };
  const calls: { terminated: boolean[]; terminatedArgs: string[] } = { terminated: [], terminatedArgs: [] };
  return {
    id,
    metadata: () => ({ ...meta }),
    terminate: async (reason: string) => { calls.terminated.push(true); calls.terminatedArgs.push(reason); },
    calls,
  };
}

test('broadcast only delivers to OPEN clients', () => {
  const mgr = new LiveSessionManager();
  const a = openClient();
  const b = openClient();
  const c = closedClient();
  mgr.addClient(a); mgr.addClient(b); mgr.addClient(c);
  mgr.broadcast({ type: 'ping' });
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 1);
  assert.equal(c.sent.length, 0);
  assert.deepEqual(JSON.parse(a.sent[0]), { type: 'ping' });
});

test('list and get expose session metadata', () => {
  const mgr = new LiveSessionManager();
  const s = fakeSession('tau_1');
  mgr.sessions.set(s.id, s);
  assert.equal(mgr.get('tau_1'), s);
  assert.equal(mgr.list().length, 1);
  assert.equal(mgr.list()[0].id, 'tau_1');
});

test('broadcastUpdated sends live_session_updated with metadata', () => {
  const mgr = new LiveSessionManager();
  const a = openClient();
  mgr.addClient(a);
  const s = fakeSession('tau_1');
  mgr.sessions.set(s.id, s);
  mgr.broadcastUpdated('tau_1');
  const msg = JSON.parse(a.sent[0]);
  assert.equal(msg.type, 'live_session_updated');
  assert.equal(msg.session.id, 'tau_1');
  // unknown id is a no-op (no broadcast)
  a.sent.length = 0;
  mgr.broadcastUpdated('missing');
  assert.equal(a.sent.length, 0);
});

test('delete removes the session, broadcasts closed, and terminates the child', async () => {
  const mgr = new LiveSessionManager();
  const a = openClient();
  mgr.addClient(a);
  const s = fakeSession('tau_1');
  mgr.sessions.set(s.id, s);
  const ok = await mgr.delete('tau_1', 'closed_by_user');
  assert.equal(ok, true);
  assert.equal(mgr.sessions.has('tau_1'), false);
  assert.equal(s.calls.terminated.length, 1);
  assert.equal(s.calls.terminatedArgs[0], 'closed_by_user');
  const msg = JSON.parse(a.sent[0]);
  assert.equal(msg.type, 'live_session_closed');
  assert.equal(msg.sessionId, 'tau_1');
  assert.equal(msg.reason, 'closed_by_user');
});

test('delete returns false for an unknown session and does not broadcast', async () => {
  const mgr = new LiveSessionManager();
  const a = openClient();
  mgr.addClient(a);
  const ok = await mgr.delete('nope');
  assert.equal(ok, false);
  assert.equal(a.sent.length, 0);
});

test('removeExited broadcasts closed only when the session is present', () => {
  const mgr = new LiveSessionManager();
  const a = openClient();
  mgr.addClient(a);
  mgr.removeExited('nope', 'process_exit:0');
  assert.equal(a.sent.length, 0);
  const s = fakeSession('tau_1');
  mgr.sessions.set(s.id, s);
  mgr.removeExited('tau_1', 'process_exit:1');
  assert.equal(mgr.sessions.has('tau_1'), false);
  assert.equal(JSON.parse(a.sent[0]).type, 'live_session_closed');
});

test('shutdown terminates all managed sessions and clears the map', async () => {
  const mgr = new LiveSessionManager();
  const s1 = fakeSession('tau_1');
  const s2 = fakeSession('tau_2');
  mgr.sessions.set(s1.id, s1);
  mgr.sessions.set(s2.id, s2);
  await mgr.shutdown();
  assert.equal(mgr.sessions.size, 0);
  assert.equal(s1.calls.terminated.length, 1);
  assert.equal(s2.calls.terminated.length, 1);
  assert.equal(s1.calls.terminatedArgs[0], 'server_shutdown');
});

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

test('create() resolves cwd, stores the session, and broadcasts live_session_created', async (t: TestContext) => {
  // Mock the startup setTimeouts in start() so the test does not wait on
  // wall-clock time for the 100ms startup grace.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = makeFakeChild();
  _setSpawnPiForTest(() => child);
  t.after(() => _setSpawnPiForTest(null));

  const mgr = new LiveSessionManager();
  const client = openClient();
  mgr.addClient(client);

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-create-'));
  const createP = mgr.create({ cwd, model: 'openai/gpt-5.5' });
  // advance past start()'s 100ms startup wait so it resolves
  t.mock.timers.tick(100);
  const session = await createP;

  assert.equal(mgr.get(session.id), session);
  assert.equal(session.cwd, path.resolve(cwd));
  assert.equal(session.modelSpec, 'openai/gpt-5.5');
  assert.equal(session.pid, 12345);
  // the live_session_created broadcast is delivered to the connected client
  assert.equal(client.sent.length, 1);
  const msg = JSON.parse(client.sent[0]);
  assert.equal(msg.type, 'live_session_created');
  assert.equal(msg.session.id, session.id);
  // The server canonicalizes the spec into a full {provider,id} object.
  assert.deepEqual(msg.session.model, { provider: 'openai', id: 'gpt-5.5' });
  assert.equal(msg.session.modelLabel, 'openai/gpt-5.5');
});

test('resume() passes --session, seeds entries/name, stores, and broadcasts', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = makeFakeChild();
  _setSpawnPiForTest(() => child);
  t.after(() => _setSpawnPiForTest(null));

  const mgr = new LiveSessionManager();
  const client = openClient();
  mgr.addClient(client);

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-resume-'));
  const sessionFile = path.join(cwd, 'test.jsonl');
  const entries = [{ type: 'message', message: { role: 'user', content: 'hi' } }];

  const resumeP = mgr.resume({ sessionFile, cwd, model: 'openai/gpt-4o', entries, sessionName: 'My Session' });
  t.mock.timers.tick(100);
  const session = await resumeP;

  assert.equal(mgr.get(session.id), session);
  assert.equal(session.sessionFile, path.resolve(sessionFile));
  assert.equal(session.sessionName, 'My Session');
  assert.equal(session.entries.length, 1);
  assert.deepEqual(session.entries[0], entries[0]);
  assert.equal(session.cwd, path.resolve(cwd));

  // Broadcast includes sessionFile and sessionName in metadata.
  const msg = JSON.parse(client.sent[0]);
  assert.equal(msg.type, 'live_session_created');
  assert.equal(msg.session.sessionFile, path.resolve(sessionFile));
  assert.equal(msg.session.sessionName, 'My Session');
});

test('resume() coalesces concurrent and repeated resumes for the same file', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = makeFakeChild();
  let call = 0;
  _setSpawnPiForTest(() => { call++; return child; });
  t.after(() => _setSpawnPiForTest(null));

  const mgr = new LiveSessionManager();
  const client = openClient();
  mgr.addClient(client);

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-resume2-'));
  const sessionFile = path.join(cwd, 'dup.jsonl');

  const p1 = mgr.resume({ sessionFile, cwd });
  const p2 = mgr.resume({ sessionFile, cwd });
  assert.equal(mgr.hasPendingResume(sessionFile), true);
  t.mock.timers.tick(100);
  const [s1, s2] = await Promise.all([p1, p2]);
  assert.equal(s1.id, s2.id);
  assert.equal(call, 1);
  assert.equal(mgr.sessions.size, 1);
  assert.equal(client.sent.length, 1);

  const s3 = await mgr.resume({ sessionFile, cwd });
  assert.equal(s3.id, s1.id);
  assert.equal(call, 1);
  assert.equal(mgr.sessions.size, 1);
});

test('resume() waits for a terminating session with the same file before spawning again', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let call = 0;
  _setSpawnPiForTest(() => { call++; return makeFakeChild(); });
  t.after(() => _setSpawnPiForTest(null));

  const mgr = new LiveSessionManager();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-resume-terminate-'));
  const sessionFile = path.join(cwd, 'resume.jsonl');

  const firstP = mgr.resume({ sessionFile, cwd });
  t.mock.timers.tick(100);
  const first = await firstP;
  assert.equal(call, 1);

  const deleteP = mgr.delete(first.id);
  assert.equal(mgr.hasTerminatingResume(sessionFile), true);
  assert.equal(mgr.sessions.size, 0);

  const secondP = mgr.resume({ sessionFile, cwd });
  assert.equal(call, 1, 'resume must not spawn while the old child is terminating');
  assert.equal(mgr.hasPendingResume(sessionFile), true);

  t.mock.timers.tick(1500);
  for (let i = 0; i < 20 && call < 2; i++) await Promise.resolve();
  assert.equal(call, 2, 'resume should spawn after termination completes');
  t.mock.timers.tick(100);
  const [second] = await Promise.all([secondP, deleteP]);

  assert.notEqual(second.id, first.id);
  assert.equal(call, 2);
  assert.equal(mgr.sessions.size, 1);
  assert.equal(mgr.hasTerminatingResume(sessionFile), false);
});

test('create() rejects when the cwd does not exist', async (t: TestContext) => {
  _setSpawnPiForTest(() => makeFakeChild());
  t.after(() => _setSpawnPiForTest(null));
  const mgr = new LiveSessionManager();
  await assert.rejects(
    () => mgr.create({ cwd: '/definitely/not/a/real/path/tau' }),
    /Directory not found/,
  );
  assert.equal(mgr.sessions.size, 0);
});
