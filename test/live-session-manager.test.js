const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { LiveSessionManager } = require('../bin/tau.js');

function openClient() {
  // stub ws client that looks open to the broadcaster
  const sent = [];
  return { readyState: WebSocket.OPEN, send: (data) => sent.push(data), sent };
}
function closedClient() {
  return { readyState: WebSocket.CLOSING, sent: [], send: () => { throw new Error('should not send to closed client'); } };
}

function fakeSession(id, opts = {}) {
  const meta = {
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
  const calls = { terminated: [], terminatedArgs: [] };
  return {
    id,
    metadata: () => ({ ...meta }),
    terminate: async (reason) => { calls.terminated.push(true); calls.terminatedArgs.push(reason); },
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
