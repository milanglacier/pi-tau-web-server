import { test, before, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';

// The real browser and Tau server. Only the `pi --list-models` command is
// replaced, so the model suggestions come from a known list.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-completion-e2e-'));
const projects = path.join(tmp, 'projects');
process.env.TAU_HOST = '127.0.0.1';
process.env.PI_CODING_AGENT_DIR = tmp;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(tmp, 'sessions');
process.env.TAU_PROJECTS_DIR = projects;
const { server, computeUrls, liveManager, _setExecFileForTest } = (await import('../../bin/tau.js')) as any;

const MODEL_LIST = [
  'provider  model  context  max-out  thinking  images',
  'openai  gpt-5.5  400K  128K  yes  yes',
  'openrouter  z-ai/glm-5.2  200K  64K  yes  no',
  'anthropic  claude-sonnet  200K  64K  yes  yes',
].join('\n');

let base = '';
let browser: Browser | null = null;
let browserUnavailable = '';

before(async () => {
  fs.mkdirSync(path.join(projects, 'alpha-app', 'src'), { recursive: true });
  fs.mkdirSync(path.join(projects, 'alpha-lib'), { recursive: true });
  fs.mkdirSync(path.join(projects, 'beta'), { recursive: true });
  _setExecFileForTest((_file: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string, stderr: string) => void) => cb(null, MODEL_LIST, ''));
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
  _setExecFileForTest(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function openPopup(t: TestContext): Promise<Page | null> {
  if (!browser) { t.skip(browserUnavailable); return null; }
  const context = await browser.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'browser must not throw'));
  await page.goto(base);
  await page.click('#live-tab-add');
  await page.waitForSelector('#new-live-session-modal:not(.hidden)');
  return page;
}

const rows = (page: Page, input: string) => page.locator(`.completion-wrap:has(#${input}) .model-item`);

test('typing a project name lists matching directories and Tab fills in the first one', async (t) => {
  const page = await openPopup(t);
  if (!page) return;
  await page.fill('#new-live-session-cwd', '');
  await page.locator('#new-live-session-cwd').pressSequentially('alp');
  await rows(page, 'new-live-session-cwd').first().waitFor();
  assert.deepEqual(await rows(page, 'new-live-session-cwd').locator('.model-item-name').allTextContents(), ['alpha-app', 'alpha-lib']);

  await page.keyboard.press('Tab');
  assert.equal(await page.inputValue('#new-live-session-cwd'), `${path.join(projects, 'alpha-app')}/`);
  // Focus stays in the field, and the next level is offered straight away.
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'new-live-session-cwd');
  await page.waitForFunction(() => document.querySelector('.completion-wrap:has(#new-live-session-cwd) .model-item-name')?.textContent === 'src');
});

test('Escape closes the directory list without closing the popup', async (t) => {
  const page = await openPopup(t);
  if (!page) return;
  await page.fill('#new-live-session-cwd', '');
  await page.locator('#new-live-session-cwd').pressSequentially('be');
  await rows(page, 'new-live-session-cwd').first().waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelectorAll('.completion-wrap:has(#new-live-session-cwd) .model-item').length === 0);
  assert.equal(await page.locator('#new-live-session-modal').isVisible(), true);
});

test('typing a model name lists matching models and Enter accepts the highlighted one', async (t) => {
  const page = await openPopup(t);
  if (!page) return;
  await page.locator('#new-live-session-model').pressSequentially('glm');
  await rows(page, 'new-live-session-model').first().waitFor();
  assert.equal(await rows(page, 'new-live-session-model').count(), 1);
  assert.match(await rows(page, 'new-live-session-model').first().innerText(), /z-ai\/glm-5\.2/);

  await page.keyboard.press('Enter');
  assert.equal(await page.inputValue('#new-live-session-model'), 'openrouter/z-ai/glm-5.2');
  // Accepting does not submit the form, and the list is closed afterwards.
  assert.equal(await page.locator('#new-live-session-modal').isVisible(), true);
  assert.equal(await rows(page, 'new-live-session-model').count(), 0);
});

test('no model suggestions appear once a thinking level is being typed', async (t) => {
  const page = await openPopup(t);
  if (!page) return;
  await page.locator('#new-live-session-model').pressSequentially('openai/gpt-5.5:hi');
  await page.waitForTimeout(150);
  assert.equal(await rows(page, 'new-live-session-model').count(), 0);
});
