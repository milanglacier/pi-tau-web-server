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
        if (command.type === 'prompt') {
          child.stdout.write(JSON.stringify({
            type: 'message_start', message: { role: 'user', content: command.message },
          }) + '\n');
        }
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
const projectNames = (page: Page) => page.locator('.project-group .project-header span[title]').allTextContents();
const liveTitles = (page: Page, name: string) => group(page, name).locator('.session-item.has-live-session .session-title').allTextContents();

/** Waits until the value read from the page matches, then asserts it. */
async function waitForEqual<T>(read: () => Promise<T>, expected: T) {
  const deadline = Date.now() + 5000;
  let actual = await read();
  while (JSON.stringify(actual) !== JSON.stringify(expected) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    actual = await read();
  }
  assert.deepEqual(actual, expected);
}

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

test('open sessions are listed first in their project with green dots, and their project moves to the top', async (t) => {
  const page = await openSidebar(t);
  if (!page) return;
  await waitForEqual(() => projectNames(page), ['small', 'big', 'trash']);
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
  // Both sessions are older than the 10 newest. The tab opened last is listed first.
  const oldest = await resume(12);
  const older = await resume(11);
  const bothOpen = ['big session 11', 'big session 12', ...Array.from({ length: 10 }, (_, i) => `big session ${i}`)];
  await waitForEqual(() => titles(page, 'big'), bothOpen);
  assert.deepEqual(await liveTitles(page, 'big'), ['big session 11', 'big session 12']);
  assert.deepEqual(await projectNames(page), ['big', 'small', 'trash']);
  assert.equal(await group(page, 'big').locator('.project-more-btn span:last-child').textContent(), `Show all ${BIG_COUNT}`);

  const activeTitle = group(page, 'big').locator('.session-item.active .session-title');
  await oldest.click();
  await activeTitle.filter({ hasText: 'big session 12' }).waitFor();
  assert.deepEqual(await titles(page, 'big'), bothOpen);

  await page.reload();
  await activeTitle.filter({ hasText: 'big session 12' }).waitFor();
  await waitForEqual(() => titles(page, 'big'), bothOpen);
  assert.deepEqual(await liveTitles(page, 'big'), ['big session 11', 'big session 12']);

  // A closed tab's session goes back to its place by file time.
  await older.locator('.live-tab-close').click();
  await waitForEqual(() => titles(page, 'big'), ['big session 12', ...Array.from({ length: 10 }, (_, i) => `big session ${i}`)]);
  assert.deepEqual(await liveTitles(page, 'big'), ['big session 12']);

  await oldest.locator('.live-tab-close').click();
  await page.waitForFunction(() => document.querySelectorAll('.live-tab').length === 0);
  await waitForEqual(() => titles(page, 'big'), Array.from({ length: 10 }, (_, i) => `big session ${i}`));
  assert.deepEqual(await liveTitles(page, 'big'), []);
  assert.equal(await activeTitle.count(), 0);
  assert.deepEqual(await projectNames(page), ['small', 'big', 'trash']);
});

test('a new tab with no session file yet shows a New session row with a green dot in its project', async (t) => {
  const page = await openSidebar(t);
  if (!page) return;
  await group(page, 'trash').locator('.project-add-btn').click();
  await page.waitForSelector('#new-live-session-modal:not(.hidden)');
  const createdResponse = page.waitForResponse(response => response.url() === `${base}/api/live-sessions` && response.request().method() === 'POST');
  await page.click('#new-live-session-submit');
  const { session } = await (await createdResponse).json() as { session: { id: string } };
  t.after(async () => { await fetch(`${base}/api/live-sessions/${session.id}`, { method: 'DELETE' }); });

  const row = group(page, 'trash').locator(`.session-item.has-live-session[data-live-session-id="${session.id}"]`);
  await row.waitFor();
  await page.waitForSelector(`.session-item.active[data-live-session-id="${session.id}"]`);
  assert.equal(await row.locator('.session-title').textContent(), 'New session');
  assert.equal((await titles(page, 'trash'))[0], 'New session');
  assert.equal((await projectNames(page))[0], 'trash');
  // The new tab counts toward the project's sessions.
  assert.equal(await group(page, 'trash').locator('.project-count').textContent(), String(TRASH_COUNT + 1));

  // Clicking the row switches back to its tab after another tab was opened.
  await group(page, 'small').locator('.session-title').filter({ hasText: 'small session 0' }).click();
  const resumed = page.locator('.live-tab.active').filter({ hasNotText: 'trash' });
  await resumed.waitFor();
  const resumedId = await resumed.getAttribute('data-session-id');
  t.after(async () => { await fetch(`${base}/api/live-sessions/${resumedId}`, { method: 'DELETE' }); });
  assert.equal(await row.evaluate(el => el.classList.contains('active')), false);
  await row.click();
  await page.waitForSelector(`.live-tab.active[data-session-id="${session.id}"]`);
  await page.waitForSelector(`.session-item.active[data-live-session-id="${session.id}"]`);

  await page.reload();
  await page.waitForSelector(`.session-item.active[data-live-session-id="${session.id}"]`);
  await page.fill('#session-search-input', 'New session');
  await page.waitForSelector(`.session-item.active[data-live-session-id="${session.id}"]`);
  await page.fill('#session-search-input', '');
  await page.waitForSelector(`.session-item.active[data-live-session-id="${session.id}"]`);

  await page.locator(`.live-tab[data-session-id="${session.id}"] .live-tab-close`).click();
  await row.waitFor({ state: 'detached' });
  await waitForEqual(() => projectNames(page), ['small', 'big', 'trash']);
});

test('switching between fileless tabs in the same project highlights only the selected row', async (t) => {
  const page = await openSidebar(t);
  if (!page) return;
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`${base}/api/live-sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: BIG }),
    });
    assert.equal(response.status, 200);
    const { session } = await response.json() as { session: { id: string } };
    ids.push(session.id);
    t.after(async () => { await fetch(`${base}/api/live-sessions/${session.id}`, { method: 'DELETE' }); });
  }
  const activeRows = group(page, 'big').locator('.session-item.active');
  for (const id of [ids[0], ids[1], ids[0]]) {
    await page.locator(`.live-tab[data-session-id="${id}"]`).click();
    await waitForEqual(() => activeRows.getAttribute('data-live-session-id'), id);
    assert.equal(await activeRows.count(), 1);
  }

  await page.locator(`.live-tab[data-session-id="${ids[0]}"] .live-tab-close`).click();
  await waitForEqual(() => activeRows.getAttribute('data-live-session-id'), ids[1]);
  await page.locator(`.live-tab[data-session-id="${ids[1]}"] .live-tab-close`).click();
  await page.waitForFunction(() => document.querySelectorAll('.live-tab').length === 0);
  assert.equal(await page.locator('.session-item.active').count(), 0);
});

test('automatic live-tab titles stay plain text before and after reload', async (t) => {
  const page = await openSidebar(t);
  if (!page) return;
  await group(page, 'big').locator('.project-add-btn').click();
  await page.waitForSelector('#new-live-session-modal:not(.hidden)');
  const createdResponse = page.waitForResponse(response => response.url() === `${base}/api/live-sessions` && response.request().method() === 'POST');
  await page.click('#new-live-session-submit');
  const { session } = await (await createdResponse).json() as { session: { id: string } };
  t.after(async () => { await fetch(`${base}/api/live-sessions/${session.id}`, { method: 'DELETE' }); });
  await page.waitForSelector(`.live-tab.active[data-session-id="${session.id}"]`);

  const prompt = 'Example" onmouseover="window.__sidebarTitleRan=1';
  await page.evaluate('window.__sidebarTitleRan = 0');
  await page.fill('#message-input', prompt);
  await page.press('#message-input', 'Enter');
  const title = group(page, 'big').locator(`.session-item[data-live-session-id="${session.id}"] .session-title`);
  await waitForEqual(() => title.textContent(), prompt);
  await title.hover();
  assert.equal(await page.evaluate('window.__sidebarTitleRan'), 0, 'hovering the title must not execute its text');
  assert.equal(await title.getAttribute('title'), prompt);
  assert.equal(await title.getAttribute('onmouseover'), null);

  await page.reload();
  await waitForEqual(() => title.textContent(), prompt);
  await page.evaluate('window.__sidebarTitleRan = 0');
  await title.hover();
  assert.equal(await page.evaluate('window.__sidebarTitleRan'), 0);
  assert.equal(await title.getAttribute('title'), prompt);
  assert.equal(await title.getAttribute('onmouseover'), null);
});

test('saved session titles stay plain text in projects, favourites, and search results', async (t) => {
  const prompt = 'Example" onmouseover="window.__sidebarTitleRan=1';
  const file = writeSession(SMALL, 'quoted-title', prompt, 1000);
  t.after(() => fs.rmSync(file, { force: true }));
  const page = await openSidebar(t);
  if (!page) return;
  await page.evaluate('window.__sidebarTitleRan = 0');

  const title = group(page, 'small').locator('.session-title').filter({ hasText: prompt });
  await title.hover();
  assert.equal(await page.evaluate('window.__sidebarTitleRan'), 0);
  assert.equal(await title.getAttribute('title'), prompt);
  await title.click({ button: 'right' });
  await page.click('.context-menu-item:has-text("Favourite")');
  const favourite = page.locator('.favourites-group .session-title');
  await favourite.hover();
  assert.equal(await page.evaluate('window.__sidebarTitleRan'), 0);
  assert.equal(await favourite.getAttribute('title'), prompt);

  await page.fill('#session-search-input', 'Example');
  const match = page.locator('.search-results-group .session-title');
  await match.waitFor();
  await match.hover();
  assert.equal(await page.evaluate('window.__sidebarTitleRan'), 0);
  assert.equal(await match.getAttribute('title'), prompt);
  assert.equal(await match.textContent(), prompt);
  assert.equal(await match.getAttribute('onmouseover'), null);
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
