import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { TestContext } from 'node:test';

// Point TAU_PI_COMMAND at a fake Pi script before the server module loads,
// because the module reads the command once at load time.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-pi-command-'));
const FAKE_PI = path.join(TMP, 'fake-pi');
fs.writeFileSync(FAKE_PI, `#!/bin/sh
if [ "$1" = "--list-models" ]; then
  echo "provider      model          context  max-out  thinking  images"
  echo "fake          fake-model     128K     16K      yes       no"
  exit 0
fi
if [ "$1" = "--export" ]; then
  out="\${3:-\${2%.jsonl}.html}"
  echo "<html></html>" > "$out"
  echo "$out"
  exit 0
fi
exit 1
`, { mode: 0o755 });
process.env.PI_CODING_AGENT_DIR = TMP;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(TMP, 'sessions');
process.env.TAU_PI_COMMAND = FAKE_PI;

const {
  PI_COMMAND,
  LiveSessionManager,
  handleRpcCommand,
  SESSIONS_DIR,
  _setSpawnPiForTest,
  _clearModelListCacheForTest,
} = (await import('../bin/tau.js')) as any;

const SESSION_FILE = path.join(SESSIONS_DIR, '--tmp--proj', 's.jsonl');

before(() => {
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ type: 'session', id: 's' }) + '\n');
});
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('TAU_PI_COMMAND sets the Pi command', () => {
  assert.equal(PI_COMMAND, FAKE_PI);
});

test('live sessions spawn the configured Pi command', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const spawned: string[] = [];
  _setSpawnPiForTest((cmd: string) => {
    spawned.push(cmd);
    const child: any = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 55555;
    child.kill = () => {};
    return child;
  });
  t.after(() => _setSpawnPiForTest(null));
  const mgr = new LiveSessionManager();
  const createP = mgr.create({ cwd: TMP });
  t.mock.timers.tick(100);
  await createP;
  assert.deepEqual(spawned, [FAKE_PI]);
});

test('a missing Pi command fails with a message that names it', async (t: TestContext) => {
  _setSpawnPiForTest(() => {
    const child: any = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    setImmediate(() => child.emit('error', Object.assign(new Error(`spawn ${FAKE_PI} ENOENT`), { code: 'ENOENT' })));
    return child;
  });
  t.after(() => _setSpawnPiForTest(null));
  const mgr = new LiveSessionManager();
  await assert.rejects(mgr.create({ cwd: TMP }), (err: Error) => {
    assert.match(err.message, /was not found/);
    assert.ok(err.message.includes(FAKE_PI));
    return true;
  });
});

test('the model list comes from the configured Pi command', async () => {
  _clearModelListCacheForTest();
  const resp = await handleRpcCommand({ type: 'get_available_models' });
  assert.equal(resp.success, true);
  assert.deepEqual(resp.data.models, [
    { provider: 'fake', id: 'fake-model', context: '128K', maxOutput: '16K', thinking: true, images: false },
  ]);
});

test('HTML export runs the configured Pi command', async () => {
  const resp = await handleRpcCommand({ type: 'export_html', filePath: SESSION_FILE });
  assert.equal(resp.success, true);
  assert.equal(resp.data.path, SESSION_FILE.replace(/\.jsonl$/, '.html'));
  assert.ok(fs.existsSync(resp.data.path));
});
