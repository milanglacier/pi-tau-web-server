import { test, before, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';

// The real browser and Tau server, with only Pi replaced at its stdio boundary.
// Snapshot overrides below exercise delayed/stale network deliveries without
// reaching into the browser's state or dialog implementation.
//
// Despite the filename, nothing here depends on the permission extension. These
// are Tau's own dialog-recovery tests: that a request arriving before a browser
// connects is restored from the snapshot, that it reaches a second browser, and
// that Abort cancels it. Every request below is emitted by hand from a fake Pi
// child, and titles like 'Permission required' are only a representative label
// for any extension dialog. The behaviour is generic across confirm, select,
// input and editor, so these tests keep passing with no permission extension
// installed at all. The real extension is exercised only in
// test/permission-rpc.test.ts, which explains that split in its own header.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-permission-e2e-'));
process.env.TAU_HOST = '127.0.0.1';
process.env.PI_CODING_AGENT_DIR = tmp;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(tmp, 'sessions');
process.env.TAU_PROJECTS_DIR = path.join(tmp, 'projects');
const { server, computeUrls, liveManager, _setSpawnPiForTest, _setExecFileForTest } = (await import('../../bin/tau.js')) as any;

type Command = { type: string; id?: string; [key: string]: unknown };
type PendingDialog = Command & { method: string; createdAt: number; expiresAt?: number };
let base = '';
let browser: Browser | null = null;
let browserUnavailable = '';
let spawnedChild: ReturnType<typeof makeFakeChild>;

function makeFakeChild() {
  const child: any = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12345;
  child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); };
  const commands: Command[] = [];
  const emit = (event: object) => child.stdout.write(`${JSON.stringify(event)}\n`);
  let buffer = '';
  child.stdin.on('data', (data: Buffer) => {
    buffer += data.toString();
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const command = JSON.parse(buffer.slice(0, end)) as Command;
      buffer = buffer.slice(end + 1);
      commands.push(command);
      child.emit('command', command);
      if (command.type === 'get_state' || command.type === 'get_session_stats' || command.type === 'get_available_models') {
        queueMicrotask(() => emit({
          type: 'response', id: command.id, command: command.type, success: true,
          data: command.type === 'get_state' ? { isStreaming: false, isCompacting: false, thinkingLevel: 'off' } : {},
        }));
      }
    }
  });
  const nextCommand = (type: string): Promise<Command> => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.off('command', listener); reject(new Error(`No ${type} command reached Pi`)); }, 5000);
    const listener = (command: Command) => {
      if (command.type !== type) return;
      clearTimeout(timeout);
      child.off('command', listener);
      resolve(command);
    };
    child.on('command', listener);
  });
  return { child, commands, emit, nextCommand };
}

before(async () => {
  fs.mkdirSync(process.env.PI_CODING_AGENT_SESSION_DIR!, { recursive: true });
  _setSpawnPiForTest(() => {
    spawnedChild = makeFakeChild();
    return spawnedChild.child;
  });
  _setExecFileForTest((_file: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string, stderr: string) => void) => cb(null, '', ''));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    computeUrls(port);
    base = `http://127.0.0.1:${port}`;
    resolve();
  }));
  try {
    browser = await chromium.launch();
  } catch (e) {
    browserUnavailable = `Playwright browser unavailable (${(e as Error).message.split('\n')[0]}). Run via: npm run test:e2e`;
  }
});

after(async () => {
  if (browser) await browser.close();
  await liveManager.shutdown();
  _setSpawnPiForTest(null);
  _setExecFileForTest(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

function skipUnlessBrowser(t: TestContext) {
  if (browser) return false;
  t.skip(browserUnavailable);
  return true;
}

async function createSession(t: TestContext) {
  const response = await fetch(`${base}/api/live-sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd: tmp }),
  });
  assert.equal(response.status, 200);
  const { session } = await response.json() as { session: { id: string } };
  const fake = spawnedChild;
  t.after(async () => { await fetch(`${base}/api/live-sessions/${session.id}`, { method: 'DELETE' }); });
  return { sessionId: session.id, ...fake };
}

async function openPage(t: TestContext, sessionId: string, snapshot?: object) {
  const context = await browser!.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  await context.addInitScript((id) => localStorage.setItem('tau-active-live-session-id', id), sessionId);
  const page = await context.newPage();
  await page.clock.install();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'browser must not throw'));
  if (snapshot) {
    await page.route(`**/api/live-sessions/${sessionId}/snapshot`, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), ...snapshot } });
    });
  }
  const snapshotResponse = page.waitForResponse((response) => response.url().endsWith(`/api/live-sessions/${sessionId}/snapshot`));
  await page.goto(base);
  await (await snapshotResponse).finished();
  await page.waitForSelector(`.live-tab.active[data-session-id="${sessionId}"]`);
  await page.waitForSelector('#message-input:not([disabled])');
  return page;
}

function confirmRequest(id: string, extra: Partial<PendingDialog> = {}): PendingDialog {
  return { type: 'extension_ui_request', id, method: 'confirm', title: 'Permission required', message: 'Allow the disposable tool?', createdAt: Date.now(), ...extra };
}

async function expectDialog(page: Page, title = 'Permission required') {
  await page.waitForFunction((text) => document.querySelector('#dialog-container:not(.hidden) .dialog-title')?.textContent === text, title, { timeout: 5000 });
}

test('a snapshot restores a permission request that arrived before the browser connected', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, emit } = await createSession(t);
  emit(confirmRequest('before-connect'));
  const page = await openPage(t, sessionId);
  await expectDialog(page);
  await page.reload();
  await expectDialog(page);
});

test('a resolved dialog stays dismissed when an older snapshot arrives and sends no cancellation', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, commands } = await createSession(t);
  const staleSnapshot = { pendingDialogs: [confirmRequest('resolved')], interactionRevision: 1 };
  const page = await openPage(t, sessionId, staleSnapshot);
  await expectDialog(page);

  liveManager.broadcast({ type: 'live_session_snapshot', sessionId, pendingDialogs: [], interactionRevision: 2 });
  await page.waitForSelector('#dialog-container.hidden', { state: 'attached' });
  liveManager.broadcast({ type: 'live_session_snapshot', sessionId, ...staleSnapshot });
  // Observe the stale snapshot after it has traversed the WebSocket, rather
  // than relying on an arbitrary sleep to prove that no modal returned.
  await page.waitForFunction(() => document.querySelector('#dialog-container')?.classList.contains('hidden'));
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.equal(await page.locator('#dialog-container').isVisible(), false);
  assert.deepEqual(commands.filter((command) => command.type === 'extension_ui_response'), []);
});

test('approval status and the tab count come from metadata even when no tool is streaming', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, emit } = await createSession(t);
  const page = await openPage(t, sessionId);
  // Keep the real registry consistent with metadata so startup state/stats
  // probes cannot legitimately overwrite a synthetic count with zero.
  emit(confirmRequest('idle-first'));
  emit(confirmRequest('idle-second'));
  await page.waitForFunction(() => document.querySelector('.live-tab.active .live-tab-ui-dot')?.textContent === '2');
  assert.equal(await page.locator('#status-text').textContent(), 'Waiting for approval');
  assert.equal(await page.locator(`.live-tab[data-session-id="${sessionId}"] .live-tab-ui-dot`).textContent(), '2');
  assert.equal(await page.locator('#typing-indicator').isVisible(), false);
  assert.equal(await page.locator('#abort-btn').isVisible(), true, 'an idle extension dialog must still be abortable');
});

test('switching tabs preserves the original approval deadline and never sends cancellation', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, commands } = await createSession(t);
  const other = await createSession(t);
  const page = await openPage(t, sessionId, {
    pendingDialogs: [confirmRequest('deadline', { timeout: 60000, expiresAt: Date.now() + 3000 })], interactionRevision: 1,
  });
  await expectDialog(page);
  await page.click(`.live-tab[data-session-id="${other.sessionId}"]`);
  await page.waitForSelector('#dialog-container.hidden', { state: 'attached' });
  await page.clock.runFor(4000);
  const response = page.waitForResponse((res) => res.url().endsWith(`/api/live-sessions/${sessionId}/snapshot`));
  await page.click(`.live-tab[data-session-id="${sessionId}"]`);
  await response;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.equal(await page.locator('#dialog-container').isVisible(), false, 'an expired request must not get a fresh timeout on tab return');
  assert.deepEqual(commands.filter((command) => command.type === 'extension_ui_response'), []);
});

test('the first browser reply dismisses the same request in every browser without extra replies', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, commands, emit } = await createSession(t);
  const first = await openPage(t, sessionId);
  const second = await openPage(t, sessionId);
  emit(confirmRequest('two-browsers'));
  await Promise.all([expectDialog(first), expectDialog(second)]);
  await first.click('#dialog-yes');
  await Promise.all([
    first.waitForSelector('#dialog-container.hidden', { state: 'attached' }),
    second.waitForSelector('#dialog-container.hidden', { state: 'attached' }),
  ]);
  assert.deepEqual(commands.filter((command) => command.type === 'extension_ui_response'), [
    { type: 'extension_ui_response', id: 'two-browsers', confirmed: true },
  ]);
});

test('a delivery acknowledgement cannot resolve a dialog or let the browser submit it twice', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId } = await createSession(t);
  const page = await openPage(t, sessionId, {
    pendingDialogs: [confirmRequest('delivery-only')], interactionRevision: 1,
  });
  await page.route('**/api/rpc', async (route) => {
    const command = route.request().postDataJSON();
    if (command.type !== 'extension_ui_response') return route.continue();
    await route.fulfill({ json: { type: 'response', command: command.type, id: command.id, success: true, data: { delivered: true } } });
  });
  await expectDialog(page);
  await page.click('#dialog-yes');
  await page.waitForSelector('#dialog-yes:disabled');
  assert.equal(await page.locator('#dialog-container').isVisible(), true, 'only registry resolution may dismiss the pending interaction');
  await page.waitForFunction(() => document.querySelector('.dialog-response-notice[role="status"]')?.textContent?.startsWith('Response sent.'));
  assert.equal(await page.locator('.dialog-response-error').count(), 0, 'a delivered reply is not an error');

  liveManager.broadcast({ type: 'live_session_snapshot', sessionId, pendingDialogs: [], interactionRevision: 2 });
  await page.waitForSelector('#dialog-container.hidden', { state: 'attached' });
});

test('queued instructions wait through turn_end and agent_end until agent_settled', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, commands, emit } = await createSession(t);
  const page = await openPage(t, sessionId);
  emit({ type: 'agent_start' });
  await page.waitForSelector('#abort-btn:not(.hidden)');
  await page.fill('#message-input', 'after the entire operation');
  await page.press('#message-input', 'Enter');
  await page.waitForSelector('.queued-msg');
  emit({ type: 'turn_end' });
  emit({ type: 'agent_end', willRetry: false });
  emit({ type: 'extension_ui_request', method: 'notify', message: 'post-turn work still running' });
  await page.waitForFunction(() => document.getElementById('messages')?.textContent?.includes('post-turn work still running'));
  assert.deepEqual(commands.filter(command => command.type === 'prompt'), []);
  assert.equal(await page.locator('.queued-msg').count(), 1);
  emit({ type: 'agent_settled' });
  await page.waitForSelector('#queued-messages.hidden', { state: 'attached' });
  assert.equal(commands.find(command => command.type === 'prompt')?.message, 'after the entire operation');
});

for (const control of ['button', 'keyboard']) {
  test(`${control} Abort shows Stopping until Pi acknowledges and coalesces repeated requests`, async (t) => {
    if (skipUnlessBrowser(t)) return;
    const { sessionId, commands, emit, nextCommand } = await createSession(t);
    const page = await openPage(t, sessionId);
    emit({ type: 'agent_start' });
    await page.waitForSelector('#abort-btn:not(.hidden)');
    const abort = nextCommand('abort');
    if (control === 'button') await page.click('#abort-btn');
    else await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'Stopping…');
    const command = await abort;
    assert.equal(await page.locator('#typing-indicator').isVisible(), true);
    assert.doesNotMatch(await page.locator('#messages').innerText(), /Aborted by user/);
    await page.keyboard.press('Escape');
    assert.equal(commands.filter(command => command.type === 'abort').length, 1);
    emit({ type: 'response', command: 'abort', id: command.id, success: true });
    await page.waitForSelector('#typing-indicator.hidden', { state: 'attached' });
    await page.waitForSelector('#abort-btn.hidden', { state: 'attached' });
    assert.notEqual(await page.locator('#status-text').textContent(), 'Stopping…');
  });
}

test('an Abort timeout remains honest and queued instructions stay with their session', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const first = await createSession(t);
  const second = await createSession(t);
  const page = await openPage(t, first.sessionId);
  first.emit({ type: 'agent_start' });
  await page.waitForSelector('#abort-btn:not(.hidden)');
  await page.fill('#message-input', 'keep this in the first session');
  await page.press('#message-input', 'Enter');
  await page.waitForSelector('.queued-msg');
  await page.route('**/api/rpc', async (route) => {
    if (route.request().postDataJSON().type !== 'abort') return route.continue();
    await route.fulfill({ json: { type: 'response', command: 'abort', success: false, error: 'RPC command timed out: abort' } });
  });
  await page.click('#abort-btn');
  await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'Stop timed out — completion not confirmed');
  assert.equal(await page.locator('#typing-indicator').isVisible(), true);
  assert.equal(await page.locator('.queued-msg').count(), 1);
  await page.click(`.live-tab[data-session-id="${second.sessionId}"]`);
  assert.equal(await page.locator('.queued-msg').count(), 0);
  assert.deepEqual(second.commands.filter(command => command.type === 'prompt'), []);
  await page.click(`.live-tab[data-session-id="${first.sessionId}"]`);
  await page.waitForSelector('.queued-msg');
  assert.deepEqual(first.commands.filter(command => command.type === 'prompt'), []);
  const prompt = first.nextCommand('prompt');
  // A native acknowledgement may arrive after Tau already reported timeout,
  // without another agent_settled. Its authoritative idle metadata is enough.
  liveManager.broadcast({ type: 'live_session_updated', session: { id: first.sessionId, abortState: 'timed_out', isStreaming: true } });
  liveManager.broadcast({ type: 'live_session_updated', session: { id: first.sessionId, abortState: 'idle', isStreaming: false } });
  assert.equal((await prompt).message, 'keep this in the first session');
  assert.doesNotMatch(await page.locator('#status-text').innerText(), /timed out/);
});

test('settled operations release queues but a late Abort acknowledgement cannot stop a newer operation', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, emit, nextCommand, commands } = await createSession(t);
  const page = await openPage(t, sessionId);
  emit({ type: 'agent_start' });
  await page.waitForSelector('#abort-btn:not(.hidden)');
  await page.fill('#message-input', 'next operation');
  await page.press('#message-input', 'Enter');
  const abort = nextCommand('abort');
  await page.click('#abort-btn');
  const stop = await abort;
  const nextPrompt = nextCommand('prompt');
  emit({ type: 'agent_settled' });
  assert.equal((await nextPrompt).message, 'next operation');
  emit({ type: 'agent_start' });
  await page.waitForSelector('#typing-indicator:not(.hidden)');
  await page.fill('#message-input', 'after the newer operation');
  await page.press('#message-input', 'Enter');
  const response = page.waitForResponse((response) => response.url().endsWith('/api/rpc') && response.request().postDataJSON().type === 'abort');
  emit({ type: 'response', command: 'abort', id: stop.id, success: true });
  await response;
  await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'Working...');
  assert.equal(await page.locator('#typing-indicator').isVisible(), true);
  assert.equal(await page.locator('.queued-msg').count(), 1);
  assert.equal(commands.filter(command => command.type === 'prompt').length, 1);
});

test('a delayed HTTP snapshot cannot roll back a newer running state or approval count', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, emit } = await createSession(t);
  const page = await openPage(t, sessionId);
  let snapshotCaptured!: () => void;
  const captured = new Promise<void>(resolve => { snapshotCaptured = resolve; });
  let releaseSnapshot!: () => void;
  const released = new Promise<void>(resolve => { releaseSnapshot = resolve; });
  await page.route(`**/api/live-sessions/${sessionId}/snapshot`, async route => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshotCaptured();
    await released;
    await route.fulfill({ response, json: snapshot });
  });
  await page.click(`.live-tab[data-session-id="${sessionId}"]`);
  await captured;
  emit({ type: 'agent_start' });
  emit(confirmRequest('after-snapshot'));
  await page.waitForSelector('#typing-indicator:not(.hidden)');
  await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'Waiting for approval');
  const response = page.waitForResponse(response => response.url().endsWith(`/api/live-sessions/${sessionId}/snapshot`));
  releaseSnapshot();
  await (await response).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.equal(await page.locator('#typing-indicator').isVisible(), true);
  assert.equal(await page.locator('.live-tab.active .live-tab-ui-dot').textContent(), '1');
  assert.equal(await page.locator('#status-text').textContent(), 'Waiting for approval');
});

test('failed dialog delivery can be retried, but a late failure cannot resurrect a resolved request', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId } = await createSession(t);
  const page = await openPage(t, sessionId, { pendingDialogs: [confirmRequest('retry')], interactionRevision: 1 });
  let attempts = 0;
  let releaseFailure!: () => void;
  const delayedFailure = new Promise<void>(resolve => { releaseFailure = resolve; });
  await page.route('**/api/rpc', async route => {
    if (route.request().postDataJSON().type !== 'extension_ui_response') return route.continue();
    if (++attempts === 2) await delayedFailure;
    await route.fulfill({ json: { success: false, error: 'Pi stdin write failed' } });
  });
  await expectDialog(page);
  await page.click('#dialog-yes');
  await page.waitForSelector('.dialog-response-error');
  assert.equal(await page.locator('#dialog-yes').isEnabled(), true);
  assert.equal(await page.locator('#dialog-container').isVisible(), true);
  await page.click('#dialog-no');
  await page.waitForSelector('#dialog-no:disabled');
  liveManager.broadcast({ type: 'live_session_snapshot', sessionId, pendingDialogs: [], interactionRevision: 2 });
  await page.waitForSelector('#dialog-container.hidden', { state: 'attached' });
  const response = page.waitForResponse(response => response.url().endsWith('/api/rpc') && response.request().postDataJSON().type === 'extension_ui_response');
  releaseFailure();
  await (await response).finished();
  assert.equal(await page.locator('#dialog-container').isVisible(), false);
  assert.equal(attempts, 2);
});

test('paired completion events and metadata cannot send multiple queued instructions into one operation', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, emit, commands, nextCommand } = await createSession(t);
  const page = await openPage(t, sessionId);
  emit({ type: 'agent_start' });
  await page.waitForSelector('#abort-btn:not(.hidden)');
  for (const message of ['first queued instruction', 'second queued instruction']) {
    await page.fill('#message-input', message);
    await page.press('#message-input', 'Enter');
  }
  const firstPrompt = nextCommand('prompt');
  emit({ type: 'agent_settled' });
  const first = await firstPrompt;
  emit({ type: 'extension_ui_request', method: 'notify', message: 'idle metadata delivered' });
  await page.waitForFunction(() => document.getElementById('messages')?.textContent?.includes('idle metadata delivered'));
  assert.equal(commands.filter(command => command.type === 'prompt').length, 1);
  assert.equal(await page.locator('.queued-msg').count(), 1);
  emit({ type: 'agent_start' });
  const secondPrompt = nextCommand('prompt');
  emit({ type: 'agent_settled' });
  emit({ type: 'response', command: 'prompt', id: first.id, success: true });
  assert.equal((await secondPrompt).message, 'second queued instruction');
});

test('Abort cancels an unanswered approval before acknowledging idle and running the next instruction', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, emit, nextCommand, commands } = await createSession(t);
  emit({ type: 'agent_start' });
  emit(confirmRequest('unanswered-abort'));
  const page = await openPage(t, sessionId);
  await expectDialog(page);
  await page.fill('#message-input', 'continue after the stopped operation');
  await page.press('#message-input', 'Enter');
  const abort = nextCommand('abort');
  const cancellation = nextCommand('extension_ui_response');
  await page.click('#abort-btn');
  const stop = await abort;
  const reply = await cancellation;
  assert.equal(reply.cancelled, true);
  assert.equal(reply.confirmed, undefined);
  assert.ok(commands.indexOf(stop) < commands.indexOf(reply), 'Abort must reach Pi before the cancelled hook resumes');
  await page.waitForSelector('#dialog-container.hidden', { state: 'attached' });
  assert.equal(await page.locator('#status-text').textContent(), 'Stopping…');
  assert.deepEqual(commands.filter(command => command.type === 'prompt'), []);
  const prompt = nextCommand('prompt');
  emit({ type: 'response', command: 'abort', id: stop.id, success: true });
  assert.equal((await prompt).message, 'continue after the stopped operation');
});

test('confirm, select, input and editor requests are shown in order without cancelling one another', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, emit, commands } = await createSession(t);
  emit(confirmRequest('confirm'));
  emit({ type: 'extension_ui_request', method: 'select', id: 'select', title: 'Choose an option', options: ['one', 'two'] });
  emit({ type: 'extension_ui_request', method: 'input', id: 'input', title: 'Enter a value' });
  emit({ type: 'extension_ui_request', method: 'editor', id: 'editor', title: 'Edit a value', prefill: 'original' });
  const page = await openPage(t, sessionId);
  await expectDialog(page);
  await page.click('#dialog-no');
  await expectDialog(page, 'Choose an option');
  await page.getByText('two', { exact: true }).click();
  await expectDialog(page, 'Enter a value');
  await page.fill('#dialog-input', 'typed value');
  await page.press('#dialog-input', 'Enter');
  await expectDialog(page, 'Edit a value');
  assert.equal(await page.locator('#dialog-textarea').inputValue(), 'original');
  await page.fill('#dialog-textarea', 'edited value');
  await page.click('#dialog-save');
  await page.waitForSelector('#dialog-container.hidden', { state: 'attached' });
  assert.deepEqual(commands.filter(command => command.type === 'extension_ui_response'), [
    { type: 'extension_ui_response', id: 'confirm', confirmed: false },
    { type: 'extension_ui_response', id: 'select', value: 'two' },
    { type: 'extension_ui_response', id: 'input', value: 'typed value' },
    { type: 'extension_ui_response', id: 'editor', value: 'edited value' },
  ]);
});

test('prompt acceptance cannot dispatch a second queued instruction before the first operation starts', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, emit, commands, nextCommand } = await createSession(t);
  const page = await openPage(t, sessionId);
  emit({ type: 'agent_start' });
  await page.waitForSelector('#abort-btn:not(.hidden)');
  for (const message of ['first accepted prompt', 'second queued prompt']) {
    await page.fill('#message-input', message);
    await page.press('#message-input', 'Enter');
  }
  const firstPrompt = nextCommand('prompt');
  emit({ type: 'agent_settled' });
  const first = await firstPrompt;
  let releaseState!: () => void;
  const stateReleased = new Promise<void>(resolve => { releaseState = resolve; });
  await page.route('**/api/rpc', async route => {
    if (route.request().postDataJSON().type !== 'get_state') return route.continue();
    await stateReleased;
    await route.fulfill({ json: { success: true, data: { isStreaming: true } } });
  });
  emit({ type: 'response', command: 'prompt', id: first.id, success: true });
  emit({ type: 'extension_ui_request', method: 'notify', message: 'accepted before agent_start' });
  await page.waitForFunction(() => document.getElementById('messages')?.textContent?.includes('accepted before agent_start'));
  assert.equal(commands.filter(command => command.type === 'prompt').length, 1);
  assert.equal(await page.locator('.queued-msg').count(), 1);
  emit({ type: 'agent_start' });
  releaseState();
  const secondPrompt = nextCommand('prompt');
  emit({ type: 'agent_settled' });
  assert.equal((await secondPrompt).message, 'second queued prompt');
});

test('a rejected queued instruction stays available for explicit retry instead of being discarded', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, emit, nextCommand, commands } = await createSession(t);
  const page = await openPage(t, sessionId);
  emit({ type: 'agent_start' });
  await page.waitForSelector('#abort-btn:not(.hidden)');
  for (const message of ['retry this instruction', 'keep this behind it']) {
    await page.fill('#message-input', message);
    await page.press('#message-input', 'Enter');
  }
  const firstPrompt = nextCommand('prompt');
  emit({ type: 'agent_settled' });
  const first = await firstPrompt;
  emit({ type: 'response', command: 'prompt', id: first.id, success: false, error: 'Prompt rejected' });
  await page.waitForSelector('.queued-msg-retry');
  assert.equal(await page.locator('.queued-msg').count(), 2);
  assert.equal(commands.filter(command => command.type === 'prompt').length, 1);
  const retry = nextCommand('prompt');
  await page.click('.queued-msg-retry');
  assert.equal((await retry).message, 'retry this instruction');
});

test('a handled slash command releases the next queued instruction only after a fresh Pi state probe', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, emit, nextCommand } = await createSession(t);
  const page = await openPage(t, sessionId);
  emit({ type: 'agent_start' });
  await page.waitForSelector('#abort-btn:not(.hidden)');
  for (const message of ['/extension-command', 'after the extension command']) {
    await page.fill('#message-input', message);
    await page.press('#message-input', 'Enter');
  }
  const firstPrompt = nextCommand('prompt');
  emit({ type: 'agent_settled' });
  const first = await firstPrompt;
  assert.equal(first.message, '/extension-command');
  const probe = page.waitForRequest(request => request.url().endsWith('/api/rpc') && request.postDataJSON().type === 'get_state' && request.postDataJSON().refresh === true);
  const secondPrompt = nextCommand('prompt');
  // An extension command can finish without starting a model operation.
  emit({ type: 'response', command: 'prompt', id: first.id, success: true });
  await probe;
  assert.equal((await secondPrompt).message, 'after the extension command');
});

test('reconnecting recovers an approval created while the browser was disconnected', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, emit } = await createSession(t);
  const page = await openPage(t, sessionId);
  for (const client of liveManager.clients) client.close();
  await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'Disconnected');
  emit(confirmRequest('during-disconnect'));
  await page.clock.runFor(1100);
  await expectDialog(page);
  assert.equal(await page.locator('#status-text').textContent(), 'Waiting for approval');
});

test('a queued dispatch whose agent_settled was lost with the socket is released by the reconnect probe', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, emit, nextCommand, commands } = await createSession(t);
  const page = await openPage(t, sessionId);
  emit({ type: 'agent_start' });
  await page.waitForSelector('#abort-btn:not(.hidden)');
  for (const message of ['runs while connected', 'must not stay queued forever']) {
    await page.fill('#message-input', message);
    await page.press('#message-input', 'Enter');
  }
  const firstPrompt = nextCommand('prompt');
  emit({ type: 'agent_settled' });
  const first = await firstPrompt;
  assert.equal(first.message, 'runs while connected');
  emit({ type: 'response', command: 'prompt', id: first.id, success: true });
  emit({ type: 'agent_start' });
  await page.waitForSelector('#abort-btn:not(.hidden)');
  assert.equal(await page.locator('.queued-msg').count(), 1);
  // The operation finishes while no browser is connected.
  for (const client of liveManager.clients) client.close();
  await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'Disconnected');
  emit({ type: 'agent_settled' });
  assert.equal(commands.filter(command => command.type === 'prompt').length, 1);
  const secondPrompt = nextCommand('prompt');
  await page.clock.runFor(1100);
  assert.equal((await secondPrompt).message, 'must not stay queued forever');
  await page.waitForSelector('#queued-messages.hidden', { state: 'attached' });
});

test('a queued instruction whose dispatch never reaches the server returns to the queue for retry', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, emit, nextCommand, commands } = await createSession(t);
  const page = await openPage(t, sessionId);
  emit({ type: 'agent_start' });
  await page.waitForSelector('#abort-btn:not(.hidden)');
  for (const message of ['dropped on the way out', 'waits behind it']) {
    await page.fill('#message-input', message);
    await page.press('#message-input', 'Enter');
  }
  let dropPrompts = true;
  await page.route('**/api/rpc', async route => {
    if (dropPrompts && route.request().postDataJSON().type === 'prompt') return route.abort('connectionfailed');
    return route.continue();
  });
  emit({ type: 'agent_settled' });
  await page.waitForSelector('.queued-msg-retry');
  assert.equal(await page.locator('.queued-msg').count(), 2);
  assert.equal(await page.locator('.queued-msg-label').first().textContent(), 'Not sent');
  assert.deepEqual(commands.filter(command => command.type === 'prompt'), []);
  assert.equal(await page.locator('#message-input').isDisabled(), false);
  dropPrompts = false;
  const retry = nextCommand('prompt');
  await page.click('.queued-msg-retry');
  assert.equal((await retry).message, 'dropped on the way out');
});
