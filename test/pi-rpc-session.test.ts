const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-pirs-'));
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions');

const { PiRpcSession, normalizeModel, parseModelSpecToModel, handleRpcCommand, liveManager, _setSpawnPiForTest } = require('../bin/tau.js');
import type { TestContext } from 'node:test';

interface BroadcastMsg {
  type: string;
  sessionId?: string;
  event?: { type: string; [k: string]: unknown };
  session?: { id: string; [k: string]: unknown };
  [k: string]: unknown;
}

type RpcCommand = { type: string; id?: string; message?: string; [k: string]: unknown };
type RpcOpts = { timeoutMs?: number };
type FakeWrite = (data: string, cb?: (err?: Error | null) => void) => void;

function makeManager() {
  const broadcasts: BroadcastMsg[] = [];
  const updated: string[] = [];
  const removed: Array<{ id: string; reason: string }> = [];
  return {
    broadcasts,
    updated,
    removed,
    broadcast(msg: BroadcastMsg) { broadcasts.push(msg); },
    broadcastUpdated(id: string) { updated.push(id); },
    removeExited(id: string, reason: string) { removed.push({ id, reason }); },
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

test('generic session_name events do not block local title generation', () => {
  const { session, manager } = makeSession();
  session.handleEvent({ type: 'session_name', name: 'chat' });
  assert.equal(session.sessionName, null);
  assert.equal(manager.broadcasts.length, 0, 'generic session_name events must not reach clients');
  session.handleEvent({ type: 'message_start', message: { role: 'user', content: 'fix the resumed tab title' } });
  assert.equal(session.sessionName, 'Fix the resumed tab title');
});

test('title is truncated and trimmed for long user messages', () => {
  const { session } = makeSession();
  const long = 'Please generate a very detailed comprehensive plan for migrating the entire monolith into standalone rpc apps with tabs';
  session.handleEvent({ type: 'message_start', message: { role: 'user', content: long } });
  assert.ok(session.sessionName.length <= 60, `got ${session.sessionName.length}`);
  assert.ok(session.sessionName.endsWith('…'));
});

test('assistant message_end records usage but never overwrites model identity', () => {
  const { session } = makeSession('openai/gpt-5.5:high');
  // Precondition: server-tracked model is a full canonical object.
  assert.deepEqual(session.model, { provider: 'openai', id: 'gpt-5.5' });
  const beforeModel = session.model;
  const usage = { input_tokens: 10, output_tokens: 5 };
  session.handleEvent({
    type: 'message_end',
    message: { role: 'assistant', content: 'done', model: 'gpt-5.5', usage },
  });
  assert.equal(session.entries.length, 1);
  // The bare id string on message_end must NOT overwrite the canonical object.
  assert.deepEqual(session.model, beforeModel);
  assert.equal(typeof session.model, 'object');
  assert.deepEqual(session.contextUsage.usage, usage);
});

test('handleResponse resolves a pending send command and updates state', async () => {
  const { session } = makeSession();
  // stub a child with a writable stdin that accepts the write
  session.child = {
    stdin: { writable: true, write: ((_data: string, cb?: (err?: Error | null) => void) => cb && cb()) as FakeWrite },
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
  // `data.model: 'openai/gpt-5.5'` (string) is normalized to a canonical object.
  assert.deepEqual(session.model, { provider: 'openai', id: 'gpt-5.5' });
  assert.equal(session.pending.size, 0);
});

test('send rejects when the child stdin is not writable', async () => {
  const { session } = makeSession();
  session.child = { stdin: { writable: false } };
  await assert.rejects(() => session.send({ type: 'prompt', message: 'hi' }), /not running/);
});

test('send rejects when terminating', async () => {
  const { session } = makeSession();
  session.child = { stdin: { writable: true, write: ((_d: string, cb?: (err?: Error | null) => void) => cb && cb()) as FakeWrite } };
  session.terminating = true;
  await assert.rejects(() => session.send({ type: 'prompt', message: 'hi' }), /not running/);
});

test('terminate rejects pending commands and escalates to SIGKILL when SIGTERM is ignored', async (t: TestContext) => {
  // Mock the SIGTERM grace wait so the escalation logic runs without a real
  // 1.5s sleep. clearTimeout is mocked automatically alongside setTimeout.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session } = makeSession();
  const killedSignals: string[] = [];
  // a stubborn child that never exits and records kill signals
  session.child = {
    exitCode: null,
    signalCode: null,
    stdin: { writable: true, write: ((_d: string, cb?: (err?: Error | null) => void) => cb && cb()) as FakeWrite },
    kill(sig: string) { killedSignals.push(sig); },
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

test('terminate does not escalate to SIGKILL if the child already exited after SIGTERM', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session } = makeSession();
  const killedSignals: string[] = [];
  session.child = {
    exitCode: null,
    signalCode: null,
    stdin: { writable: true, write: ((_d: string, cb?: (err?: Error | null) => void) => cb && cb()) as FakeWrite },
    kill(sig: string) {
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
  session.child = { stdin: { writable: true, write: ((_d: string, cb?: (err?: Error | null) => void) => cb && cb()) as FakeWrite } };
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

test('title is truncated at the first sentence-end punctuation inside the window', () => {
  const { session } = makeSession();
  session.handleEvent({
    type: 'message_start',
    message: { role: 'user', content: 'Fix the bug. Then deploy it everywhere please.' },
  });
  assert.equal(session.sessionName, 'Fix the bug');
});

test('snapshot and metadata expose the current session state', () => {
  const { session } = makeSession('openai/gpt-5.5:high');
  // Constructor canonicalizes the spec into a full object + level.
  assert.deepEqual(session.model, { provider: 'openai', id: 'gpt-5.5' });
  assert.equal(session.thinkingLevel, 'high');
  session.isStreaming = true;
  session.sessionFile = '/tmp/s.jsonl';
  session.sessionName = 'Plan';
  const meta = session.metadata();
  assert.equal(meta.modelSpec, 'openai/gpt-5.5:high');
  assert.equal(meta.modelLabel, 'openai/gpt-5.5');
  assert.equal(meta.isStreaming, true);
  const snap = session.snapshot();
  assert.equal(snap.session.id, session.id);
  assert.equal(snap.isStreaming, true);
  assert.deepEqual(snap.entries, []);
});

test('normalizeModel parses provider/id strings and keeps full objects', () => {
  assert.equal(normalizeModel(null), null);
  assert.equal(normalizeModel(''), null);
  assert.deepEqual(normalizeModel('openai/gpt-4o'), { provider: 'openai', id: 'gpt-4o' });
  assert.deepEqual(normalizeModel('gpt-4o'), { provider: '', id: 'gpt-4o' });
  assert.deepEqual(normalizeModel({ provider: 'openai', id: 'gpt-4o', contextWindow: 128000 }), {
    provider: 'openai', id: 'gpt-4o', contextWindow: 128000,
  });
  assert.deepEqual(normalizeModel({ id: 'gpt-4o' }), { provider: '', id: 'gpt-4o' });
  assert.equal(normalizeModel({ foo: 'bar' }), null);
  // Model IDs containing slashes: split on first slash only.
  assert.deepEqual(normalizeModel('openrouter/z-ai/glm-5.2'), {
    provider: 'openrouter', id: 'z-ai/glm-5.2',
  });
});

test('parseModelSpecToModel parses provider/id[:level]', () => {
  assert.deepEqual(parseModelSpecToModel('openai/gpt-4o:high'), {
    model: { provider: 'openai', id: 'gpt-4o' }, level: 'high',
  });
  assert.deepEqual(parseModelSpecToModel('openai/gpt-4o'), {
    model: { provider: 'openai', id: 'gpt-4o' }, level: null,
  });
  assert.deepEqual(parseModelSpecToModel(''), { model: null, level: null });
  // A colon followed by a non-level token is treated as part of the id, not a level.
  const r = parseModelSpecToModel('anthropic/claude-3.5:sonnet');
  assert.equal(r.level, null);
  assert.deepEqual(r.model, { provider: 'anthropic', id: 'claude-3.5:sonnet' });
  // Model IDs that themselves contain slashes (e.g. OpenRouter "z-ai/glm-5.2").
  assert.deepEqual(parseModelSpecToModel('openrouter/z-ai/glm-5.2:high'), {
    model: { provider: 'openrouter', id: 'z-ai/glm-5.2' }, level: 'high',
  });
  assert.deepEqual(parseModelSpecToModel('openrouter/z-ai/glm-5.2'), {
    model: { provider: 'openrouter', id: 'z-ai/glm-5.2' }, level: null,
  });
});

test('updateStateFromResponse stores a full {provider,id} object, never a bare string', () => {
  const { session } = makeSession();
  session.handleResponse({
    type: 'response', id: 'x', success: true,
    command: 'set_model',
    data: { model: { provider: 'openai', id: 'gpt-4o', contextWindow: 128000 } },
  });
  assert.equal(typeof session.model, 'object');
  assert.deepEqual(session.model, { provider: 'openai', id: 'gpt-4o', contextWindow: 128000 });

  // A bare string model in a non-set_model response is normalized to an object.
  session.handleResponse({
    type: 'response', id: 'y', success: true,
    data: { model: 'anthropic/claude-3.5' },
  });
  assert.deepEqual(session.model, { provider: 'anthropic', id: 'claude-3.5' });
});

test('set_thinking_level echo: session.thinkingLevel updates even when pi returns no level', async () => {
  const { session } = makeSession('openai/gpt-4o');
  liveManager.sessions.set(session.id, session);
  try {
    session.child = { stdin: { writable: true, write: ((_d: string, cb?: (err?: Error | null) => void) => cb && cb()) as FakeWrite } };
    session.send = (_command: RpcCommand, _opts: RpcOpts) =>
      Promise.resolve({ type: 'response', success: true, data: {} });
    const resp = await handleRpcCommand({
      type: 'set_thinking_level', level: 'high', sessionId: session.id,
    });
    assert.equal(resp.success, true);
    assert.equal(session.thinkingLevel, 'high');
  } finally {
    liveManager.sessions.delete(session.id);
  }
});

test('set_thinking_level restores previous level on pi failure', async () => {
  const { session } = makeSession('openai/gpt-4o:medium');
  liveManager.sessions.set(session.id, session);
  try {
    assert.equal(session.thinkingLevel, 'medium');
    session.child = { stdin: { writable: true, write: ((_d: string, cb?: (err?: Error | null) => void) => cb && cb()) as FakeWrite } };
    session.send = (_command: RpcCommand, _opts: RpcOpts) =>
      Promise.resolve({ type: 'response', success: false, error: 'nope' });
    const resp = await handleRpcCommand({
      type: 'set_thinking_level', level: 'high', sessionId: session.id,
    });
    assert.equal(resp.success, false);
    assert.equal(session.thinkingLevel, 'medium');
  } finally {
    liveManager.sessions.delete(session.id);
  }
});

test('constructor accepts sessionFile, entries, and sessionName and they appear in snapshot/metadata', () => {
  const manager = makeManager();
  const entries = [{ type: 'message', message: { role: 'user', content: 'hello' } }, { type: 'message', message: { role: 'assistant', content: 'hi' } }];
  const session = new PiRpcSession(manager, {
    cwd: '/tmp',
    modelSpec: 'openai/gpt-4o',
    sessionFile: '/tmp/resumed.jsonl',
    entries,
    sessionName: 'Resumed Chat',
  });
  assert.equal(session.sessionFile, '/tmp/resumed.jsonl');
  assert.equal(session.sessionName, 'Resumed Chat');
  assert.equal(session.entries.length, 2);
  assert.deepEqual(session.entries[0], entries[0]);
  // Snapshot must include the pre-seeded fields.
  const snap = session.snapshot();
  assert.equal(snap.sessionFile, '/tmp/resumed.jsonl');
  assert.equal(snap.sessionName, 'Resumed Chat');
  assert.equal(snap.entries.length, 2);
  // Metadata must expose sessionFile and sessionName.
  const meta = session.metadata();
  assert.equal(meta.sessionFile, '/tmp/resumed.jsonl');
  assert.equal(meta.sessionName, 'Resumed Chat');
});

test('start() passes --session <file> to spawned pi when sessionFile is set', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const spawnArgs: Array<{ cmd: string; args: string[] }> = [];
  _setSpawnPiForTest((cmd: string, args: string[], _opts: Record<string, unknown>) => {
    spawnArgs.push({ cmd, args });
    const { EventEmitter } = require('node:events');
    const { PassThrough } = require('node:stream');
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 55555;
    child.kill = () => {};
    return child;
  });
  t.after(() => _setSpawnPiForTest(null));
  const mgr = new (require('../bin/tau.js').LiveSessionManager)();
  const cwd = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tau-spawnargs-'));
  const createP = mgr.resume({ sessionFile: '/tmp/some-session.jsonl', cwd, model: 'openai/gpt-4o' });
  t.mock.timers.tick(100);
  await createP;
  assert.equal(spawnArgs.length, 1);
  const args = spawnArgs[0].args;
  assert.ok(args.includes('--mode'));
  assert.ok(args.includes('rpc'));
  assert.ok(args.includes('--session'));
  const sessionIdx = args.indexOf('--session');
  assert.ok(sessionIdx >= 0);
  assert.equal(args[sessionIdx + 1], '/tmp/some-session.jsonl');
  assert.ok(args.includes('--model'));
  assert.equal(args[args.indexOf('--model') + 1], 'openai/gpt-4o');
});

test('extension-refresh: prompt ack triggers get_state refresh and broadcast', async () => {
  const { session, manager } = makeSession('openai/gpt-4o:off');
  // Register this session in the liveManager so refreshSessionModel's
  // broadcastUpdated path is exercised against a real manager.
  liveManager.sessions.set(session.id, session);
  try {
    session.child = { stdin: { writable: true, write: ((_d: string, cb?: (err?: Error | null) => void) => cb && cb()) as FakeWrite } };
    // Track outbound command sequence: first prompt, then get_state.
    let calls: string[] = [];
    session.send = (command: RpcCommand, opts: RpcOpts) => {
      calls.push(command.type);
      const id = command.id || `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`;
      if (command.type === 'prompt') {
        return Promise.resolve({ type: 'response', id, success: true, data: {} });
      }
      if (command.type === 'get_state') {
        // Simulate an extension having changed the model mid-prompt.
        return Promise.resolve({
          type: 'response', id, success: true,
          data: { model: { provider: 'openai', id: 'gpt-4o-mini' }, thinkingLevel: 'high' },
        });
      }
      return Promise.resolve({ type: 'response', id, success: true, data: {} });
    };
    // Collect broadcastUpdated calls from the real liveManager.
    const updatedIds: string[] = [];
    const origBroadcast = liveManager.broadcast.bind(liveManager);
    liveManager.broadcast = (msg: BroadcastMsg | null) => {
      if (msg && msg.type === 'live_session_updated' && msg.session) updatedIds.push(msg.session.id);
      origBroadcast(msg);
    };
    const resp = await handleRpcCommand({
      type: 'prompt', message: '/session-model openai/gpt-4o-mini:high', sessionId: session.id,
    });
    assert.equal(resp.success, true);
    // Allow the fire-and-forget refresh to run.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, ['prompt', 'get_state']);
    assert.deepEqual(session.model, { provider: 'openai', id: 'gpt-4o-mini' });
    assert.equal(session.thinkingLevel, 'high');
    assert.ok(updatedIds.includes(session.id), 'expected a broadcastUpdated for the refreshed session');
  } finally {
    liveManager.sessions.delete(session.id);
  }
});
