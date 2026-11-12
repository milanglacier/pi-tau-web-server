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
import { MODEL, PROVIDER } from '../fixtures/compaction-rpc-provider.ts';

// The real browser, the Tau server and a real Pi RPC process, so the `/` menu
// lists what Pi really offers. Only the model is fake, and a prompt template
// from the fixtures folder stands in for the user's own commands.
//
// Pi runs with a temporary agent directory and home, so the user's Pi
// settings and sessions are never read or changed.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-composer-e2e-'));
const agentDir = path.join(tmp, 'agent');
const home = path.join(tmp, 'home');
fs.mkdirSync(agentDir);
fs.mkdirSync(home);
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
  packages: [], extensions: [], skills: [], prompts: [], themes: [],
  retry: { enabled: false }, enableInstallTelemetry: false,
}));
process.env.TAU_HOST = '127.0.0.1';
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(agentDir, 'sessions');
process.env.TAU_PROJECTS_DIR = path.join(tmp, 'projects');
const { server, computeUrls, liveManager, _setSpawnPiForTest } = (await import('../../bin/tau.js')) as any;

const rpcEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent/rpc-entry'));
const provider = fileURLToPath(new URL('../fixtures/compaction-rpc-provider.ts', import.meta.url));
const promptTemplate = fileURLToPath(new URL('../fixtures/prompts/fixture-review.md', import.meta.url));

let base = '';
let browser: Browser | null = null;
let browserUnavailable = '';

before(async () => {
  _setSpawnPiForTest((_command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => spawn(process.execPath, [
    rpcEntry, ...args, '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
    '--no-context-files', '--prompt-template', promptTemplate, '--extension', provider,
    '--provider', PROVIDER, '--model', MODEL, '--thinking', 'off', '--no-tools',
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
  sharedSessionId = await createSession();
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

/** A live tab whose working directory has a few files to suggest. */
async function createSession() {
  const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
  for (const file of ['src/app.ts', 'src/lib/helper.ts', 'docs/guide.md', 'my notes.txt']) {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), '');
  }
  const response = await fetch(`${base}/api/live-sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd }),
  });
  assert.equal(response.status, 200);
  const { session } = await response.json() as { session: { id: string } };
  return session.id as string;
}

// Starting Pi is the slowest step, so the tests that only look at the menus
// share one tab. The tests that send a message have a tab of their own.
let sharedSessionId = '';

async function ownSession(t: TestContext) {
  const sessionId = await createSession();
  t.after(async () => { await fetch(`${base}/api/live-sessions/${sessionId}`, { method: 'DELETE' }); });
  return sessionId;
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

const menu = (page: Page) => page.locator('.input-bubble .completion-list:not(.hidden)');
const rows = (page: Page) => page.locator('.input-bubble .completion-list .model-item');
const rowNames = (page: Page) => rows(page).locator('.model-item-name').allTextContents();

async function type(page: Page, text: string) {
  await page.locator('#message-input').pressSequentially(text);
}

/** Type the start of a command that the `/` menu offers. The first Enter accepts the row, and the second sends it. */
async function runCommand(page: Page, partial: string, full: string) {
  await type(page, partial);
  await rows(page).first().waitFor();
  await page.keyboard.press('Enter');
  assert.equal(await page.inputValue('#message-input'), `${full} `);
  await page.keyboard.press('Enter');
}

test('typing @ap suggests the file, and Tab inserts it with a trailing space', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const page = await openPage(t, sharedSessionId);
  await type(page, 'look at @ap');
  await rows(page).first().waitFor();
  assert.deepEqual(await rowNames(page), ['app.ts']);
  assert.equal(await rows(page).first().locator('.model-item-context').textContent(), 'src/app.ts');

  await page.keyboard.press('Tab');
  assert.equal(await page.inputValue('#message-input'), 'look at @src/app.ts ');
  assert.equal(await menu(page).count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'message-input');
  // The caret is after the inserted text, so typing carries on from there.
  await type(page, 'please');
  assert.equal(await page.inputValue('#message-input'), 'look at @src/app.ts please');
});

test('accepting a folder goes on to its contents, and accepting a file ends the reference', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const page = await openPage(t, sharedSessionId);
  await type(page, '@sr');
  await rows(page).first().waitFor();
  assert.equal((await rowNames(page))[0], 'src/');

  await page.keyboard.press('Tab');
  assert.equal(await page.inputValue('#message-input'), '@src/');
  await page.waitForFunction(() => document.querySelectorAll('.input-bubble .completion-list .model-item').length === 3);
  assert.deepEqual((await rowNames(page)).sort(), ['app.ts', 'helper.ts', 'lib/']);

  await rows(page).filter({ has: page.locator('.model-item-name', { hasText: /^lib\/$/ }) }).click();
  assert.equal(await page.inputValue('#message-input'), '@src/lib/');
  await page.waitForFunction(() => document.querySelector('.input-bubble .completion-list .model-item-name')?.textContent === 'helper.ts');
  await page.keyboard.press('Tab');
  assert.equal(await page.inputValue('#message-input'), '@src/lib/helper.ts ');
  assert.equal(await menu(page).count(), 0);
});

test('a file name with spaces is quoted', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const page = await openPage(t, sharedSessionId);
  await type(page, '@"my n');
  await rows(page).first().waitFor();
  assert.deepEqual(await rowNames(page), ['my notes.txt']);
  await page.keyboard.press('Tab');
  assert.equal(await page.inputValue('#message-input'), '@"my notes.txt" ');
});

test('typing / lists Pi\'s prompt templates and Tau\'s own commands, but not Tau\'s internal one', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const page = await openPage(t, sharedSessionId);
  await type(page, '/');
  await rows(page).first().waitFor();
  const names = await rowNames(page);
  for (const expected of ['/compact', '/tree', '/export', '/session', '/model', '/fixture-review']) {
    assert.ok(names.some((name) => name.startsWith(expected)), `${expected} is listed in ${JSON.stringify(names)}`);
  }
  assert.ok(!names.some((name) => name.includes('tau-tree-navigate')));
  const template = rows(page).filter({ hasText: '/fixture-review' });
  assert.match(await template.textContent() || '', /prompt/);
  assert.match(await template.textContent() || '', /Review the changes/);
  assert.match(await rows(page).filter({ hasText: '/compact' }).textContent() || '', /tau/);

  // Typing more narrows the list, and Tab inserts the command and a space.
  await type(page, 'fixt');
  await page.waitForFunction(() => document.querySelectorAll('.input-bubble .completion-list .model-item').length === 1);
  await page.keyboard.press('Tab');
  assert.equal(await page.inputValue('#message-input'), '/fixture-review ');
  assert.equal(await menu(page).count(), 0);
});

test('a / that does not start the input shows no menu', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const page = await openPage(t, sharedSessionId);
  await type(page, 'open /usr');
  await page.waitForTimeout(250);
  assert.equal(await menu(page).count(), 0);
});

test('Enter with the menu open accepts the highlighted row instead of sending', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const page = await openPage(t, await ownSession(t));
  await type(page, '@ap');
  await rows(page).first().waitFor();
  await page.keyboard.press('Enter');
  assert.equal(await page.inputValue('#message-input'), '@src/app.ts ');
  assert.equal(await page.locator('#messages .message.user').count(), 0);

  // With the menu closed, Enter sends as usual.
  await page.keyboard.press('Enter');
  await page.locator('#messages .message.user', { hasText: '@src/app.ts' }).waitFor();
  assert.equal(await page.inputValue('#message-input'), '');
});

test('Escape closes the menu and does not stop a running reply', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const sessionId = await ownSession(t);
  const page = await openPage(t, sessionId);
  await page.fill('#message-input', 'slow-reply: take your time');
  await page.press('#message-input', 'Enter');
  await page.locator('#abort-btn:not(.hidden)').waitFor();

  await type(page, '/');
  await rows(page).first().waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelectorAll('.input-bubble .completion-list .model-item').length === 0);
  assert.equal(await page.locator('#abort-btn').isVisible(), true, 'the reply is still running');
  assert.equal(liveManager.get(sessionId).isStreaming, true);

  // With the menu closed, Escape stops the reply as before.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('abort-btn')?.classList.contains('hidden'));
});

test('a click on a row accepts it and keeps the caret in the input', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const page = await openPage(t, sharedSessionId);
  await type(page, '@gu');
  await rows(page).first().waitFor();
  await rows(page).first().click();
  assert.equal(await page.inputValue('#message-input'), '@docs/guide.md ');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'message-input');
});

test('a terminal-only command is not sent: it stays in the input with an explanation', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const page = await openPage(t, sharedSessionId);
  await page.fill('#message-input', '/settings');
  await page.press('#message-input', 'Enter');
  const note = page.locator('#messages .command-note');
  await note.waitFor();
  assert.match(await note.textContent() || '', /\/settings only works in Pi's terminal/);
  assert.equal(await page.inputValue('#message-input'), '/settings');
  assert.equal(await page.locator('#messages .message.user').count(), 0);
});

test('/model and /tree open the same dialogs as their buttons', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const page = await openPage(t, sharedSessionId);
  await runCommand(page, '/mod', '/model');
  await page.locator('#model-picker:not(.hidden)').waitFor();
  assert.equal(await page.inputValue('#message-input'), '');
  await page.keyboard.press('Escape');
  await page.locator('#model-picker.hidden').waitFor({ state: 'attached' });

  // A command that is already fully typed is sent by the first Enter.
  await type(page, '/tree');
  await rows(page).first().waitFor();
  await page.keyboard.press('Enter');
  await page.locator('.tree-view:not(.hidden)').waitFor();
  assert.equal(await page.inputValue('#message-input'), '');
  assert.equal(await page.locator('#messages .message.user').count(), 0);
});
