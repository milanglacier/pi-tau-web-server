import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chromium } from 'playwright';
import type { TestContext } from 'node:test';
import type { Browser, BrowserContext, Page } from 'playwright';

// Real-browser test for provider errors: a failed reply must show the error
// where the reply stopped, and an error Pi recovered from with a retry must
// not be shown as a final failure.

process.env.TAU_HOST = '127.0.0.1';
process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-e2e-errors-'));
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions');
process.env.TAU_PROJECTS_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'projects');

const { server, computeUrls, SESSIONS_DIR, liveManager, _setSpawnPiForTest, _setExecFileForTest } = (await import('../../bin/tau.js')) as any;

let base = '';
let browser: Browser | null = null;
let browserUnavailable = '';
const contexts: BrowserContext[] = [];

const PROJ_DIR = path.join(SESSIONS_DIR, '--tmp--error-e2e');
const FINAL_ERROR = '401: {"type":"authentication_error","code":"api_key_expired","message":"This API key has expired."}';
const RECOVERED_ERROR = '503: temporary upstream failure';
let sessionFile = '';

function makeFakeChild() {
  const child: any = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12345;
  child.kill = () => {};
  return child;
}

function writeSession(cwd: string) {
  fs.mkdirSync(PROJ_DIR, { recursive: true });
  const entries = [
    { type: 'session', id: 'e2e-errors', timestamp: '2026-01-03T00:00:00.000Z', cwd },
    { type: 'message', message: { role: 'user', content: 'first question' } },
    {
      type: 'message',
      message: {
        role: 'assistant', content: [], stopReason: 'error', errorMessage: FINAL_ERROR,
        provider: 'test', model: 'test', timestamp: Date.now(),
      },
    },
    { type: 'message', message: { role: 'user', content: 'second question' } },
    {
      type: 'message',
      message: {
        role: 'assistant', content: [], stopReason: 'error', errorMessage: RECOVERED_ERROR,
        provider: 'test', model: 'test', timestamp: Date.now(),
      },
    },
    {
      type: 'message',
      message: {
        role: 'assistant', content: [{ type: 'text', text: 'recovered answer' }], stopReason: 'stop',
        provider: 'test', model: 'test', timestamp: Date.now(),
      },
    },
    { type: 'session_info', name: 'Error E2E Session' },
  ];
  sessionFile = path.join(PROJ_DIR, 'errors.jsonl');
  fs.writeFileSync(sessionFile, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}

async function openPage() {
  const context = await browser!.newContext();
  contexts.push(context);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (err: Error) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg: { type: () => string; text: () => string }) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) {
      errors.push(`console.error: ${msg.text()}`);
    }
  });
  await page.goto(base);
  await page.waitForSelector('.session-item', { timeout: 15000 });
  return { page, errors };
}

function sessionItemSelector(filePath: string) {
  return `.session-item[data-file-path="${path.resolve(filePath)}"]`;
}

function skipUnlessBrowser(t: TestContext) {
  if (!browser) {
    t.skip(browserUnavailable);
    return true;
  }
  return false;
}

async function openErrorSession(page: Page) {
  await page.click(sessionItemSelector(sessionFile));
  await page.waitForFunction(
    () => document.getElementById('messages')?.textContent?.includes('recovered answer'),
    undefined,
    { timeout: 30000 }
  );
}

before(async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-e2e-error-cwd-'));
  writeSession(cwd);

  _setSpawnPiForTest(() => makeFakeChild());
  _setExecFileForTest((_file: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string, stderr: string) => void) =>
    cb(null, '', '')
  );

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      computeUrls(port);
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  try {
    browser = await chromium.launch();
  } catch (e) {
    browserUnavailable = `Playwright browser unavailable (${(e as Error).message.split('\n')[0]}). Run via: npm run test:e2e`;
  }
});

after(async () => {
  for (const context of contexts) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  await liveManager.shutdown();
  _setSpawnPiForTest(null);
  _setExecFileForTest(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('reopened history shows the final provider error and hides an error Pi recovered from', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage();
  await openErrorSession(page);

  const visibleErrors = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#messages .message-error')).map((element) => element.textContent || '')
  );
  assert.equal(visibleErrors.length, 1);
  assert.ok(visibleErrors[0].includes(FINAL_ERROR));
  assert.ok(!visibleErrors[0].includes(RECOVERED_ERROR));

  assert.deepEqual(errors, []);
});

test('a failed reply shows a retry notice, then only the final failure stays inline', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage();
  await openErrorSession(page);

  const session = liveManager.findBySessionFile(sessionFile);
  assert.ok(session, 'the resumed session should be live');
  const broadcast = (event: Record<string, unknown>) =>
    liveManager.broadcast({ type: 'event', sessionId: session.id, event });
  const historyErrors = await page.locator('#messages .message-error').count();

  broadcast({ type: 'agent_start' });
  broadcast({ type: 'turn_start' });
  broadcast({ type: 'message_start', message: { role: 'assistant', content: [] } });
  broadcast({
    type: 'message_end',
    message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '502: upstream failure' },
  });
  assert.equal(await page.locator('#messages .message-error').count(), historyErrors, 'a retryable failure must wait for the final outcome');

  broadcast({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 5000, errorMessage: '502: upstream failure' });
  await page.waitForSelector('#messages .retry-message');
  assert.match(await page.locator('#messages .retry-message').textContent() || '', /attempt 1\/3/);
  assert.match(await page.locator('#messages .retry-message').textContent() || '', /502: upstream failure/);

  broadcast({ type: 'agent_start' });
  broadcast({ type: 'turn_start' });
  await page.waitForFunction(() => !document.querySelector('#messages .retry-message'));
  broadcast({ type: 'message_start', message: { role: 'assistant', content: [] } });
  broadcast({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'recovered live answer' }], stopReason: 'stop' } });
  broadcast({ type: 'auto_retry_end', success: true, attempt: 1 });
  broadcast({ type: 'agent_settled' });
  await page.waitForFunction(() => document.getElementById('messages')?.textContent?.includes('recovered live answer'));
  assert.equal(await page.locator('#messages .message-error').count(), historyErrors, 'a successful retry must not leave the error visible');

  broadcast({ type: 'agent_start' });
  broadcast({ type: 'turn_start' });
  broadcast({ type: 'message_start', message: { role: 'assistant', content: [] } });
  broadcast({
    type: 'message_end',
    message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '401: final provider failure' },
  });
  broadcast({ type: 'agent_settled' });

  await page.waitForFunction(
    (expected: number) => document.querySelectorAll('#messages .message-error').length === expected,
    historyErrors + 1
  );
  const finalError = await page.locator('#messages .message-error').last().textContent() || '';
  assert.ok(finalError.includes('401: final provider failure'));
  assert.equal(await page.locator('#messages .retry-message').count(), 0);

  assert.deepEqual(errors, []);
});
