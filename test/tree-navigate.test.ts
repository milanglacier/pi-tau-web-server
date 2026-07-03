const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

import type { ChildProcess } from 'node:child_process';
import type { TestContext } from 'node:test';

// Isolate settings + sessions in a temp tree. Env must be set before
// requiring the module.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-tree-'));
process.env.PI_CODING_AGENT_DIR = TMP;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(TMP, 'sessions');

const {
  handleRpcCommand,
  liveManager,
  navigateTree,
  applyTreeNavigation,
  selectNavigationTarget,
  flattenTree,
  pathFromRoot,
  leafDescendsFrom,
  NAVIGATION_MARKER_TYPE,
} = require('../bin/tau.js');

type Json = Record<string, any>;

const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-tree-proj-'));
let fileCounter = 0;

// Small session tree, format per docs/session-format.md:
//   u1 (user) → a1 (assistant) → u2 (user) → a2 (assistant)
function writeTreeSession(): string {
  const file = path.join(PROJ, `session-${fileCounter++}.jsonl`);
  const lines: Json[] = [
    { type: 'session', version: 3, id: '0199aaaa-1111-2222-3333-444444444444', timestamp: '2026-07-01T00:00:00.000Z', cwd: PROJ },
    { type: 'message', id: 'u1', parentId: null, timestamp: '2026-07-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'first user message' }], timestamp: 1 } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-07-01T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'first assistant reply' }] } },
    { type: 'message', id: 'u2', parentId: 'a1', timestamp: '2026-07-01T00:00:03.000Z', message: { role: 'user', content: [{ type: 'text', text: 'second user message' }], timestamp: 2 } },
    { type: 'message', id: 'a2', parentId: 'u2', timestamp: '2026-07-01T00:00:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'second assistant reply' }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

function readEntries(file: string): Json[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l: string) => l.trim()).map((l: string) => JSON.parse(l));
}

async function openWithSdk(file: string) {
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  return SessionManager.open(file);
}

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(PROJ, { recursive: true, force: true });
});

// ═══════════════════════════════════════
// selectNavigationTarget (pure selection semantics)
// ═══════════════════════════════════════

test('selectNavigationTarget: user message → parent + editor text', () => {
  const target = selectNavigationTarget({ id: 'u2', parentId: 'a1', type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } });
  assert.deepEqual(target, { leafTargetId: 'a1', editorText: 'hello' });
});

test('selectNavigationTarget: root user message → null leaf + editor text', () => {
  const target = selectNavigationTarget({ id: 'u1', parentId: null, type: 'message', message: { role: 'user', content: 'plain string content' } });
  assert.deepEqual(target, { leafTargetId: null, editorText: 'plain string content' });
});

test('selectNavigationTarget: custom message → parent + editor text', () => {
  const target = selectNavigationTarget({ id: 'c1', parentId: 'a1', type: 'custom_message', customType: 'ext', content: [{ type: 'text', text: 'custom text' }] });
  assert.deepEqual(target, { leafTargetId: 'a1', editorText: 'custom text' });
});

test('selectNavigationTarget: assistant / other entries → the entry itself, no editor text', () => {
  assert.deepEqual(selectNavigationTarget({ id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant', content: [] } }), { leafTargetId: 'a1' });
  assert.deepEqual(selectNavigationTarget({ id: 'k1', parentId: 'a1', type: 'compaction' }), { leafTargetId: 'k1' });
});

// ═══════════════════════════════════════
// applyTreeNavigation (branches the file via the pi SDK)
// ═══════════════════════════════════════

test('navigating to an assistant entry moves the file leaf to that entry', async () => {
  const file = writeTreeSession();
  const nav = await applyTreeNavigation(file, 'a1');
  assert.equal(nav.changed, true);
  assert.equal(nav.leafTargetId, 'a1');
  assert.equal(nav.editorText, undefined);

  const entries = readEntries(file);
  const marker = entries[entries.length - 1];
  assert.equal(marker.type, 'custom');
  assert.equal(marker.customType, NAVIGATION_MARKER_TYPE);
  assert.equal(marker.parentId, 'a1');
  assert.equal(marker.id, nav.markerId);

  // A fresh SDK load (what the pi child does on switch_session) derives the
  // leaf from the last entry, so the active path is now root → a1 → marker.
  const sm = await openWithSdk(file);
  assert.equal(sm.getLeafId(), nav.markerId);
  assert.deepEqual(sm.getBranch().map((e: Json) => e.id), ['u1', 'a1', nav.markerId]);
});

test('navigating to a user message moves the leaf to its parent and returns the message text', async () => {
  const file = writeTreeSession();
  const nav = await applyTreeNavigation(file, 'u2');
  assert.equal(nav.changed, true);
  assert.equal(nav.leafTargetId, 'a1');
  assert.equal(nav.editorText, 'second user message');

  const sm = await openWithSdk(file);
  assert.deepEqual(sm.getBranch().map((e: Json) => e.id), ['u1', 'a1', nav.markerId]);
});

test('navigating to the root user message resets to an empty conversation and returns the prompt', async () => {
  const file = writeTreeSession();
  const nav = await applyTreeNavigation(file, 'u1');
  assert.equal(nav.changed, true);
  assert.equal(nav.leafTargetId, null);
  assert.equal(nav.editorText, 'first user message');

  const entries = readEntries(file);
  const marker = entries[entries.length - 1];
  assert.equal(marker.parentId, null);

  const sm = await openWithSdk(file);
  assert.deepEqual(sm.getBranch().map((e: Json) => e.id), [nav.markerId]);
  // The marker is a `custom` entry, so it never reaches the LLM context.
  assert.deepEqual(sm.buildSessionContext().messages, []);
});

test('navigating to the current leaf is a no-op on the file', async () => {
  const file = writeTreeSession();
  const linesBefore = readEntries(file).length;
  const nav = await applyTreeNavigation(file, 'a2');
  assert.equal(nav.changed, false);
  assert.equal(nav.markerId, null);
  assert.equal(readEntries(file).length, linesBefore);
});

test('navigating to an unknown entry fails with a clear error', async () => {
  const file = writeTreeSession();
  await assert.rejects(() => applyTreeNavigation(file, 'nope'), /Entry nope not found/);
});

// ═══════════════════════════════════════
// tree helpers
// ═══════════════════════════════════════

function sampleTree() {
  // u1 → a1 → { u2 → a2, marker }
  return [{
    entry: { id: 'u1', parentId: null, type: 'message' },
    children: [{
      entry: { id: 'a1', parentId: 'u1', type: 'message' },
      children: [
        { entry: { id: 'u2', parentId: 'a1', type: 'message' }, children: [{ entry: { id: 'a2', parentId: 'u2', type: 'message' }, children: [] }] },
        { entry: { id: 'm1', parentId: 'a1', type: 'custom' }, children: [] },
      ],
    }],
  }];
}

test('flattenTree/pathFromRoot/leafDescendsFrom walk the get_tree payload', () => {
  const byId = flattenTree(sampleTree());
  assert.equal(byId.size, 5);
  assert.deepEqual(pathFromRoot(byId, 'm1').map((e: Json) => e.id), ['u1', 'a1', 'm1']);
  assert.deepEqual(pathFromRoot(byId, null), []);
  assert.equal(leafDescendsFrom(byId, 'm1', 'a1'), true);
  assert.equal(leafDescendsFrom(byId, 'm1', 'm1'), true);
  assert.equal(leafDescendsFrom(byId, 'a2', 'm1'), false);
});

// ═══════════════════════════════════════
// navigateTree orchestration (fake pi child, no LLM)
// ═══════════════════════════════════════

function fakeSession(file: string | null, opts: { isStreaming?: boolean } = {}) {
  const sent: Json[] = [];
  const broadcasts: Json[] = [];
  const updated: string[] = [];
  const session = {
    id: 'live_1',
    sessionFile: file,
    isStreaming: !!opts.isStreaming,
    entries: [] as Json[],
    sent,
    broadcasts,
    updated,
    async send(command: Json) {
      sent.push(command);
      if (command.type === 'switch_session') return { type: 'response', command: 'switch_session', success: true, data: { cancelled: false } };
      if (command.type === 'get_tree') {
        // Answer exactly like the pi child would after reloading the file.
        const sm = await openWithSdk(file!);
        return { type: 'response', command: 'get_tree', success: true, data: { tree: sm.getTree(), leafId: sm.getLeafId() } };
      }
      throw new Error(`unexpected command: ${command.type}`);
    },
    snapshot() { return { session: { id: this.id }, entries: this.entries, isStreaming: this.isStreaming, sessionFile: this.sessionFile }; },
    manager: {
      broadcast(data: Json) { broadcasts.push(data); },
      broadcastUpdated(id: string) { updated.push(id); },
    },
  };
  return session;
}

test('navigateTree reloads the child, re-derives the active path, and broadcasts a snapshot', async () => {
  const file = writeTreeSession();
  const session = fakeSession(file);
  const result = await navigateTree(session, 'u2');
  assert.equal(result.editorText, 'second user message');

  // A preflight get_tree confirms the child is alive before the file is
  // touched, then the child is told to reload the SAME session file.
  assert.deepEqual(session.sent.map((c: Json) => c.type), ['get_tree', 'switch_session', 'get_tree']);
  assert.equal(session.sent[1].sessionPath, file);

  // entries now hold the new active path root → target (marker included).
  const ids = session.entries.map((e: Json) => e.id);
  assert.deepEqual(ids.slice(0, 2), ['u1', 'a1']);
  assert.equal(session.entries[session.entries.length - 1].customType, NAVIGATION_MARKER_TYPE);
  assert.ok(!ids.includes('u2') && !ids.includes('a2'));

  // Every browser gets a fresh full snapshot plus the metadata update.
  assert.equal(session.broadcasts.length, 1);
  assert.equal(session.broadcasts[0].type, 'live_session_snapshot');
  assert.equal(session.broadcasts[0].sessionId, 'live_1');
  assert.deepEqual(session.broadcasts[0].entries.map((e: Json) => e.id), ids);
  assert.deepEqual(session.updated, ['live_1']);
});

test('navigateTree refuses while the session is streaming', async () => {
  const file = writeTreeSession();
  const session = fakeSession(file, { isStreaming: true });
  await assert.rejects(() => navigateTree(session, 'a1'), /while the agent is streaming/);
  assert.equal(session.sent.length, 0);
  assert.equal(readEntries(file).length, 5); // file untouched
});

test('navigateTree refuses when the session has no session file yet', async () => {
  const session = fakeSession(null);
  await assert.rejects(() => navigateTree(session, 'a1'), /no session file yet/);
});

test('a turn that starts during navigation aborts it before the file is touched', async () => {
  const file = writeTreeSession();
  const session = fakeSession(file);
  // Simulate agent_start racing in while the preflight get_tree round-trips:
  // the guard passed once, but the re-check after the await must still refuse.
  const origSend = session.send.bind(session);
  session.send = async (command: Json) => {
    const resp = await origSend(command);
    session.isStreaming = true;
    return resp;
  };
  await assert.rejects(() => navigateTree(session, 'a1'), /streaming/);
  assert.equal(readEntries(file).length, 5); // no marker was written
});

test('concurrent navigations on the same session are refused instead of interleaved', async () => {
  const file = writeTreeSession();
  const session = fakeSession(file);
  const origSend = session.send.bind(session);
  session.send = async (command: Json) => {
    await new Promise((r) => setTimeout(r, 25));
    return origSend(command);
  };
  const first = navigateTree(session, 'a1');
  await assert.rejects(() => navigateTree(session, 'u2'), /already in progress/);
  await first;
});

test('a failed child reload rolls the persisted leaf back to where it was', async () => {
  const file = writeTreeSession();
  const session = fakeSession(file);
  const origSend = session.send.bind(session);
  session.send = (async (command: Json) => {
    if (command.type === 'switch_session') {
      session.sent.push(command);
      return { type: 'response', command: 'switch_session', success: false, error: 'child exploded' };
    }
    return origSend(command);
  }) as typeof session.send;
  await assert.rejects(() => navigateTree(session, 'a1'), /failed to reload/);

  // The navigation marker landed on disk before the reload failed, but the
  // rollback marker moves the persisted leaf back: a resume of this file
  // lands on the pre-navigation branch, not on the failed target.
  const sm = await openWithSdk(file);
  const branch = sm.getBranch().map((e: Json) => e.id);
  assert.deepEqual(branch.slice(0, 4), ['u1', 'a1', 'u2', 'a2']);
  const leaf = sm.getEntry(sm.getLeafId()!) as Json;
  assert.equal(leaf.customType, NAVIGATION_MARKER_TYPE);
  assert.equal(leaf.parentId, 'a2');
});

// ═══════════════════════════════════════
// handleRpcCommand guards
// ═══════════════════════════════════════

test('navigate_tree via handleRpcCommand: unknown session / missing entryId fail cleanly', async () => {
  const missing = await handleRpcCommand({ type: 'navigate_tree', sessionId: 'nope', entryId: 'a1' });
  assert.equal(missing.success, false);
  assert.match(String(missing.error), /Live session not found/);

  const file = writeTreeSession();
  const session = fakeSession(file);
  liveManager.sessions.set(session.id, session);
  try {
    const noEntry = await handleRpcCommand({ type: 'navigate_tree', sessionId: session.id });
    assert.equal(noEntry.success, false);
    assert.match(String(noEntry.error), /entryId required/);

    session.isStreaming = true;
    const streaming = await handleRpcCommand({ type: 'navigate_tree', sessionId: session.id, entryId: 'a1' });
    assert.equal(streaming.success, false);
    assert.match(String(streaming.error), /streaming/);

    session.isStreaming = false;
    const ok = await handleRpcCommand({ type: 'navigate_tree', sessionId: session.id, entryId: 'u2' });
    assert.equal(ok.success, true);
    assert.equal((ok.data as Json).editorText, 'second user message');
  } finally {
    liveManager.sessions.delete(session.id);
  }
});

test('prompts are refused while a tree navigation is in flight', async () => {
  const file = writeTreeSession();
  const session = fakeSession(file);
  const origSend = session.send.bind(session);
  session.send = async (command: Json) => {
    await new Promise((r) => setTimeout(r, 25));
    return origSend(command);
  };
  liveManager.sessions.set(session.id, session);
  try {
    const nav = navigateTree(session, 'a1');
    const prompt = await handleRpcCommand({ type: 'prompt', message: 'racing prompt', sessionId: session.id });
    assert.equal(prompt.success, false);
    assert.match(String(prompt.error), /navigation is in progress/);
    await nav;
    // The racing prompt was refused up front, never forwarded to the child.
    assert.ok(!session.sent.some((c: Json) => c.type === 'prompt'));
  } finally {
    liveManager.sessions.delete(session.id);
  }
});

// ═══════════════════════════════════════
// Real pi child: same-path switch_session reload (skipped without pi)
// ═══════════════════════════════════════

const piAvailable = (() => {
  try { return spawnSync('pi', ['--version'], { encoding: 'utf8', timeout: 15000 }).status === 0; } catch { return false; }
})();

test('same-path switch_session makes a real pi child reload the branched file', { skip: !piAvailable, timeout: 120000 }, async (t: TestContext) => {
  const file = writeTreeSession();
  const child: ChildProcess = spawn('pi', ['--mode', 'rpc', '--session', file], {
    cwd: PROJ,
    env: { ...process.env, TAU_DISABLED: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });

  const pending = new Map<string, (msg: Json) => void>();
  let buf = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: Json;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'response' && msg.id && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    }
  });
  function send(command: Json): Promise<Json> {
    const id = `t_${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${command.type}`)); }, 30000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin!.write(JSON.stringify({ ...command, id }) + '\n');
    });
  }

  // Wait for the child to accept RPC commands.
  await new Promise((r) => setTimeout(r, 1500));
  const before = await send({ type: 'get_tree' });
  assert.equal(before.success, true);

  const session = {
    id: 'live_pi',
    sessionFile: file,
    isStreaming: false,
    entries: [] as Json[],
    send,
    snapshot() { return { entries: this.entries }; },
    manager: { broadcast() {}, broadcastUpdated() {} },
  };
  const result = await navigateTree(session, 'a1');
  assert.equal(result.editorText, undefined);

  // The child's in-memory leaf now sits at/under our marker: the active
  // conversation is just the first user/assistant pair.
  const messages = await send({ type: 'get_messages' });
  assert.equal(messages.success, true);
  const texts = (messages.data.messages as Json[])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => (Array.isArray(m.content) ? m.content.filter((b: Json) => b.type === 'text').map((b: Json) => b.text).join('') : m.content));
  assert.deepEqual(texts, ['first user message', 'first assistant reply']);
});
