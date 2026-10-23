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

// The real browser and Tau server, with session files written to disk and Pi
// replaced at its stdio boundary. The "big" project has more than 10 sessions.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-sidebar-e2e-'));
const projects = path.join(tmp, 'projects');
const sessionsDir = path.join(tmp, 'sessions');
process.env.TAU_HOST = '127.0.0.1';
process.env.PI_CODING_AGENT_DIR = tmp;
process.env.PI_CODING_AGENT_SESSION_DIR = sessionsDir;
process.env.TAU_PROJECTS_DIR = projects;
const { server, computeUrls, liveManager, _setSpawnPiForTest, _setExecFileForTest } = (await import('../../bin/tau.js')) as any;

const BIG = path.join(projects, 'big');
const SMALL = path.join(projects, 'small');
const TRASH = path.join(projects, 'trash');
const BIG_COUNT = 13;
const TRASH_COUNT = 11;

let base = '';
let browser: Browser | null = null;
let browserUnavailable = '';

function writeSession(projectPath: string, name: string, title: string, ageSeconds: number) {
  const dir = path.join(sessionsDir, `--${path.basename(projectPath)}--`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.jsonl`);
  const lines = [
    { type: 'session', id: name, timestamp: '2026-01-01T00:00:00.000Z', cwd: projectPath },
    { type: 'message', message: { role: 'user', content: title } },
    { type: 'message', message: { role: 'assistant', content: 'reply' } },
    { type: 'message', message: { role: 'user', content: 'follow up' } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const when = new Date(Date.now() - ageSeconds * 1000);
  fs.utimesSync(file, when, when);
  return file;
}

before(async () => {
  _setSpawnPiForTest((_command: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 12345;
    child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); };
    const sessionIndex = args.indexOf('--session');
    const sessionFile = sessionIndex >= 0 ? args[sessionIndex + 1] : null;
    let buffer = '';
    child.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n');
        const command = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        child.stdout.write(JSON.stringify({
          type: 'response', id: command.id, command: command.type, success: true,
          data: command.type === 'get_state' ? { sessionFile, isStreaming: false } : {},
        }) + '\n');
      }
    });
    return child;
  });
  _setExecFileForTest((_file: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string, stderr: string) => void) => cb(null, '', ''));
  fs.mkdirSync(BIG, { recursive: true });
  fs.mkdirSync(SMALL, { recursive: true });
  fs.mkdirSync(TRASH, { recursive: true });
  // Session 0 is the newest, session 12 the oldest.
  for (let i = 0; i < BIG_COUNT; i++) writeSession(BIG, `big-${i}`, `big session ${i}`, 60 + i);
  for (let i = 0; i < TRASH_COUNT; i++) writeSession(TRASH, `trash-${i}`, `trash session ${i}`, 600 + i);
  for (let i = 0; i < 2; i++) writeSession(SMALL, `small-${i}`, `small session ${i}`, 10 + i);
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

async function openSidebar(t: TestContext): Promise<Page | null> {
  if (!browser) { t.skip(browserUnavailable); return null; }
  const context = await browser.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'browser must not throw'));
  await page.goto(base);
  await page.waitForSelector('.project-group .session-item');
  return page;
}

const group = (page: Page, name: string) => page.locator('.project-group').filter({ has: page.locator(`.project-header span[title$="/${name}"]`) });
const titles = (page: Page, name: string) => group(page, name).locator('.session-title').allTextContents();

test('a project with more than 10 sessions shows the 10 newest, and a project with few has no toggle', async (t) => {
  const page = await openSidebar(t);
  if (!page) return;
  const shown = await titles(page, 'big');
  assert.deepEqual(shown, Array.from({ length: 10 }, (_, i) => `big session ${i}`));
  // The badge counts every session, not only the ones shown.
  assert.equal(await group(page, 'big').locator('.project-count').textContent(), String(BIG_COUNT));
  assert.equal(await group(page, 'big').locator('.project-more-btn span:last-child').textContent(), `Show all ${BIG_COUNT}`);

  assert.equal((await titles(page, 'small')).length, 2);
  assert.equal(await group(page, 'small').locator('.project-more-btn').count(), 0);
});

test('Show all expands only that project and Show fewer limits it again', async (t) => {
  const page = await openSidebar(t);
  if (!page) return;
  await group(page, 'big').locator('.project-more-btn').click();
  assert.equal((await titles(page, 'big')).length, BIG_COUNT);
  assert.equal(await group(page, 'big').locator('.project-more-btn span:last-child').textContent(), 'Show fewer');
  assert.equal((await titles(page, 'small')).length, 2);

  await group(page, 'big').locator('.project-more-btn').click();
  assert.equal((await titles(page, 'big')).length, 10);
});

test('live-tab selection, reload, and closing tabs keep the open session listed', async (t) => {
  const page = await openSidebar(t);
  if (!page) return;
  const resume = async (index: number) => {
    const response = await fetch(`${base}/api/live-sessions/resume`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: path.join(sessionsDir, '--big--', `big-${index}.jsonl`) }),
    });
    assert.equal(response.status, 200);
    const { session } = await response.json() as { session: { id: string } };
    t.after(async () => { await fetch(`${base}/api/live-sessions/${session.id}`, { method: 'DELETE' }); });
    return page.locator(`.live-tab[data-session-id="${session.id}"]`);
  };
  const oldest = await resume(12);
  const recent = await resume(2);
  const activeTitle = group(page, 'big').locator('.session-item.active .session-title');

  await oldest.click();
  await activeTitle.filter({ hasText: 'big session 12' }).waitFor();
  assert.deepEqual(await titles(page, 'big'), [
    ...Array.from({ length: 10 }, (_, i) => `big session ${i}`), 'big session 12',
  ]);

  await page.reload();
  await activeTitle.filter({ hasText: 'big session 12' }).waitFor();
  assert.equal((await titles(page, 'big')).length, 11);

  await recent.click();
  await activeTitle.filter({ hasText: 'big session 2' }).waitFor();
  assert.equal((await titles(page, 'big')).length, 10);

  await recent.locator('.live-tab-close').click();
  await activeTitle.filter({ hasText: 'big session 12' }).waitFor();
  assert.equal((await titles(page, 'big')).length, 11);

  await oldest.locator('.live-tab-close').click();
  await page.waitForFunction(() => document.querySelectorAll('.live-tab').length === 0);
  assert.equal((await titles(page, 'big')).length, 10);
  assert.equal(await activeTitle.count(), 0);
});

test('searching finds sessions beyond the 10 shown, and clearing the search limits the project again', async (t) => {
  const page = await openSidebar(t);
  if (!page) return;
  await page.fill('#session-search-input', 'big session 12');
  const visible = group(page, 'big').locator('.session-item:not(.hidden) .session-title');
  assert.deepEqual(await visible.allTextContents(), ['big session 12']);

  await page.fill('#session-search-input', '');
  assert.equal((await titles(page, 'big')).length, 10);
  assert.equal(await group(page, 'big').locator('.project-more-btn span:last-child').textContent(), `Show all ${BIG_COUNT}`);
});

test('a project + opens the popup without collapsing the project and creates a tab in that directory', async (t) => {
  const page = await openSidebar(t);
  if (!page) return;
  await group(page, 'big').locator('.project-add-btn').click();
  await page.waitForSelector('#new-live-session-modal:not(.hidden)');
  assert.equal(await page.inputValue('#new-live-session-cwd'), BIG);
  assert.equal(await group(page, 'big').locator('.project-header.collapsed').count(), 0);
  assert.equal(await group(page, 'big').locator('.project-sessions.collapsed').count(), 0);

  // A different project replaces the value from the first one.
  await page.click('#new-live-session-cancel');
  await group(page, 'small').locator('.project-add-btn').click();
  await page.waitForSelector('#new-live-session-modal:not(.hidden)');
  assert.equal(await page.inputValue('#new-live-session-cwd'), SMALL);

  const createdResponse = page.waitForResponse(response => response.url() === `${base}/api/live-sessions` && response.request().method() === 'POST');
  await page.click('#new-live-session-submit');
  const response = await createdResponse;
  assert.equal(response.status(), 200);
  const { session } = await response.json() as { session: { id: string; cwd: string } };
  t.after(async () => { await fetch(`${base}/api/live-sessions/${session.id}`, { method: 'DELETE' }); });
  await page.waitForSelector(`.live-tab.active[data-session-id="${session.id}"]`);
  assert.equal(session.cwd, SMALL);
  assert.equal(await page.locator('#new-live-session-modal').isVisible(), false);
});

test('only project headers have a +, not the favourites or search result headers', async (t) => {
  const page = await openSidebar(t);
  if (!page) return;
  assert.equal(await page.locator('.project-add-btn').count(), await page.locator('.project-group').count());
  assert.equal(await page.locator('.favourites-header .project-add-btn, .search-results-header .project-add-btn').count(), 0);
});

test('deleting a session in a limited project brings in the next older one', async (t) => {
  const page = await openSidebar(t);
  if (!page) return;
  page.on('dialog', (dialog) => dialog.accept());
  assert.equal((await titles(page, 'trash')).length, 10);
  await group(page, 'trash').locator('.session-item').first().click({ button: 'right' });
  await page.click('.context-menu-item:has-text("Delete")');
  await page.waitForFunction(() => !document.body.textContent?.includes('trash session 0'));
  const shown = await titles(page, 'trash');
  assert.deepEqual(shown, Array.from({ length: 10 }, (_, i) => `trash session ${i + 1}`));
  // Ten sessions are left, so the toggle is gone.
  assert.equal(await group(page, 'trash').locator('.project-more-btn').count(), 0);
});

test('deleting during full-text search keeps the remaining message matches', async (t) => {
  const page = await openSidebar(t);
  if (!page) return;
  page.on('dialog', (dialog) => dialog.accept());
  await page.fill('#session-search-input', 'small session');
  const matches = page.locator('.search-results-group .session-title');
  await matches.nth(1).waitFor();

  for (let index = 0; index < 2; index++) {
    const title = group(page, 'small').locator('.session-title').filter({ hasText: `small session ${index}` });
    await title.click({ button: 'right' });
    await page.click('.context-menu-item:has-text("Delete")');
    await title.waitFor({ state: 'detached' });
    assert.deepEqual(await matches.allTextContents(), index === 0 ? ['small session 1'] : []);
    assert.equal(await page.inputValue('#session-search-input'), 'small session');
    if (index === 0) {
      assert.equal(await page.locator('.search-results-header .project-count').textContent(), '1');
    } else {
      assert.equal(await page.locator('.search-results-group').count(), 0);
    }
  }
});
