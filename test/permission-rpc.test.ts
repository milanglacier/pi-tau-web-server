import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type {
  ExtensionError, JsonAgentSessionEvent, RpcCommand, RpcExtensionUIRequest, RpcExtensionUIResponse, RpcResponse,
} from '@earendil-works/pi-coding-agent';
import {
  BASH_TIMEOUT_SECONDS, MODEL, PROVIDER, RECOVERY_TEXT, RUNNING_FINISHED, RUNNING_PID, RUNNING_STARTED, SENTINEL,
} from './fixtures/permission-rpc-provider.ts';

// Run directly: node --test test/permission-rpc.test.ts
// Automatically uses the sibling source checkout, never an installed npm copy.
// Elsewhere, opt in with TAU_PERMISSION_EXTENSION_DIR=/absolute/path/to/checkout.
// An absent default checkout is an explicit skip; a bad override is a failure.
const extensionDir = path.resolve(process.env.TAU_PERMISSION_EXTENSION_DIR
  ?? fileURLToPath(new URL('../../pi-minimal-permission-system/', import.meta.url)));
const extensionPath = path.join(extensionDir, 'index.ts');
const skip = process.platform === 'win32'
  ? 'This real-bash regression uses POSIX process-group cleanup.'
  : !process.env.TAU_PERMISSION_EXTENSION_DIR && !fs.existsSync(extensionPath)
    ? 'Permission source checkout absent; set TAU_PERMISSION_EXTENSION_DIR to run the real Pi RPC regression.'
    : false;
const options = { skip, timeout: 30_000 };
const COMMAND_TIMEOUT_MS = 5_000;
type Output = JsonAgentSessionEvent | RpcResponse | RpcExtensionUIRequest | (ExtensionError & { type: 'extension_error' });
type Confirmation = Extract<RpcExtensionUIRequest, { method: 'confirm' }>;

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

/** Small JSONL client, intentionally independent of Tau's dialog-cancelling fallback. */
class RealPi {
  readonly events: Output[] = [];
  readonly sent: Array<RpcCommand | RpcExtensionUIResponse> = [];
  readonly root: string;
  readonly cwd: string;
  readonly sessionDir: string;
  private child?: ChildProcessWithoutNullStreams;
  private closed = false;
  private failure?: Error;
  private stderr = '';
  private sequence = 0;
  private signal: AbortSignal;

  constructor(t: TestContext) {
    this.signal = t.signal;
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-permission-rpc-'));
    this.cwd = path.join(this.root, 'cwd');
    this.sessionDir = path.join(this.root, 'sessions');
    // Register before any setup/spawn can fail, including a missing override.
    t.after(() => this.dispose());
  }

  async start(extraArgs: string[] = []): Promise<void> {
    assert.ok(fs.existsSync(extensionPath), `Permission source index.ts not found: ${extensionPath}`);
    const agentDir = path.join(this.root, 'agent');
    const home = path.join(this.root, 'home');
    const tmp = path.join(this.root, 'tmp');
    for (const dir of [agentDir, home, tmp, this.cwd, this.sessionDir]) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
      packages: [], extensions: [], skills: [], prompts: [], themes: [],
      compaction: { enabled: false }, retry: { enabled: false }, enableInstallTelemetry: false,
    }));
    // Bash rules are regular expressions, so '.*' asks for every command
    // explicitly instead of relying on the extension's default-ask fallback.
    fs.writeFileSync(path.join(agentDir, 'permissions.jsonc'), JSON.stringify({ bash: { '.*': 'ask' } }));
    const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent/rpc-entry'));
    const provider = fileURLToPath(new URL('./fixtures/permission-rpc-provider.ts', import.meta.url));
    this.child = spawn(process.execPath, [
      entry, '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates',
      '--no-themes', '--no-context-files', '--no-approve', '--session-dir', this.sessionDir,
      '--extension', provider, '--extension', extensionPath,
      '--provider', PROVIDER, '--model', MODEL, '--thinking', 'off', '--tools', 'bash', ...extraArgs,
    ], {
      cwd: this.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      // Deliberate allowlist: no real credentials, parent Pi state, NODE_OPTIONS,
      // BASH_ENV, shell prefixes, or user settings/auth/session files are inherited.
      env: {
        PATH: process.env.PATH, HOME: home, TMPDIR: tmp, LANG: 'C.UTF-8', TERM: 'dumb',
        PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: this.sessionDir,
        PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
      },
    });
    const child = this.child;
    child.on('error', error => { this.failure = error; });
    child.stdin.on('error', error => { this.failure = error; });
    child.on('close', (code, signal) => {
      this.closed = true;
      this.failure ??= new Error(`Pi exited: code=${code}, signal=${signal}`);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-12_000); });
    child.stdout.setEncoding('utf8');
    let buffer = '';
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      // RPC is strictly LF framed; readline also splits valid JSON U+2028/U+2029.
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try { this.events.push(JSON.parse(line) as Output); }
        catch { this.failure = new Error(`Invalid Pi RPC JSONL: ${line.slice(0, 500)}`); }
      }
    });
    const state = await this.command({ type: 'get_state' }, 15_000);
    assert.equal(state.data.model?.provider, PROVIDER);
    assert.equal(state.data.model?.id, MODEL);
    assert.equal(state.data.isStreaming, false);
    assert.equal(state.data.messageCount, 0, 'must not resume an existing session');
    assert.equal(path.dirname(state.data.sessionFile!), this.sessionDir);
    const commands = await this.command({ type: 'get_commands' });
    const yolo = commands.data.commands.filter(c => c.name === 'yolo');
    assert.equal(yolo.length, 1, 'exactly one permission extension must be loaded');
    assert.equal(fs.realpathSync(yolo[0].sourceInfo.path), fs.realpathSync(extensionPath));
  }

  diagnostic(label: string): string {
    return `${label}\nExtension: ${extensionPath}\nRecent RPC output: ${JSON.stringify(this.events.slice(-12))}\nPi stderr: ${this.stderr}`;
  }

  async until<T>(label: string, read: () => T | undefined, timeoutMs = COMMAND_TIMEOUT_MS): Promise<T> {
    const deadline = performance.now() + timeoutMs;
    while (true) {
      if (this.failure) throw new Error(this.diagnostic(this.failure.message));
      const value = read();
      if (value !== undefined) return value;
      if (performance.now() >= deadline) throw new Error(this.diagnostic(`Timed out after ${timeoutMs}ms waiting for ${label}`));
      await delay(20, undefined, { signal: this.signal });
    }
  }

  write(message: RpcCommand | RpcExtensionUIResponse): void {
    assert.ok(this.child?.stdin.writable, 'Pi stdin must still be writable');
    this.sent.push(message);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async command<C extends RpcCommand>(command: C, timeoutMs = COMMAND_TIMEOUT_MS): Promise<Extract<RpcResponse, { command: C['type']; success: true }>> {
    const id = `test-${++this.sequence}`;
    this.write({ ...command, id });
    const response = await this.until(`${command.type} acknowledgement`, () =>
      this.events.find((e): e is RpcResponse => e.type === 'response' && e.id === id), timeoutMs);
    assert.equal(response.command, command.type);
    assert.ok(response.success, this.diagnostic(JSON.stringify(response)));
    return response as Extract<RpcResponse, { command: C['type']; success: true }>;
  }

  event<K extends Output['type']>(type: K, since: number): Promise<Extract<Output, { type: K }>> {
    return this.until(type, () => this.events.slice(since).find((e): e is Extract<Output, { type: K }> => e.type === type));
  }

  confirmation(since: number): Promise<Confirmation> {
    return this.until('unanswered permission confirmation', () => this.events.slice(since).find(
      (e): e is Confirmation => e.type === 'extension_ui_request' && e.method === 'confirm'));
  }

  async assertIdle(since: number): Promise<void> {
    await this.event('agent_settled', since);
    const state = await this.command({ type: 'get_state' });
    assert.equal(state.data.isStreaming, false);
    assert.equal(state.data.isCompacting, false);
    assert.equal(state.data.pendingMessageCount, 0);
    assert.equal(this.events.some(e => e.type === 'extension_error'), false, this.diagnostic('Extension error'));
  }

  async assertNewPromptWorks(): Promise<void> {
    const mark = this.events.length;
    await this.command({ type: 'prompt', message: 'permission:recovery' });
    await this.assertIdle(mark);
    const text = await this.command({ type: 'get_last_assistant_text' });
    assert.equal(text.data.text, RECOVERY_TEXT);
  }

  exists(name: string): boolean { return fs.existsSync(path.join(this.cwd, name)); }

  private async dispose(): Promise<void> {
    try {
      const child = this.child;
      if (child?.pid && !this.closed) {
        // Pi's SIGTERM handler kills tracked detached bash children even if a
        // broken extension keeps session.abort() pending. Never answer a dialog
        // here: cleanup must not accidentally make the regression pass.
        killGroup(child.pid, 'SIGTERM');
        const deadline = performance.now() + 1_000;
        while (!this.closed && performance.now() < deadline) await delay(20);
        if (!this.closed) killGroup(child.pid, 'SIGKILL');
      }
      // Also reap the fixture's bash group if Pi itself failed before cleanup.
      // Only our disposable command writes this file, never a user process.
      const pidFile = path.join(this.cwd, RUNNING_PID);
      if (fs.existsSync(pidFile)) {
        const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        assert.ok(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
        killGroup(pid, 'SIGKILL');
      }
      if (child) {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        const deadline = performance.now() + 2_000;
        while (!this.closed && performance.now() < deadline) await delay(20);
        assert.ok(this.closed, 'Pi child must be reaped within the cleanup deadline');
      }
    } finally {
      fs.rmSync(this.root, { recursive: true, force: true });
    }
  }
}

test('native Pi RPC abort releases an unanswered approval after the bash timeout without executing the command', options, async t => {
  const pi = new RealPi(t);
  await pi.start();
  const mark = pi.events.length;
  await pi.command({ type: 'prompt', message: 'permission:sentinel' });
  const confirmation = await pi.confirmation(mark);
  assert.equal(confirmation.title, 'Permission Required');
  assert.equal(confirmation.timeout, undefined, 'approval must not acquire an arbitrary deadline');
  assert.ok(confirmation.message.includes(SENTINEL));
  const tool = await pi.event('tool_execution_start', mark);
  assert.equal(tool.toolName, 'bash');
  assert.equal(tool.args.timeout, BASH_TIMEOUT_SECONDS);
  // Pi emits tool_execution_start BEFORE permission preflight. A real file,
  // rather than that event, is the execution sentinel.
  assert.equal(pi.exists(SENTINEL), false);
  await delay(BASH_TIMEOUT_SECONDS * 1000 + 250, undefined, { signal: t.signal });
  assert.equal((await pi.command({ type: 'get_state' })).data.isStreaming, true);
  assert.equal(pi.events.slice(mark).some(e => e.type === 'tool_execution_end' || e.type === 'agent_settled'), false);
  assert.equal(pi.exists(SENTINEL), false, 'bash timeout must not approve or execute a waiting command');

  // This is native RPC only. No Tau helper, synthetic abort success, or
  // extension_ui_response (not even cancelled:true) is allowed to release it.
  await pi.command({ type: 'abort' });
  await pi.assertIdle(mark);
  assert.equal(pi.exists(SENTINEL), false, 'aborting approval must never execute the command');
  await pi.assertNewPromptWorks();
  assert.equal(pi.exists(SENTINEL), false);
  assert.equal(pi.sent.some(c => c.type === 'extension_ui_response'), false);
});

for (const approved of [true, false]) {
  test(`real Pi RPC ${approved ? 'approval executes' : 'denial blocks'} the requested bash command`, options, async t => {
    const pi = new RealPi(t);
    await pi.start();
    const mark = pi.events.length;
    await pi.command({ type: 'prompt', message: 'permission:sentinel' });
    const confirmation = await pi.confirmation(mark);
    assert.equal(pi.exists(SENTINEL), false);
    pi.write({ type: 'extension_ui_response', id: confirmation.id, confirmed: approved });
    await pi.assertIdle(mark);
    const result = await pi.event('tool_execution_end', mark);
    assert.equal(result.toolName, 'bash');
    assert.equal(result.isError, !approved);
    assert.equal(pi.exists(SENTINEL), approved);
    if (approved) assert.equal(fs.readFileSync(path.join(pi.cwd, SENTINEL), 'utf8'), 'executed\n');
    else assert.match(JSON.stringify(result.result), /User denied bash command/);
    await pi.assertNewPromptWorks();
  });
}

test('YOLO enabled before preflight bypasses the real permission confirmation', options, async t => {
  const pi = new RealPi(t);
  await pi.start(['--yolo']);
  const mark = pi.events.length;
  await pi.command({ type: 'prompt', message: 'permission:sentinel' });
  await pi.assertIdle(mark);
  assert.equal(pi.exists(SENTINEL), true);
  assert.equal((await pi.event('tool_execution_end', mark)).isError, false);
  assert.equal(pi.events.slice(mark).some(e => e.type === 'extension_ui_request' && e.method === 'confirm'), false);
  assert.equal(pi.sent.some(c => c.type === 'extension_ui_response'), false);
});

test('enabling YOLO after a confirmation is pending does not approve it or replace native abort', options, async t => {
  const pi = new RealPi(t);
  await pi.start();
  const mark = pi.events.length;
  await pi.command({ type: 'prompt', message: 'permission:sentinel' });
  await pi.confirmation(mark);
  await pi.command({ type: 'prompt', message: '/yolo' });
  assert.ok(pi.events.some(e => e.type === 'extension_ui_request' && e.method === 'notify' && e.message === 'YOLO mode enabled'));
  await delay(150, undefined, { signal: t.signal });
  assert.equal((await pi.command({ type: 'get_state' })).data.isStreaming, true);
  assert.equal(pi.exists(SENTINEL), false);
  await pi.command({ type: 'abort' });
  await pi.assertIdle(mark);
  await pi.assertNewPromptWorks();
  assert.equal(pi.exists(SENTINEL), false);
  assert.equal(pi.sent.some(c => c.type === 'extension_ui_response'), false);
});

test('native Pi RPC abort still stops an approved bash command that is already running', options, async t => {
  const pi = new RealPi(t);
  await pi.start();
  const mark = pi.events.length;
  await pi.command({ type: 'prompt', message: 'permission:running' });
  const confirmation = await pi.confirmation(mark);
  assert.equal(pi.exists(RUNNING_STARTED), false);
  pi.write({ type: 'extension_ui_response', id: confirmation.id, confirmed: true });
  await pi.until('running bash output', () => pi.events.slice(mark).find(e =>
    e.type === 'tool_execution_update' && JSON.stringify(e.partialResult).includes('bash is running')));
  assert.equal(pi.exists(RUNNING_STARTED), true);
  assert.equal(pi.exists(RUNNING_FINISHED), false);
  const pid = Number(fs.readFileSync(path.join(pi.cwd, RUNNING_PID), 'utf8').trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 1);

  // The command sleeps for 30s with a 35s tool timeout; the real abort must
  // acknowledge within 5s, so neither normal completion nor timeout can pass.
  await pi.command({ type: 'abort' });
  await pi.assertIdle(mark);
  const result = await pi.event('tool_execution_end', mark);
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.result), /Command aborted/);
  assert.equal(pi.exists(RUNNING_FINISHED), false);
  await pi.until('bash process exit', () => {
    try { process.kill(pid, 0); return undefined; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      throw error;
    }
  });
  await pi.assertNewPromptWorks();
  assert.equal(pi.exists(RUNNING_FINISHED), false);
  assert.equal(pi.sent.filter(c => c.type === 'extension_ui_response').length, 1, 'only the explicit approval was sent');
});
