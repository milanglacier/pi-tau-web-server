const { test, beforeEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Isolate settings + sessions in a temp tree, and configure auth credentials
// so set_auth can succeed. Env must be set before requiring the module.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-rpc-'));
process.env.PI_CODING_AGENT_DIR = TMP;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(TMP, 'sessions');
process.env.TAU_USER = 'admin';
process.env.TAU_PASS = 's3cret';

const {
  handleRpcCommand,
  liveManager,
  appendSessionName,
  parsePiListModels,
  _setAuthForTest,
  _setExecFileForTest,
  SESSIONS_DIR,
} = require('../bin/tau.js');

interface RpcTestSession {
  id: string;
  cwd: string;
  model: string;
  modelSpec: string;
  thinkingLevel: string;
  isStreaming: boolean;
  sessionFile: string;
  sessionName: string | null;
  titleSet: boolean;
  entries: Array<Record<string, unknown>>;
  contextUsage: { tokens?: number; usage?: { input_tokens: number; output_tokens: number } } | null;
  metadata: () => Record<string, unknown>;
  snapshot: () => Record<string, unknown>;
  send: (cmd: { id?: string; type?: string; [k: string]: unknown }) =>
    Promise<{ type: string; id?: string; success: boolean; data: Record<string, unknown>; error?: string }>;
}

const PROJ = path.join(SESSIONS_DIR, '--tmp--proj');
const SESSION_FILE = path.join(PROJ, 's.jsonl');

before(() => {
  fs.mkdirSync(PROJ, { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ type: 'session', id: 's' }) + '\n');
});
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  liveManager.sessions.clear();
  _setAuthForTest(true);
  _setExecFileForTest(null);
});

function injectSession(overrides: Partial<RpcTestSession> = {}): RpcTestSession {
  const session: RpcTestSession = {
    id: 'tau_test',
    cwd: '/tmp/proj',
    model: 'openai/gpt-5.5',
    modelSpec: '',
    thinkingLevel: 'off',
    isStreaming: false,
    sessionFile: SESSION_FILE,
    sessionName: null,
    titleSet: false,
    entries: [{ type: 'message', message: { role: 'user', content: 'hi' } }],
    contextUsage: null,
    metadata: () => ({
      id: session.id, cwd: session.cwd, model: session.model, modelSpec: session.modelSpec,
      modelLabel: session.model, thinkingLevel: session.thinkingLevel, isStreaming: session.isStreaming,
      sessionFile: session.sessionFile, sessionName: session.sessionName, contextUsage: session.contextUsage,
    }),
    snapshot: () => ({
      session: { id: session.id },
      entries: session.entries,
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      sessionFile: session.sessionFile,
      sessionName: session.sessionName,
      contextUsage: null,
    }),
    send: async (cmd) => ({ type: 'response', id: cmd.id, success: true, data: {} }),
    ...overrides,
  };
  liveManager.sessions.set(session.id, session);
  return session;
}

test('get_auth reports configured + enabled state', async () => {
  _setAuthForTest(false);
  let resp = await handleRpcCommand({ type: 'get_auth' });
  assert.equal(resp.success, true);
  assert.equal(resp.data.configured, true);
  assert.equal(resp.data.enabled, false);
  _setAuthForTest(true);
  resp = await handleRpcCommand({ type: 'get_auth' });
  assert.equal(resp.data.enabled, true);
});

test('set_auth toggles the enabled flag when credentials are configured', async () => {
  const resp = await handleRpcCommand({ type: 'set_auth', enabled: false });
  assert.equal(resp.success, true);
  assert.equal(resp.data.enabled, false);
  // toggling back on
  const resp2 = await handleRpcCommand({ type: 'set_auth', enabled: true });
  assert.equal(resp2.data.enabled, true);
});

test('parsePiListModels preserves slashful model ids from pi table output', () => {
  const out = parsePiListModels(`provider      model                                               context  max-out  thinking  images
anthropic     claude-opus-4-5                                     200K     64K      yes       yes
fireworks     accounts/fireworks/models/deepseek-v4-flash         1M       384K     yes       no
`);
  assert.deepEqual(out, [
    { provider: 'anthropic', id: 'claude-opus-4-5', context: '200K', maxOutput: '64K', thinking: true, images: true },
    { provider: 'fireworks', id: 'accounts/fireworks/models/deepseek-v4-flash', context: '1M', maxOutput: '384K', thinking: true, images: false },
  ]);
});

test('get_available_models returns parsed pi model list', async () => {
  _setExecFileForTest((file: string, args: string[], opts: object, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    assert.equal(file, 'pi');
    assert.deepEqual(args, ['--list-models']);
    cb(null, `provider      model                                               context  max-out  thinking  images
openrouter    z-ai/glm-5.2                                        128K     16K      yes       no
`, '');
  });
  const resp = await handleRpcCommand({ type: 'get_available_models' });
  assert.equal(resp.success, true);
  assert.deepEqual(resp.data.models, [
    { provider: 'openrouter', id: 'z-ai/glm-5.2', context: '128K', maxOutput: '16K', thinking: true, images: false },
  ]);
});

test('set_session_name with filePath appends a session_info record', async () => {
  const resp = await handleRpcCommand({ type: 'set_session_name', filePath: SESSION_FILE, name: 'Plan' });
  assert.equal(resp.success, true);
  assert.equal(resp.data.name, 'Plan');
  const lines = fs.readFileSync(SESSION_FILE, 'utf8').trim().split('\n');
  assert.equal(JSON.parse(lines[lines.length - 1]).name, 'Plan');
});

test('set_session_name rejects empty names and invalid file paths', async () => {
  const empty = await handleRpcCommand({ type: 'set_session_name', filePath: SESSION_FILE, name: '   ' });
  assert.equal(empty.success, false);
  assert.match(empty.error, /Name cannot be empty/);
  const bad = await handleRpcCommand({ type: 'set_session_name', filePath: '/etc/hosts', name: 'x' });
  assert.equal(bad.success, false);
  assert.match(bad.error, /Invalid session file/);
});

test('set_session_name with sessionId updates the matching live session', async () => {
  const session = injectSession();
  const resp = await handleRpcCommand({ type: 'set_session_name', sessionId: session.id, name: 'Live title' });
  assert.equal(resp.success, true);
  assert.equal(session.sessionName, 'Live title');
  assert.equal(session.titleSet, true);
});

test('set_session_name with a filePath matching a live session updates that session without a sessionId', async () => {
  const session = injectSession();
  const resp = await handleRpcCommand({ type: 'set_session_name', filePath: session.sessionFile, name: 'From file' });
  assert.equal(resp.success, true);
  // the matchingLive branch finds the live session by sessionFile and updates it
  assert.equal(session.sessionName, 'From file');
  assert.equal(session.titleSet, true);
});

test('set_session_name rejects when neither sessionId nor filePath is provided', async () => {
  const resp = await handleRpcCommand({ type: 'set_session_name', name: 'Orphan' });
  assert.equal(resp.success, false);
  assert.match(resp.error, /sessionId or filePath required/);
});

test('get_state returns cached backend state for the session', async () => {
  const session = injectSession({ model: 'anthropic/claude', thinkingLevel: 'high', isStreaming: true });
  const resp = await handleRpcCommand({ type: 'get_state', sessionId: session.id });
  assert.equal(resp.success, true);
  assert.equal(resp.data.model, 'anthropic/claude');
  assert.equal(resp.data.thinkingLevel, 'high');
  assert.equal(resp.data.isStreaming, true);
  assert.equal(resp.data.sessionFile, SESSION_FILE);
});

test('get_messages returns cached entries', async () => {
  const session = injectSession();
  const resp = await handleRpcCommand({ type: 'get_messages', sessionId: session.id });
  assert.equal(resp.success, true);
  assert.equal(resp.data.entries.length, 1);
});

test('live_session_snapshot_request returns a live_session_snapshot payload', async () => {
  const session = injectSession();
  const resp = await handleRpcCommand({ type: 'live_session_snapshot_request', sessionId: session.id });
  assert.equal(resp.type, 'live_session_snapshot');
  assert.equal(resp.sessionId, session.id);
  assert.deepEqual(resp.entries, session.entries);
});

test('set_auto_compaction echoes the enabled flag without persisting state', async () => {
  // current implementation gates this behind the active-session check
  const session = injectSession();
  const resp = await handleRpcCommand({ type: 'set_auto_compaction', sessionId: session.id, enabled: false });
  assert.equal(resp.success, true);
  assert.equal(resp.data.enabled, false);
  // the echo persists nothing: get_state still reports the hardcoded default
  const state = await handleRpcCommand({ type: 'get_state', sessionId: session.id });
  assert.equal(state.data.autoCompactionEnabled, true);
});

test('native commands require an active live session', async () => {
  const resp = await handleRpcCommand({ type: 'prompt', message: 'hi' });
  assert.equal(resp.success, false);
  assert.match(resp.error, /No active Tau session/);
});

test('unknown command is rejected', async () => {
  const session = injectSession();
  const resp = await handleRpcCommand({ type: 'bogus', sessionId: session.id });
  assert.equal(resp.success, false);
  assert.match(resp.error, /Unknown command: bogus/);
});

test('native commands are proxied to the child and success is preserved', async () => {
  const session = injectSession({
    send: async (cmd) => ({ type: 'response', id: cmd.id, success: true, data: { ok: 1 } }),
  });
  const resp = await handleRpcCommand({ type: 'prompt', sessionId: session.id, message: 'hi' });
  assert.equal(resp.success, true);
  assert.equal(resp.data.ok, 1);
});

test('ack timeouts for prompt/abort/extension_ui_response are converted to success', async () => {
  const session = injectSession({
    send: async () => { const e = new Error('RPC command timed out: prompt'); throw e; },
  });
  for (const type of ['prompt', 'abort', 'extension_ui_response']) {
    const resp = await handleRpcCommand({ type, sessionId: session.id });
    assert.equal(resp.success, true, `${type} timeout should be treated as success`);
  }
});

test('immediate send failures are reported as errors, not swallowed', async () => {
  const session = injectSession({
    send: async () => { throw new Error('Pi RPC session is not running'); },
  });
  const resp = await handleRpcCommand({ type: 'prompt', sessionId: session.id, message: 'hi' });
  assert.equal(resp.success, false);
  assert.match(resp.error, /not running/);
});

test('export_html rejects an invalid session file path', async () => {
  const resp = await handleRpcCommand({ type: 'export_html', filePath: '/etc/hosts' });
  assert.equal(resp.success, false);
  assert.match(resp.error, /Invalid session file/);
});

test('export_html rejects a sessionId that does not resolve to a live session', async () => {
  const resp = await handleRpcCommand({ type: 'export_html', sessionId: 'tau_missing' });
  assert.equal(resp.success, false);
  assert.match(resp.error, /Live session not found/);
});

test('export_html rejects an outputPath outside the session directory before invoking pi', async () => {
  const resp = await handleRpcCommand({
    type: 'export_html',
    filePath: SESSION_FILE,
    outputPath: '/tmp/escaped.html',
  });
  assert.equal(resp.success, false);
  assert.match(resp.error, /session directory/);
});

test('set_auth persists the enabled flag to settings.json', async () => {
  await handleRpcCommand({ type: 'set_auth', enabled: true });
  const settingsPath = path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json');
  const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(parsed.tau.authEnabled, true);
});
