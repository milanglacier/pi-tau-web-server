import { test, before, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';

// The real browser and Tau server, with session files written to disk. The
// "big" project has more sessions than the sidebar shows by default.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-sidebar-e2e-'));
const projects = path.join(tmp, 'projects');
const sessionsDir = path.join(tmp, 'sessions');
process.env.TAU_HOST = '127.0.0.1';
process.env.PI_CODING_AGENT_DIR = tmp;
process.env.PI_CODING_AGENT_SESSION_DIR = sessionsDir;
process.env.TAU_PROJECTS_DIR = projects;
const { server, computeUrls, liveManager } = (await import('../../bin/tau.js')) as any;

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

test('the open session stays listed after the 10 newest, and leaves when another one is opened', async (t) => {
  const page = await openSidebar(t);
  if (!page) return;
  // A separate sidebar on the same data lets the test open sessions without
  // starting a Pi process.
  const result = await page.evaluate(async (bigPath: string) => {
    const modulePath = '/session-sidebar.js';
    const { SessionSidebar } = await import(modulePath);
    const data = await (await fetch('/api/sessions')).json();
    const project = data.projects.find((p: { path: string }) => p.path === bigPath);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const sidebar = new SessionSidebar(container, () => {});
    sidebar.projects = [project];
    const titlesNow = () => Array.from(container.querySelectorAll('.session-title')).map((el) => el.textContent);
    sidebar.render();
    const initial = titlesNow();
    sidebar.setActive(project.sessions[12].filePath);
    const withOld = titlesNow();
    const activeRows = container.querySelectorAll('.session-item.active').length;
    sidebar.setActive(project.sessions[2].filePath);
    const afterSwitch = titlesNow();
    return { initial: initial.length, withOld, activeRows, afterSwitch };
  }, BIG);
  assert.equal(result.initial, 10);
  assert.equal(result.withOld.length, 11);
  assert.equal(result.withOld[10], 'big session 12');
  assert.equal(result.activeRows, 1);
  assert.equal(result.afterSwitch.length, 10);
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

test('a project + opens the new tab popup with that project directory without collapsing the project', async (t) => {
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
