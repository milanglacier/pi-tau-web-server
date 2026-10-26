import { test, before, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { MODEL, PROVIDER, RELEASE_FILE, SUMMARY_TEXT } from '../fixtures/compaction-rpc-provider.ts';

// The real browser, the Tau server and a real Pi RPC process. Only the model
// is fake (see fixtures/compaction-rpc-provider.ts), so Pi's own compaction,
// abort and settings decide what the browser sees.
//
// Pi runs with a temporary agent directory and home, so the user's Pi
// settings, credentials and sessions are never read or changed.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-compaction-e2e-'));
const agentDir = path.join(tmp, 'agent');
const home = path.join(tmp, 'home');
fs.mkdirSync(agentDir);
fs.mkdirSync(home);
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
  packages: [], extensions: [], skills: [], prompts: [], themes: [],
  // Keep almost nothing, so even a short test conversation has something to summarize.
  compaction: { enabled: true, keepRecentTokens: 1 },
  retry: { enabled: false }, enableInstallTelemetry: false,
}));
process.env.TAU_HOST = '127.0.0.1';
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(agentDir, 'sessions');
process.env.TAU_PROJECTS_DIR = path.join(tmp, 'projects');
const { server, computeUrls, liveManager, _setSpawnPiForTest } = (await import('../../bin/tau.js')) as any;

const rpcEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent/rpc-entry'));
const provider = fileURLToPath(new URL('../fixtures/compaction-rpc-provider.ts', import.meta.url));

let base = '';
let browser: Browser | null = null;
let browserUnavailable = '';

before(async () => {
  // Tau's own arguments (RPC mode, its tree extension) plus the fixture model.
  _setSpawnPiForTest((_command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => spawn(process.execPath, [
    rpcEntry, ...args, '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
    '--no-context-files', '--extension', provider, '--provider', PROVIDER, '--model', MODEL, '--thinking', 'off', '--no-tools',
  ], {
    ...options,
    env: { ...options.env, HOME: home, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' },
  }));
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

function skipUnlessBrowser(t: TestContext) {
  if (browser) return false;
  t.skip(browserUnavailable);
  return true;
}

/** A live tab with its own working directory, where the summary gate file goes. */
async function createSession(t: TestContext) {
  const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
  const response = await fetch(`${base}/api/live-sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd }),
  });
  assert.equal(response.status, 200);
  const { session } = await response.json() as { session: { id: string } };
  t.after(async () => { await fetch(`${base}/api/live-sessions/${session.id}`, { method: 'DELETE' }); });
  const releaseSummary = () => fs.writeFileSync(path.join(cwd, RELEASE_FILE), '');
  return { sessionId: session.id, releaseSummary };
}

async function openPage(t: TestContext, sessionId: string) {
  const context = await browser!.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  await context.addInitScript((id) => localStorage.setItem('tau-active-live-session-id', id), sessionId);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'browser must not throw'));
  await page.goto(base);
  await page.waitForSelector('#message-input:not([disabled])');
  return page;
}

async function send(page: Page, text: string) {
  await page.fill('#message-input', text);
  await page.press('#message-input', 'Enter');
}

/** Send a message and wait until Pi has replied and the tab is idle again. */
async function chat(page: Page, sessionId: string, text: string) {
  await send(page, text);
  await page.locator('#messages .message.assistant', { hasText: `Reply to ${text}` }).waitFor();
  await waitIdle(page, sessionId);
}

async function waitIdle(page: Page, sessionId: string) {
  await page.waitForFunction(() => document.getElementById('send-btn')?.classList.contains('hidden') === false);
  const session = liveManager.get(sessionId);
  for (let i = 0; i < 100 && (session.isStreaming || session.compaction); i++) await new Promise(r => setTimeout(r, 20));
}

async function compactFromPalette(page: Page) {
  await page.click('#command-btn');
  await page.locator('.command-item', { hasText: 'Compact' }).click();
}

const runningRow = (page: Page) => page.locator('#messages .compaction-running');
const finishedRow = (page: Page) => page.locator('#messages .compaction-done');

test('Compact from the palette shows the running row, then a divider with the summary', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, releaseSummary } = await createSession(t);
  const page = await openPage(t, sessionId);
  await chat(page, sessionId, 'gated-summary first question');

  await compactFromPalette(page);
  await runningRow(page).waitFor();
  assert.match(await runningRow(page).textContent() || '', /Compacting context…/);
  assert.equal(await page.locator('#abort-btn').isVisible(), true, 'Stop is offered while compacting');
  assert.match(await page.locator('.live-tab.active').innerHTML(), /live-tab-streaming-dot/);

  releaseSummary();
  await finishedRow(page).waitFor();
  assert.equal(await runningRow(page).count(), 0);
  assert.match(await finishedRow(page).textContent() || '', /Context compacted · \S+ → ~\S+ tokens/);
  await finishedRow(page).locator('summary').click();
  assert.match(await finishedRow(page).locator('.compaction-summary-body').textContent() || '', new RegExp(SUMMARY_TEXT));
  assert.match(await page.locator('#context-pill').textContent() || '', /^~/, 'the pill shows the estimate after compaction');
  await page.waitForFunction(() => document.getElementById('send-btn')?.classList.contains('hidden') === false);

  // A reload draws the same divider from the session's entries.
  await page.reload();
  await finishedRow(page).waitFor();
  assert.match(await finishedRow(page).textContent() || '', /Context compacted/);
});

test('/compact with instructions runs compaction instead of reaching the model', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId } = await createSession(t);
  const page = await openPage(t, sessionId);
  // Two exchanges, so the earlier one is summarized with the instructions.
  await chat(page, sessionId, 'first question');
  await chat(page, sessionId, 'second question');

  await send(page, '/compact keep the API notes');
  await finishedRow(page).waitFor();
  assert.equal(await page.inputValue('#message-input'), '');
  const transcript = await page.locator('#messages').textContent() || '';
  assert.ok(!transcript.includes('/compact'), 'the command is not shown as a user message');
  assert.equal(await page.locator('#messages .message.assistant').count(), 2, 'the model never saw the command');
  await finishedRow(page).locator('summary').click();
  assert.match(await finishedRow(page).locator('.compaction-summary-body').textContent() || '', /Focus: keep the API notes/);
});

test('automatic compaction during a reply says the context is nearly full', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, releaseSummary } = await createSession(t);
  const page = await openPage(t, sessionId);
  await send(page, 'big: gated-summary fill the context');
  await runningRow(page).waitFor();
  assert.match(await runningRow(page).textContent() || '', /Context is nearly full\. Compacting automatically…/);
  releaseSummary();
  await finishedRow(page).waitFor();
  await waitIdle(page, sessionId);
  assert.match(await finishedRow(page).textContent() || '', /Context compacted · 90k → ~/);
});

test('a message sent during compaction waits in the queue and is sent afterwards', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, releaseSummary } = await createSession(t);
  const page = await openPage(t, sessionId);
  await chat(page, sessionId, 'gated-summary first question');
  await compactFromPalette(page);
  await runningRow(page).waitFor();

  await send(page, 'queued question');
  await page.locator('#queued-messages .queued-msg', { hasText: 'queued question' }).waitFor();
  assert.equal(await page.locator('#messages .message.user', { hasText: 'queued question' }).count(), 0);

  releaseSummary();
  await page.locator('#messages .message.assistant', { hasText: 'Reply to queued question' }).waitFor();
  await page.waitForSelector('#queued-messages.hidden', { state: 'attached' });
  assert.equal(await page.locator('#messages .error-message').count(), 0);
});

test('Compact during a running reply asks the user to wait and leaves the reply running', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId } = await createSession(t);
  const page = await openPage(t, sessionId);
  await send(page, 'slow-reply: take your time');
  await page.waitForSelector('#abort-btn:not(.hidden)');
  await page.waitForFunction(() => document.querySelector('.live-tab.active .live-tab-streaming-dot'));

  await compactFromPalette(page);
  await page.locator('#messages .compaction-refused', { hasText: 'Wait for the reply to finish, or stop it first.' }).waitFor();
  await send(page, '/compact');
  await page.locator('#messages .compaction-refused').waitFor();
  assert.equal(await page.inputValue('#message-input'), '/compact', 'a refused /compact stays in the input');
  assert.equal(await page.locator('#messages .compaction-message').count(), 0);
  assert.equal(liveManager.get(sessionId).isStreaming, true, 'the reply keeps running');
  assert.equal(liveManager.get(sessionId).compaction, null);
});

test('the auto-compaction setting shows and changes Pi\'s real value', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId } = await createSession(t);
  const page = await openPage(t, sessionId);
  const readSetting = () => JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')).compaction?.enabled;
  const piState = async () => {
    const response = await fetch(`${base}/api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_state', sessionId, refresh: true }),
    });
    return (await response.json()).data.autoCompactionEnabled;
  };
  const toggle = page.locator('#toggle-auto-compact');

  await page.click('#settings-btn');
  await page.waitForFunction(() => document.getElementById('toggle-auto-compact')?.classList.contains('on'));

  await toggle.click();
  await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'Done');
  assert.equal(await piState(), false);
  assert.equal(readSetting(), false);

  await toggle.click();
  await page.waitForFunction(() => document.getElementById('toggle-auto-compact')?.classList.contains('on'));
  for (let i = 0; i < 50 && await piState() !== true; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(await piState(), true);
  assert.equal(readSetting(), true);
});

test('Stop during compaction cancels it', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId } = await createSession(t);
  const page = await openPage(t, sessionId);
  await chat(page, sessionId, 'gated-summary first question');
  await compactFromPalette(page);
  await runningRow(page).waitFor();

  await page.click('#abort-btn');
  await page.locator('#messages .compaction-cancelled', { hasText: 'Compaction cancelled' }).waitFor();
  await waitIdle(page, sessionId);
  assert.equal(await page.locator('#messages .compaction-done').count(), 0);
  assert.equal(await page.locator('#messages .error-message').count(), 0, 'cancelling is not reported as a failure');
});

test('reloading during a slow compaction still shows the running row', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, releaseSummary } = await createSession(t);
  const page = await openPage(t, sessionId);
  await chat(page, sessionId, 'gated-summary first question');
  await compactFromPalette(page);
  await runningRow(page).waitFor();

  await page.reload();
  await runningRow(page).waitFor();
  assert.match(await runningRow(page).textContent() || '', /Compacting context…/);
  assert.equal(await page.locator('#abort-btn').isVisible(), true);

  releaseSummary();
  await finishedRow(page).waitFor();
  assert.equal(await runningRow(page).count(), 0);
});
