import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import type { TestContext } from 'node:test';
import type { WebSocket as WsWebSocket } from 'ws';
import { WebSocketClient } from '../public/websocket-client.js';

// Loopback + isolated settings tree.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-ws-'));
process.env.TAU_HOST = '127.0.0.1';
process.env.PI_CODING_AGENT_DIR = TMP;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(TMP, 'sessions');
fs.mkdirSync(process.env.PI_CODING_AGENT_SESSION_DIR, { recursive: true });

// Load the server after the env + settings are in place: the module reads
// them at load time, and ESM hoists static imports ahead of this body.
const { server, computeUrls, liveManager, PiRpcSession, _setAuthForTest } = (await import('../bin/tau.js')) as any;

let base = '';
let wsUrl = '';

interface FakeWsSession {
  id: string;
  cwd: string;
  model: string;
  modelSpec: string;
  thinkingLevel: string;
  isStreaming: boolean;
  sessionFile: string;
  sessionName: string | null;
  contextUsage: { tokens?: number } | null;
  metadata: () => { id: string; cwd: string; model: string; isStreaming: boolean };
  snapshot: () => { session: { id: string }; entries: unknown[]; model: string; isStreaming: boolean };
  terminate: () => Promise<void>;
}

function fakeSession(id: string): FakeWsSession {
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
    metadata: () => ({ id, cwd: '/tmp/proj', model: 'openai/gpt-5.5', isStreaming: false }),
    snapshot: () => ({ session: { id }, entries: [], model: 'openai/gpt-5.5', isStreaming: false }),
    terminate: async () => {},
  };
}

before(async () => {
  _setAuthForTest(false);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      computeUrls(port);
      base = `http://127.0.0.1:${port}`;
      wsUrl = `ws://127.0.0.1:${port}/ws`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  liveManager.sessions.clear();
});

function connect(opts: any = {}) {
  const headers = opts.headers || {};
  if (opts.origin !== null) headers.Origin = opts.origin ?? base;
  headers.Host = new URL(base).host;
  const ws = new WebSocket(wsUrl, { headers, ...opts });
  return ws;
}

function nextMessage(ws: WsWebSocket, timeout = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for WS message')), timeout);
    ws.once('message', (data: Buffer) => { clearTimeout(timer); resolve(JSON.parse(data.toString())); });
    ws.once('error', (e: Error) => { clearTimeout(timer); reject(e); });
  });
}

test('the browser transport dispatches authoritative interaction state without treating it as an RPC event', () => {
  const client = new WebSocketClient('ws://127.0.0.1/unused');
  const message = { type: 'interaction_state', sessionId: 'live', interactionRevision: 3, pendingDialogs: [] };
  let received: unknown;
  let rpcEvents = 0;
  client.addEventListener('interactionState', event => { received = (event as CustomEvent).detail; });
  client.addEventListener('rpcEvent', () => { rpcEvents++; });
  client.handleMessage(message);
  assert.deepEqual(received, message);
  assert.equal(rpcEvents, 0);
});

test('cross-origin WebSocket upgrade is rejected', async () => {
  const ws = connect({ origin: 'http://evil.example' });
  // ws client does not surface the HTTP status on the error event, so we
  // only assert that the upgrade does not succeed.
  await assert.rejects(
    () => new Promise((_, reject) => {
      ws.on('error', reject);
      ws.on('open', () => reject(new Error('cross-origin upgrade should not succeed')));
    }),
  );
  try { ws.close(); } catch {}
});

test('same-origin WebSocket upgrade receives the initial live-session state', async () => {
  liveManager.sessions.set('tau_1', fakeSession('tau_1'));
  const ws = connect();
  const msg = await nextMessage(ws);
  assert.equal(msg.type, 'state');
  assert.equal(msg.liveSessions.length, 1);
  assert.equal(msg.liveSessions[0].id, 'tau_1');
  ws.close();
});

test('RPC commands over WebSocket are handled and respond', async () => {
  const ws = connect();
  await nextMessage(ws); // swallow initial state
  ws.send(JSON.stringify({ type: 'get_auth' }));
  const resp = await nextMessage(ws);
  assert.equal(resp.type, 'response');
  assert.equal(resp.success, true);
  assert.equal(resp.data.configured, false);
  ws.close();
});

test('WebSocket disconnect does not terminate backend live sessions', async () => {
  const s = fakeSession('tau_1');
  let terminated = false;
  s.terminate = async () => { terminated = true; };
  liveManager.sessions.set('tau_1', s);
  const ws = connect();
  await nextMessage(ws);
  // close the browser-side connection and wait for the server to process it
  await new Promise((resolve) => {
    ws.on('close', resolve);
    ws.close();
  });
  // give the server a tick to run its close handler
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(terminated, false, 'disconnecting a client must not terminate child sessions');
  assert.equal(liveManager.sessions.has('tau_1'), true);
  assert.equal(liveManager.clients.size, 0);
});

test('a new browser recovers an unanswered dialog and both clients observe its first resolution', async (t) => {
  const session = new PiRpcSession(liveManager, { cwd: '/tmp' });
  const writes: Record<string, unknown>[] = [];
  session.child = { stdin: { writable: true, write(data: string, cb: () => void) { writes.push(JSON.parse(data)); cb(); } } };
  liveManager.sessions.set(session.id, session);
  session.handleEvent({ type: 'extension_ui_request', id: 'offline-request', method: 'confirm', title: 'Permission Required', timeout: 10000 });
  const ws1 = connect();
  const seen1: any[] = [];
  ws1.on('message', data => seen1.push(JSON.parse(data.toString())));
  const initial1 = await nextMessage(ws1);
  assert.equal(initial1.liveSessions[0].pendingInteractionCount, 1);
  const ws2 = connect();
  const seen2: any[] = [];
  ws2.on('message', data => seen2.push(JSON.parse(data.toString())));
  await nextMessage(ws2);
  t.after(() => { ws1.close(); ws2.close(); session.handleExit(0, null); });
  async function waitFor(messages: any[], predicate: (message: any) => boolean) {
    const deadline = Date.now() + 2000;
    while (!messages.some(predicate)) {
      assert.ok(Date.now() < deadline, 'timed out waiting for dialog state');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return messages.find(predicate);
  }
  for (const ws of [ws1, ws2]) ws.send(JSON.stringify({ type: 'live_session_snapshot_request', sessionId: session.id }));
  const snap1 = await waitFor(seen1, msg => msg.type === 'live_session_snapshot');
  const snap2 = await waitFor(seen2, msg => msg.type === 'live_session_snapshot');
  assert.deepEqual(snap1.pendingDialogs, snap2.pendingDialogs);
  assert.equal(snap1.pendingDialogs[0].id, 'offline-request');
  ws1.send(JSON.stringify({ type: 'extension_ui_response', sessionId: session.id, id: 'offline-request', confirmed: false }));
  const resolved = (msg: any) => msg.type === 'interaction_state' && msg.pendingDialogs.length === 0;
  const state1 = await waitFor(seen1, resolved);
  const state2 = await waitFor(seen2, resolved);
  assert.equal(state1.interactionRevision, state2.interactionRevision);
  assert.ok(state1.interactionRevision > snap1.interactionRevision);
  ws2.send(JSON.stringify({ type: 'extension_ui_response', sessionId: session.id, id: 'offline-request', confirmed: true }));
  await waitFor(seen2, msg => msg.type === 'response' && msg.success === false && msg.id === 'offline-request');
  assert.deepEqual(writes, [{ type: 'extension_ui_response', id: 'offline-request', confirmed: false }]);
  assert.equal(session.pending.size, 0);
});

test('manager broadcasts are delivered to connected WS clients', async () => {
  const ws = connect();
  await nextMessage(ws);
  // exercise the same broadcast path the manager uses on create()
  liveManager.broadcast({ type: 'live_session_created', session: fakeSession('tau_new').metadata() });
  const msg = await nextMessage(ws);
  assert.equal(msg.type, 'live_session_created');
  assert.equal(msg.session.id, 'tau_new');
  ws.close();
});
