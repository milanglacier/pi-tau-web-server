const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-pirs-'));
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions');

const { PiRpcSession } = require('../bin/tau.js');

function makeManager() {
  const broadcasts = [];
  const updated = [];
  const removed = [];
  return {
    broadcasts,
    updated,
    removed,
    broadcast(msg) { broadcasts.push(msg); },
    broadcastUpdated(id) { updated.push(id); },
    removeExited(id, reason) { removed.push({ id, reason }); },
  };
}

function makeSession(modelSpec = '') {
  const manager = makeManager();
  const session = new PiRpcSession(manager, { cwd: '/tmp', modelSpec });
  return { session, manager };
}

test('agent_start/turn_start set isStreaming; agent_end/turn_end clear it', () => {
  const { session, manager } = makeSession();
  session.handleEvent({ type: 'turn_start' });
  assert.equal(session.isStreaming, true);
  session.handleEvent({ type: 'agent_start' });
  assert.equal(session.isStreaming, true);
  session.handleEvent({ type: 'turn_end' });
  assert.equal(session.isStreaming, false);
  session.handleEvent({ type: 'agent_end' });
  assert.equal(session.isStreaming, false);
  // each event is broadcast
  assert.equal(manager.broadcasts.length, 4);
  for (const b of manager.broadcasts) {
    assert.equal(b.type, 'event');
    assert.equal(b.sessionId, session.id);
  }
});

test('thinking_level_changed and model_select update state', () => {
  const { session } = makeSession();
  session.handleEvent({ type: 'thinking_level_changed', level: 'high' });
  assert.equal(session.thinkingLevel, 'high');
  session.handleEvent({ type: 'thinking_level_changed', thinkingLevel: 'medium' });
  assert.equal(session.thinkingLevel, 'medium');
  session.handleEvent({ type: 'model_select', model: { provider: 'openai', id: 'gpt-5.5' } });
  assert.deepEqual(session.model, { provider: 'openai', id: 'gpt-5.5' });
});

test('user message_start tracks an entry and derives a session title', () => {
  const { session, manager } = makeSession();
  session.handleEvent({
    type: 'message_start',
    message: { role: 'user', content: 'ok so please help me refactor the parser' },
  });
  assert.equal(session.entries.length, 1);
  assert.equal(session.userMessages.length, 1);
  assert.equal(session.titleSet, true);
  // only the first leading filler word is stripped, then capitalized
  assert.equal(session.sessionName, 'So please help me refactor the parser');
  // a session_name event is broadcast
  const nameEvent = manager.broadcasts.find(
    (b) => b.event && b.event.type === 'session_name',
  );
  assert.ok(nameEvent, 'expected a session_name broadcast');
});

test('title is truncated and trimmed for long user messages', () => {
  const { session } = makeSession();
  const long = 'Please generate a very detailed comprehensive plan for migrating the entire monolith into standalone rpc apps with tabs';
  session.handleEvent({ type: 'message_start', message: { role: 'user', content: long } });
  assert.ok(session.sessionName.length <= 60, `got ${session.sessionName.length}`);
  assert.ok(session.sessionName.endsWith('…'));
});

test('assistant message_end tracks entry and records model + usage', () => {
  const { session } = makeSession();
  const usage = { input_tokens: 10, output_tokens: 5 };
  session.handleEvent({
    type: 'message_end',
    message: { role: 'assistant', content: 'done', model: { id: 'gpt-5.5' }, usage },
  });
  assert.equal(session.entries.length, 1);
  assert.deepEqual(session.model, { id: 'gpt-5.5' });
  assert.deepEqual(session.contextUsage.usage, usage);
});

test('handleResponse resolves a pending send command and updates state', async () => {
  const { session } = makeSession();
  // stub a child with a writable stdin that accepts the write
  session.child = {
    stdin: { writable: true, write: (_data, cb) => cb && cb() },
  };
  const p = session.send({ type: 'get_session_stats' }, { timeoutMs: 500 });
  // find the assigned id from the pending map
  const id = [...session.pending.keys()][0];
  session.handleResponse({
    type: 'response',
    id,
    success: true,
    data: { sessionFile: '/tmp/s.jsonl', contextUsage: { tokens: 42 }, model: 'openai/gpt-5.5' },
  });
  const resp = await p;
  assert.equal(resp.data.sessionFile, '/tmp/s.jsonl');
  assert.equal(session.sessionFile, '/tmp/s.jsonl');
  assert.equal(session.model, 'openai/gpt-5.5');
  assert.equal(session.pending.size, 0);
});

test('send rejects when the child stdin is not writable', async () => {
  const { session } = makeSession();
  session.child = { stdin: { writable: false } };
  await assert.rejects(() => session.send({ type: 'prompt', message: 'hi' }), /not running/);
});

test('send rejects when terminating', async () => {
  const { session } = makeSession();
  session.child = { stdin: { writable: true, write: (_d, cb) => cb && cb() } };
  session.terminating = true;
  await assert.rejects(() => session.send({ type: 'prompt', message: 'hi' }), /not running/);
});

test('terminate rejects pending commands and escalates to SIGKILL when SIGTERM is ignored', async (t) => {
  // Mock the SIGTERM grace wait so the escalation logic runs without a real
  // 1.5s sleep. clearTimeout is mocked automatically alongside setTimeout.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session } = makeSession();
  const killedSignals = [];
  // a stubborn child that never exits and records kill signals
  session.child = {
    exitCode: null,
    signalCode: null,
    stdin: { writable: true, write: (_d, cb) => cb && cb() },
    kill(sig) { killedSignals.push(sig); },
  };
  // plant a pending command; attach the rejection handler BEFORE terminate
  // runs so the pending rejection isn't reported as an unhandled rejection.
  const p = session.send({ type: 'get_session_stats' }, { timeoutMs: 100000 });
  const check = assert.rejects(p, /Session terminated/);
  const term = session.terminate('closed_by_user');
  // advance past the 1500ms grace wait so terminate can re-check and SIGKILL
  t.mock.timers.tick(1500);
  await Promise.all([term, check]);
  assert.equal(session.pending.size, 0);
  assert.equal(session.terminating, true);
  // SIGTERM then SIGKILL because exitCode/signalCode stayed null
  assert.deepEqual(killedSignals, ['SIGTERM', 'SIGKILL']);
});

test('terminate does not escalate to SIGKILL if the child already exited after SIGTERM', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session } = makeSession();
  const killedSignals = [];
  session.child = {
    exitCode: null,
    signalCode: null,
    stdin: { writable: true, write: (_d, cb) => cb && cb() },
    kill(sig) {
      killedSignals.push(sig);
      // simulate the process exiting due to SIGTERM
      session.child.exitCode = 0;
      session.child.signalCode = 'SIGTERM';
    },
  };
  const term = session.terminate('closed_by_user');
  t.mock.timers.tick(1500);
  await term;
  assert.deepEqual(killedSignals, ['SIGTERM']);
});

test('handleExit rejects pending and notifies the manager once', async () => {
  const manager = makeManager();
  const session = new PiRpcSession(manager, { cwd: '/tmp' });
  session.child = { stdin: { writable: true, write: (_d, cb) => cb && cb() } };
  const p = session.send({ type: 'get_session_stats' }, { timeoutMs: 100000 });
  const check = assert.rejects(p, /Pi process exited/);
  session.handleExit(1, null);
  await check;
  assert.equal(manager.removed.length, 1);
  assert.equal(manager.removed[0].id, session.id);
  // a second exit event is ignored
  session.handleExit(0, null);
  assert.equal(manager.removed.length, 1);
});

test('handleLine parses JSON and routes responses vs events', () => {
  const { session, manager } = makeSession();
  session.handleLine(JSON.stringify({ type: 'response', id: 'nope', data: {} }));
  // unknown response id is a no-op for pending but still broadcast
  assert.equal(manager.broadcasts.length, 1);
  session.handleLine(JSON.stringify({ type: 'turn_start' }));
  assert.equal(session.isStreaming, true);
  // non-JSON lines are ignored without throwing
  session.handleLine('not json at all');
  session.handleLine('');
  assert.equal(session.isStreaming, true);
});

test('snapshot and metadata expose the current session state', () => {
  const { session } = makeSession('openai/gpt-5.5:high');
  session.model = 'openai/gpt-5.5:high';
  session.isStreaming = true;
  session.sessionFile = '/tmp/s.jsonl';
  session.sessionName = 'Plan';
  const meta = session.metadata();
  assert.equal(meta.modelSpec, 'openai/gpt-5.5:high');
  assert.equal(meta.modelLabel, 'openai/gpt-5.5:high');
  assert.equal(meta.isStreaming, true);
  const snap = session.snapshot();
  assert.equal(snap.session.id, session.id);
  assert.equal(snap.isStreaming, true);
  assert.deepEqual(snap.entries, []);
});
