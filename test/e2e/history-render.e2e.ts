import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chromium } from 'playwright';
import type { JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent';

type ToolResultMessage = Extract<Extract<JsonAgentSessionEvent, { type: 'message_end' }>['message'], { role: 'toolResult' }>;

// Real-browser test of the progressive session-history render: it drives the
// actual UI against the in-process server, with the pi child process mocked
// the same way test/http-routes.test.ts does. Run via `npm run test:e2e`
// (scripts/e2e.sh provides Playwright browsers through Nix when needed); the
// suite skips itself when no browser install is available.

// Loopback host; isolate session/settings dirs before requiring the server.
process.env.TAU_HOST = '127.0.0.1';
process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-e2e-'));
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions');
process.env.TAU_PROJECTS_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'projects');

// Load the server after the env is in place: the module reads it at load
// time, and ESM hoists static imports ahead of this body.
const { server, computeUrls, SESSIONS_DIR, liveManager, _setSpawnPiForTest, _setExecFileForTest } = (await import('../../bin/tau.js')) as any;
import type { TestContext } from 'node:test';
import type { Browser, BrowserContext, Page } from 'playwright';

let base = '';
let browser: Browser | null = null;
let browserUnavailable = '';
const contexts: BrowserContext[] = [];

const PROJ_DIR = path.join(SESSIONS_DIR, '--tmp--e2eproj');

// Same realistic fake `pi` child as test/http-routes.test.ts: real streams so
// the RPC wiring works, an EventEmitter so error/exit listeners resolve.
function makeFakeChild() {
  const child: any = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12345;
  child.kill = () => {};
  return child;
}

// ── Fixtures ──────────────────────────────────────────────────────────────
// Session A: a large conversation. Every round is user + assistant; every
// 5th round the assistant also issues a tool call whose result arrives as a
// separate toolResult entry (so pairing must survive chunked rendering).
const ROUNDS = 700;
const TOOL_EVERY = 5;
const LAST_USAGE = { input: 12000, cacheRead: 30000, cost: { total: 0.001 } };
// user + assistant per round, plus one toolCall item per tool round.
const TOTAL_ITEMS = ROUNDS * 2 + Math.ceil(ROUNDS / TOOL_EVERY);
const LAST_MARKER = `msg-asst-${String(ROUNDS - 1).padStart(4, '0')}`;

function buildLargeSession(cwd: string) {
  const pad = (i: number) => String(i).padStart(4, '0');
  const entries: Array<Record<string, unknown>> = [
    { type: 'session', id: 'e2e-large', timestamp: '2026-01-01T00:00:00.000Z', cwd },
  ];
  for (let i = 0; i < ROUNDS; i++) {
    entries.push({ type: 'message', message: { role: 'user', content: `msg-user-${pad(i)} question with *markdown* and $x_${i}$` } });
    const blocks: Array<Record<string, unknown>> = [{ type: 'text', text: `msg-asst-${pad(i)} **answer**` }];
    if (i % TOOL_EVERY === 0) {
      blocks.push({ type: 'toolCall', id: `tool-${pad(i)}`, name: 'bash', arguments: { command: `echo round ${i}` } });
    }
    const usage = i === ROUNDS - 1 ? LAST_USAGE : { input: 100 + i, cost: { total: 0.001 } };
    entries.push({ type: 'message', message: { role: 'assistant', content: blocks, usage } });
    if (i % TOOL_EVERY === 0) {
      entries.push({
        type: 'message',
        message: {
          role: 'toolResult', toolCallId: `tool-${pad(i)}`, toolName: 'bash',
          content: [{ type: 'text', text: `tool-result-${pad(i)}` }], isError: false, timestamp: i,
          nestedCalls: { complete: true, calls: [
            { id: `tool-${pad(i)}/1`, name: 'read', arguments: { path: `/tmp/round-${i}.txt` }, status: 'ok', durationMs: 12 },
            { id: `tool-${pad(i)}/1/1`, name: 'bash', arguments: { command: `echo nested ${i}` }, status: 'ok', durationMs: 4 },
          ] },
        } satisfies ToolResultMessage,
      });
    }
  }
  entries.push({ type: 'session_info', name: 'Large E2E Session' });
  return entries;
}

// Session B: small, with distinct markers (must not share a substring with
// session A's markers — the switch test asserts A's text is fully gone).
const B_ROUNDS = 3;
function buildSmallSession(cwd: string) {
  const entries: Array<Record<string, unknown>> = [
    { type: 'session', id: 'e2e-small', timestamp: '2026-01-02T00:00:00.000Z', cwd },
  ];
  for (let i = 0; i < B_ROUNDS; i++) {
    entries.push({ type: 'message', message: { role: 'user', content: `other-user-${i}` } });
    entries.push({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: `other-asst-${i}` }] } });
  }
  entries.push({ type: 'session_info', name: 'Small E2E Session' });
  return entries;
}

function writeSession(fileName: string, lines: Array<Record<string, unknown>>) {
  fs.mkdirSync(PROJ_DIR, { recursive: true });
  const filePath = path.join(PROJ_DIR, fileName);
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return filePath;
}

let largeFile = '';
let smallFile = '';

// ── Page helpers ──────────────────────────────────────────────────────────

// Fresh incognito context per test: clears localStorage so the app never
// auto-restores the previous test's active session. CPU throttling makes the
// progressive fill reliably span many frames even on fast machines, so the
// "tail painted before full history" window is wide enough to observe.
type OpenPageOptions = { forceManualScrollAnchoring?: boolean };

async function openPage(options: OpenPageOptions = {}) {
  const context = await browser!.newContext();
  contexts.push(context);
  if (options.forceManualScrollAnchoring) {
    await context.addInitScript(() => {
      const nativeSupports = CSS.supports.bind(CSS);
      Object.defineProperty(CSS, 'supports', {
        configurable: true,
        value: (property: string, value?: string) =>
          property === 'overflow-anchor'
            ? false
            : (value === undefined ? nativeSupports(property) : nativeSupports(property, value)),
      });
    });
  }
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (err: Error) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg: { type: () => string; text: () => string }) => {
    // Network 404s (favicons etc.) surface as console errors too; only
    // uncaught exceptions and explicit console.error calls matter here.
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) {
      errors.push(`console.error: ${msg.text()}`);
    }
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto(base);
  if (options.forceManualScrollAnchoring) {
    // Chromium normally applies native anchoring even when app code takes the
    // manual branch. Disable it so this page behaves like stable Safari.
    await page.addStyleTag({ content: '.messages { overflow-anchor: none !important; }' });
  }
  await page.waitForSelector('.session-item', { timeout: 15000 });
  return { page, errors };
}

function sessionItemSelector(filePath: string) {
  return `.session-item[data-file-path="${path.resolve(filePath)}"]`;
}

async function assertNoPageErrors(errors: string[]) {
  assert.deepEqual(errors, []);
}

async function assertProgressiveFillPreservesReadingPosition(page: Page, mode: string) {
  await page.click(sessionItemSelector(largeFile));
  await page.waitForFunction(
    (marker: string) => document.getElementById('messages')?.textContent?.includes(marker),
    LAST_MARKER,
    { timeout: 30000 }
  );
  // Let the app's one-time jump-to-bottom finish first; anchoring before it
  // would race a scroll the app performs by design on open.
  await page.waitForFunction(() => {
    const el = document.getElementById('messages')!;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 10;
  }, undefined, { timeout: 5000 });

  // Anchor on the oldest currently-rendered message (top of the synchronous
  // tail) while chunks are still prepending above it.
  const before = await page.evaluate(() => {
    const el = document.querySelector('#messages > .message');
    el!.scrollIntoView({ behavior: 'instant', block: 'start' });
    return { marker: el!.textContent!.slice(0, 40), top: el!.getBoundingClientRect().top };
  });

  await page.waitForFunction(
    (expected: number) =>
      document.querySelectorAll('#messages > .message, #messages > .tool-card').length === expected,
    TOTAL_ITEMS,
    { timeout: 60000 }
  );

  const afterTop = await page.evaluate((marker: string) => {
    const nodes = document.querySelectorAll('#messages > .message');
    for (const el of nodes) {
      if (el.textContent!.slice(0, 40) === marker) return el.getBoundingClientRect().top;
    }
    return null;
  }, before.marker);

  assert.notEqual(afterTop, null, 'anchored message disappeared');
  assert.ok(Math.abs((afterTop as number) - before.top) <= 3,
    `anchored message moved from ${before.top} to ${afterTop} with ${mode}`);
}

// ── Setup / teardown ──────────────────────────────────────────────────────

before(async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-e2e-cwd-'));
  largeFile = writeSession('large.jsonl', buildLargeSession(cwd));
  smallFile = writeSession('small.jsonl', buildSmallSession(cwd));

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

let nestedFixtureNumber = 0;

async function openNestedPage() {
  const number = ++nestedFixtureNumber;
  const entries = buildSmallSession(fs.mkdtempSync(path.join(os.tmpdir(), 'tau-e2e-nested-cwd-')));
  entries[0].id = `nested-${number}`;
  const file = writeSession(`nested-${number}.jsonl`, entries);
  const { page, errors } = await openPage();
  await page.click(sessionItemSelector(file));
  await page.waitForFunction((expected: number) =>
    document.querySelectorAll('#messages > .message').length === expected, B_ROUNDS * 2);
  const session = liveManager.findBySessionFile(file);
  assert.ok(session);
  const id = `owner/with/slashes-${number}`;
  const card = page.locator(`.tool-card[data-tool-call-id="${id}"]`);
  const broadcast = (event: JsonAgentSessionEvent) => liveManager.broadcast({ type: 'event', sessionId: session.id, event });
  const start = (suffix = '', parentToolCallId?: string, toolName = 'read', args = { path: '/tmp/child.txt' }) =>
    broadcast({ type: 'tool_execution_start', toolCallId: id + suffix, toolName, args, ...(parentToolCallId ? { parentToolCallId } : {}) });
  const end = (suffix = '', parentToolCallId?: string, isError = false, text = 'private child output') =>
    broadcast({ type: 'tool_execution_end', toolCallId: id + suffix, toolName: suffix ? 'read' : 'codemode',
      result: { content: [{ type: 'text', text }], details: {} }, isError, ...(parentToolCallId ? { parentToolCallId } : {}) });
  const finish = (nestedCalls: NonNullable<ToolResultMessage['nestedCalls']>, text = 'parent result') => {
    const message = { role: 'toolResult', toolCallId: id, toolName: 'codemode',
      content: [{ type: 'text', text }], isError: false, timestamp: Date.now(), nestedCalls,
    } satisfies ToolResultMessage;
    broadcast({ type: 'message_end', message });
    return message;
  };
  return { page, errors, file, session, id, card, broadcast, start, end, finish };
}

async function toolCommand(page: Page, label: 'Expand All Tools' | 'Collapse All Tools') {
  await page.click('#command-btn');
  await page.locator('.command-item').filter({ hasText: label }).click();
}

function skipUnlessBrowser(t: TestContext) {
  if (!browser) {
    t.skip(browserUnavailable);
    return true;
  }
  return false;
}

// ── Tests ─────────────────────────────────────────────────────────────────

test('opening a large session paints the newest messages first, pinned to the bottom', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage();

  await page.click(sessionItemSelector(largeFile));

  // Capture the rendered count at the exact poll where the newest message
  // first exists — inside waitForFunction, so no extra round-trip skews it.
  const handle = await page.waitForFunction(
    (marker: string) => {
      const container = document.getElementById('messages');
      if (!container || !container.textContent!.includes(marker)) return null;
      return {
        count: document.querySelectorAll('#messages > .message, #messages > .tool-card').length,
        newestCalls: document.querySelectorAll('.tool-card[data-tool-call-id="tool-0695"] .nested-call-row').length,
      };
    },
    LAST_MARKER,
    { timeout: 30000 }
  );
  const countAtFirstPaint = (await handle.jsonValue())!;
  assert.equal(countAtFirstPaint.newestCalls, 2, 'the newest nested record must paint with its parent');

  assert.ok(
    countAtFirstPaint.count < TOTAL_ITEMS / 2,
    `expected the newest message to paint while most history is still pending, but ${countAtFirstPaint.count} of ${TOTAL_ITEMS} items were already rendered`
  );

  // Pinned to the bottom (the jump-to-bottom happens on the next frame).
  await page.waitForFunction(() => {
    const el = document.getElementById('messages')!;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 10;
  }, undefined, { timeout: 5000 });

  // The context pill must be correct immediately — computed by the pure
  // pre-pass, not accumulated during the (still running) progressive fill.
  const pill = await page.waitForSelector('#context-pill.visible', { timeout: 5000 });
  const pillText = (await pill.textContent())?.trim() || '';
  assert.match(pillText, /^(42\.0k|<1%|\d+%)$/);

  await assertNoPageErrors(errors);
});

test('older history fills in above until the whole session is rendered, in order', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage();

  await page.click(sessionItemSelector(largeFile));
  await page.waitForFunction(
    (expected: number) =>
      document.querySelectorAll('#messages > .message, #messages > .tool-card').length === expected,
    TOTAL_ITEMS,
    { timeout: 60000 }
  );

  const { firstText, lastText } = await page.evaluate(() => {
    const nodes = document.querySelectorAll('#messages > .message, #messages > .tool-card');
    return {
      firstText: nodes[0]?.textContent || '',
      lastText: nodes[nodes.length - 1]?.textContent || '',
    };
  });
  assert.match(firstText, /msg-user-0000/);
  assert.ok(lastText.includes(LAST_MARKER), `last element should be the newest message, got: ${lastText.slice(0, 80)}`);

  await assertNoPageErrors(errors);
});

test('prepending older chunks preserves the reading position', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage();

  await assertProgressiveFillPreservesReadingPosition(page, 'native scroll anchoring');
  await assertNoPageErrors(errors);
});

test('manual anchoring preserves the reading position when native anchoring is unavailable', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage({ forceManualScrollAnchoring: true });

  await assertProgressiveFillPreservesReadingPosition(page, 'manual scroll anchoring');
  await assertNoPageErrors(errors);
});

test('Expand All Tools also expands cards rendered by later history chunks', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage();

  await page.click(sessionItemSelector(largeFile));
  await page.waitForFunction(
    (marker: string) => document.getElementById('messages')?.textContent?.includes(marker),
    LAST_MARKER,
    { timeout: 30000 }
  );

  const countWhenExpanded = await page.evaluate(() => {
    const count = document.querySelectorAll('#messages > .message, #messages > .tool-card').length;
    document.getElementById('command-btn')!.click();
    const command = Array.from(document.querySelectorAll<HTMLElement>('.command-item'))
      .find((item) => item.textContent?.includes('Expand All Tools'));
    command!.click();
    return count;
  });
  assert.ok(countWhenExpanded < TOTAL_ITEMS, 'Expand All must run while older cards are still pending');

  await page.waitForFunction(
    (expected: number) =>
      document.querySelectorAll('#messages > .message, #messages > .tool-card').length === expected,
    TOTAL_ITEMS,
    { timeout: 60000 }
  );

  const cardState = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('#messages > .tool-card'));
    return {
      total: cards.length,
      expanded: cards.filter((card) => card.querySelector('.tool-card-body')?.classList.contains('expanded')).length,
    };
  });
  assert.ok(cardState.total > 1, 'fixture should contain tool cards across multiple chunks');
  assert.equal(cardState.expanded, cardState.total, 'deferred tool cards ignored Expand All Tools');
  assert.equal(await page.locator('.nested-calls-toggle[aria-expanded="true"]').count(), cardState.total);
  assert.equal(await page.locator('.nested-call-toggle[aria-expanded="true"]').count(), 0, 'Expand All keeps row details closed');
  assert.equal(await page.locator('.nested-call-details pre').count(), 0, 'history arguments are built on demand');
  await toolCommand(page, 'Collapse All Tools');
  assert.equal(await page.locator('.tool-card-body.expanded').count(), 0);
  assert.equal(await page.locator('.nested-calls-toggle[aria-expanded="true"]').count(), 0);

  await assertNoPageErrors(errors);
});

test('Collapse All Tools also closes calls rendered by deferred history chunks', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage();
  await page.click(sessionItemSelector(largeFile));
  await page.waitForFunction((marker: string) => document.getElementById('messages')?.textContent?.includes(marker), LAST_MARKER, { timeout: 30000 });
  const count = await page.evaluate(() => {
    const count = document.querySelectorAll('#messages > .message, #messages > .tool-card').length;
    for (const label of ['Expand All Tools', 'Collapse All Tools']) {
      document.getElementById('command-btn')!.click();
      Array.from(document.querySelectorAll<HTMLElement>('.command-item')).find(item => item.textContent?.includes(label))!.click();
    }
    return count;
  });
  assert.ok(count < TOTAL_ITEMS, 'Collapse All must run while older cards are pending');
  await page.waitForFunction((expected: number) =>
    document.querySelectorAll('#messages > .message, #messages > .tool-card').length === expected, TOTAL_ITEMS, { timeout: 60000 });
  assert.equal(await page.locator('.tool-card-body.expanded').count(), 0);
  assert.equal(await page.locator('.nested-calls-toggle[aria-expanded="true"]').count(), 0);
  assert.equal(await page.locator('.nested-call-details pre').count(), 0);
  await assertNoPageErrors(errors);
});

test('switching sessions mid-fill cancels the old render completely', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage();

  await page.click(sessionItemSelector(largeFile));
  await page.waitForFunction(
    (marker: string) => document.getElementById('messages')?.textContent?.includes(marker),
    LAST_MARKER,
    { timeout: 30000 }
  );

  // Switch away while older chunks are still streaming in.
  await page.click(sessionItemSelector(smallFile));
  await page.waitForFunction(
    (expected: number) => {
      const container = document.getElementById('messages');
      return !!container?.textContent?.includes(`other-asst-${expected - 1}`);
    },
    B_ROUNDS,
    { timeout: 30000 }
  );

  // Give any stale (buggy) chunk callbacks a chance to fire, then verify no
  // session-A content leaked into the session-B conversation.
  await page.waitForTimeout(1500);
  const { hasStale, count } = await page.evaluate(() => {
    const container = document.getElementById('messages')!;
    return {
      hasStale: /msg-user-|msg-asst-|tool-result-/.test(container.textContent || ''),
      count: document.querySelectorAll('#messages > .message, #messages > .tool-card').length,
    };
  });
  assert.equal(hasStale, false, 'session A content leaked into session B');
  assert.equal(count, B_ROUNDS * 2);

  await assertNoPageErrors(errors);
});

test('scroll to bottom reaches a large live tool card created off-screen', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage();

  await page.click(sessionItemSelector(largeFile));
  await page.waitForFunction(
    (expected: number) =>
      document.querySelectorAll('#messages > .message, #messages > .tool-card').length === expected,
    TOTAL_ITEMS,
    { timeout: 60000 }
  );

  await page.evaluate(() => {
    document.getElementById('messages')!.scrollTop = 0;
  });
  await page.waitForSelector('#scroll-bottom-btn:not(.hidden)');

  const session = liveManager.findBySessionFile(largeFile);
  assert.ok(session, 'large fixture should have a resumed live session');
  const toolCallId = 'live-large-tool';
  const marker = 'live-tool-args-final-line';
  liveManager.broadcast({
    type: 'event',
    sessionId: session.id,
    event: {
      type: 'tool_execution_start',
      toolCallId,
      toolName: 'write',
      args: { path: '/tmp/large.txt', content: `${'large argument line\n'.repeat(1000)}${marker}` },
    },
  });
  await page.waitForSelector(`.tool-card[data-tool-call-id="${toolCallId}"]`, { state: 'attached' });
  await page.waitForFunction(
    ({ id, text }: { id: string; text: string }) =>
      document.querySelector(`.tool-card[data-tool-call-id="${id}"]`)?.textContent?.includes(text),
    { id: toolCallId, text: marker }
  );
  // Give content-visibility two frames to classify the new bottom card as
  // off-screen without forcing a layout measurement of the card itself.
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  ));
  const liveCardContentVisibility = await page.evaluate((id: string) => {
    const card = document.querySelector(`.tool-card[data-tool-call-id="${id}"]`)!;
    return getComputedStyle(card).contentVisibility;
  }, toolCallId);
  assert.equal(liveCardContentVisibility, 'visible', 'live tool cards must remain fully laid out off-screen');

  await page.click('#scroll-bottom-btn');
  await page.waitForFunction(() => {
    const el = document.getElementById('messages')!;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 10;
  }, undefined, { timeout: 5000 });

  await assertNoPageErrors(errors);
});

test('nested tool events leave root cards unchanged and match reloaded history', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage();
  await page.click(sessionItemSelector(smallFile));
  await page.waitForFunction((expected: number) =>
    document.querySelectorAll('#messages > .message').length === expected, B_ROUNDS * 2);

  const session = liveManager.findBySessionFile(smallFile);
  assert.ok(session, 'small fixture should have a resumed live session');
  const toolCallId = 'root-with-nested-calls';
  const card = page.locator(`.tool-card[data-tool-call-id="${toolCallId}"]`);
  const broadcast = (event: JsonAgentSessionEvent | { type: 'auto_compaction_start'; parentToolCallId: string }) => liveManager.broadcast({ type: 'event', sessionId: session.id, event });
  broadcast({ type: 'tool_execution_start', toolCallId, toolName: 'codemode', args: { code: 'tools.read()' } });
  await card.waitFor({ state: 'attached' });
  broadcast({ type: 'tool_execution_update', toolCallId, toolName: 'codemode', args: { code: 'tools.read()' }, partialResult: { content: [{ type: 'text', text: 'root partial output' }], details: {} } });
  await page.waitForFunction((id: string) =>
    document.querySelector(`.tool-card[data-tool-call-id="${id}"] .tool-output`)?.textContent === 'root partial output', toolCallId);

  const parentToolCallId = toolCallId;
  broadcast({ type: 'tool_execution_start', parentToolCallId, toolCallId: `${toolCallId}/1`, toolName: 'read', args: { path: '/tmp/nested.txt' } });
  broadcast({ type: 'tool_execution_update', parentToolCallId, toolCallId: `${toolCallId}/1`, toolName: 'read', args: { path: '/tmp/nested.txt' }, partialResult: { content: [{ type: 'text', text: 'nested output' }], details: {} } });
  broadcast({ type: 'tool_execution_end', parentToolCallId, toolCallId: `${toolCallId}/1`, toolName: 'read', result: { content: [{ type: 'text', text: 'nested output' }], details: {} }, isError: false });
  // Reusing an existing card ID also checks that nested updates and completions
  // cannot change a root card, independently of the nested-start guard.
  broadcast({ type: 'tool_execution_update', parentToolCallId, toolCallId, toolName: 'read', args: { path: '/tmp/nested.txt' }, partialResult: { content: [{ type: 'text', text: 'nested overwrite' }], details: {} } });
  broadcast({ type: 'tool_execution_end', parentToolCallId, toolCallId, toolName: 'read', result: { content: [{ type: 'text', text: 'nested overwrite' }], details: {} }, isError: true });
  // This ordered event confirms that the browser consumed the nested events
  // and still handles other event types carrying the parent field.
  broadcast({ type: 'auto_compaction_start', parentToolCallId });
  await page.waitForSelector('#compaction-indicator');
  assert.equal(await page.locator('#messages > .tool-card').count(), 1);
  assert.equal(await card.locator('.tool-output').textContent(), 'root partial output');
  assert.equal(await card.locator('.nested-calls').count(), 1);
  assert.equal(await card.locator('.nested-call-row').count(), 1);
  assert.equal(await card.locator('.nested-call-name').textContent(), 'read');
  assert.equal(await card.locator('.nested-call-status').textContent(), 'succeeded');
  assert.ok(!(await page.locator('#messages').textContent())?.includes('nested output'));
  assert.ok(!(await page.locator('#messages').textContent())?.includes('nested overwrite'));

  const result = { content: [{ type: 'text', text: 'root final output' }], details: {} } satisfies Pick<ToolResultMessage, 'content' | 'details'>;
  broadcast({ type: 'tool_execution_end', toolCallId, toolName: 'codemode', result, isError: false });
  await page.waitForFunction((id: string) =>
    document.querySelector(`.tool-card[data-tool-call-id="${id}"] .tool-output`)?.textContent === 'root final output', toolCallId);
  const finalMessage = { role: 'toolResult', toolCallId, toolName: 'codemode', ...result, isError: false, timestamp: Date.now(),
    nestedCalls: { complete: true, calls: [{ id: `${toolCallId}/1`, name: 'read', arguments: { path: '/tmp/nested.txt' }, status: 'ok', durationMs: 17 }] },
  } satisfies ToolResultMessage;
  broadcast({ type: 'message_end', message: finalMessage });
  await page.waitForFunction((id: string) =>
    document.querySelector(`.tool-card[data-tool-call-id="${id}"] .nested-call-duration`)?.textContent === '17 ms', toolCallId);
  assert.equal(await card.locator('.nested-calls-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await card.locator('.nested-calls-list').isVisible(), false);
  const liveIds = await page.locator('#messages > .tool-card').evaluateAll(cards => cards.map(card => card.getAttribute('data-tool-call-id')));

  session.entries.push(
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: toolCallId, name: 'codemode', arguments: { code: 'tools.read()' } }] } },
    { type: 'message', message: { role: 'toolResult', toolCallId, toolName: 'codemode', ...result, isError: false, timestamp: Date.now(),
      nestedCalls: { complete: true, calls: [{ id: `${toolCallId}/1`, name: 'read', arguments: { path: '/tmp/nested.txt' }, status: 'ok', durationMs: 17 }] } } satisfies ToolResultMessage }
  );
  await page.reload();
  await card.waitFor({ state: 'attached' });
  assert.deepEqual(await page.locator('#messages > .tool-card').evaluateAll(cards => cards.map(card => card.getAttribute('data-tool-call-id'))), liveIds);
  assert.equal(await card.locator('.tool-output').textContent(), 'root final output');
  assert.equal(await card.locator('.nested-call-row').count(), 1);
  assert.equal(await card.locator('.nested-call-duration').textContent(), '17 ms');
  assert.equal(await card.locator('.nested-call-status').textContent(), 'succeeded');
  assert.equal(await card.locator('.nested-call-details pre').count(), 0, 'history details must be lazy');
  await card.locator('.tool-card-header').click();
  await card.locator('.nested-calls-toggle').click();
  await card.locator('.nested-call-toggle').click();
  assert.match(await card.locator('.nested-call-details').textContent() || '', /\/tmp\/nested\.txt/);
  assert.ok(!(await card.textContent())?.includes('nested output'));
  await assertNoPageErrors(errors);
});

test('tool results are paired onto their cards in both the newest and oldest chunks', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage();

  await page.click(sessionItemSelector(largeFile));
  await page.waitForFunction(
    (expected: number) =>
      document.querySelectorAll('#messages > .message, #messages > .tool-card').length === expected,
    TOTAL_ITEMS,
    { timeout: 60000 }
  );

  const pad = (i: number) => String(i).padStart(4, '0');
  const lastToolRound = Math.floor((ROUNDS - 1) / TOOL_EVERY) * TOOL_EVERY;
  for (const round of [0, lastToolRound]) {
    const id = `tool-${pad(round)}`;
    const output = await page.evaluate((toolCallId: string) => {
      const card = document.querySelector(`.tool-card[data-tool-call-id="${toolCallId}"]`);
      return card?.querySelector('.tool-output')?.textContent ?? null;
    }, id);
    assert.equal(output, `tool-result-${pad(round)}`, `result missing on card ${id}`);
    const card = page.locator(`.tool-card[data-tool-call-id="${id}"]`);
    assert.equal(await card.locator('.nested-calls').count(), 1);
    assert.deepEqual(await card.locator('.nested-call-row').evaluateAll(rows => rows.map(row => row.getAttribute('data-call-id'))), [id + '/1', id + '/1/1']);
    assert.deepEqual(await card.locator('.nested-call-duration').allTextContents(), ['12 ms', '4 ms']);
    assert.equal(await card.locator('.nested-calls-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await card.locator('.nested-call-details pre').count(), 0);
    assert.match(await card.locator('.nested-calls-indicator').textContent() || '', /2 succeeded/);
  }

  await assertNoPageErrors(errors);
});

test('live siblings keep start order and a handled failure remains visible after final reconciliation', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors, id, card, session, broadcast, start, end, finish } = await openNestedPage();
  start();
  await card.waitFor();
  start('/1', id);
  start('/2', id);
  start('/1/1', id + '/1');
  await card.locator('.nested-call-row').nth(2).waitFor();
  assert.equal(await card.locator('.tool-card-body').evaluate(el => el.classList.contains('expanded')), true);
  assert.equal(await card.locator('.nested-calls-toggle').getAttribute('aria-expanded'), 'true');
  assert.match(await card.locator('.nested-calls-notice').textContent() || '', /observed/i);
  assert.deepEqual(await card.locator('.nested-call-status').allTextContents(), ['running', 'running', 'running']);
  broadcast({ type: 'tool_execution_update', toolCallId: id + '/2', parentToolCallId: id, toolName: 'read', args: { path: '/tmp/child.txt' },
    partialResult: { content: [{ type: 'text', text: 'secret partial child output' }], details: {} } });
  end('/2', id, true, 'short child error');
  end('/1/1', id + '/1');
  end('/1', id);
  start('/1', id);
  await page.waitForFunction((root: string) =>
    document.querySelector(`.tool-card[data-tool-call-id="${root}"] .nested-call-row[data-call-id="${root}/2"] .nested-call-status`)?.textContent === 'failed', id);
  assert.deepEqual(await card.locator('.nested-call-row').evaluateAll(rows => rows.map(row => row.getAttribute('data-call-id'))), [id + '/1', id + '/1/1', id + '/2']);
  assert.ok(!(await card.textContent())?.includes('secret partial child output'));
  assert.ok(!(await card.textContent())?.includes('private child output'));
  end('', undefined, false, 'parent result');
  const nestedCalls = { complete: false, calls: [
    { id: id + '/1', name: 'read', arguments: { path: '/tmp/recorded.txt' }, status: 'ok', durationMs: 10 },
    { id: id + '/2', name: 'bash', argumentsBytes: 9000, status: 'error', durationMs: 31, error: '<script>short recorded error</script>' },
    { id: id + '/1/1', name: 'read', arguments: { path: '/tmp/deep.txt' }, status: 'ok', durationMs: 7 },
  ] } satisfies NonNullable<ToolResultMessage['nestedCalls']>;
  const message = finish(nestedCalls);
  await page.waitForFunction((root: string) =>
    document.querySelector(`.tool-card[data-tool-call-id="${root}"] .nested-call-duration`)?.textContent === '10 ms', id);
  assert.equal(await card.locator('.tool-status').textContent(), 'complete');
  assert.equal(await card.locator('.nested-calls-toggle').getAttribute('aria-expanded'), 'true');
  assert.match(await card.locator('.nested-calls-indicator').textContent() || '', /2 succeeded.*1 failed/);
  assert.match(await card.locator('.nested-calls-notice').textContent() || '', /incomplete/i);
  assert.match(await card.locator(`.nested-call-row[data-call-id="${id}/2"] .nested-call-preview`).textContent() || '', /omitted.*9000|9000.*omitted/i);
  assert.equal(await card.locator('.tool-output').textContent(), 'parent result');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { document.documentElement.dataset.copiedOutput = text; },
    } });
  });
  await card.locator('.copy-output-btn').click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.copiedOutput), 'parent result');
  const failed = card.locator(`.nested-call-row[data-call-id="${id}/2"]`);
  await failed.locator('.nested-call-toggle').click();
  assert.match(await failed.locator('.nested-call-details').textContent() || '', /<script>short recorded error<\/script>/);
  assert.equal(await failed.locator('script').count(), 0);
  await card.locator('.tool-card-header').click();
  assert.equal(await card.locator('.nested-calls-indicator').isVisible(), true);
  assert.match(await card.locator('.nested-calls-indicator').textContent() || '', /1 failed/);
  end('/2', id, false);
  finish(nestedCalls);
  session.entries.push(
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'codemode', arguments: { path: '/tmp/child.txt' } }] } },
    { type: 'message', message },
  );
  await page.reload();
  await card.waitFor({ state: 'attached' });
  assert.equal(await page.locator('#messages > .tool-card').count(), 1);
  assert.equal(await card.locator('.nested-call-row').count(), 3);
  assert.deepEqual(await card.locator('.nested-call-status').allTextContents(), ['succeeded', 'succeeded', 'failed']);
  assert.deepEqual(await card.locator('.nested-call-duration').allTextContents(), ['10 ms', '7 ms', '31 ms']);
  assert.equal(await card.locator('.nested-calls-toggle').getAttribute('aria-expanded'), 'false');
  assert.match(await card.locator('.nested-calls-notice').textContent() || '', /incomplete/i);
  assert.equal(await card.locator('.nested-call-details pre').count(), 0);
  await assertNoPageErrors(errors);
});

test('manual parent, calls, and row choices survive updates and completion', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors, id, card, start, end, finish } = await openNestedPage();
  start();
  start('/1', id);
  await card.locator('.nested-calls-toggle').waitFor();
  await card.locator('.nested-call-toggle').click();
  const details = card.locator('.nested-call-details pre').first();
  await details.evaluate(el => { el.setAttribute('data-retained-details', 'yes'); });
  await card.locator('.nested-calls-toggle').click();
  await card.locator('.tool-card-header').click();
  start('/2', id);
  end('/2', id, true, 'handled error');
  await page.waitForFunction((root: string) =>
    document.querySelectorAll(`.tool-card[data-tool-call-id="${root}"] .nested-call-row`).length === 2, id);
  assert.equal(await card.locator('.tool-card-body').evaluate(el => el.classList.contains('expanded')), false);
  assert.equal(await card.locator('.nested-calls-toggle').getAttribute('aria-expanded'), 'false');
  await toolCommand(page, 'Expand All Tools');
  assert.equal(await card.locator('.nested-calls-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(await details.getAttribute('data-retained-details'), 'yes', 'updates preserve the open details node');
  end('/1', id);
  end('', undefined, false, 'parent result');
  finish({ complete: true, calls: [
    { id: id + '/1', name: 'read', arguments: { path: '/tmp/child.txt' }, status: 'ok', durationMs: 3 },
    { id: id + '/2', name: 'read', arguments: { path: '/tmp/child.txt' }, status: 'ok', durationMs: 4 },
  ] });
  await page.waitForFunction((root: string) =>
    document.querySelector(`.tool-card[data-tool-call-id="${root}"] .nested-call-duration`)?.textContent === '3 ms', id);
  assert.equal(await card.locator('.nested-calls-toggle').getAttribute('aria-expanded'), 'true', 'Expand All remains a manual choice after clean completion');
  assert.equal(await card.locator('.nested-call-toggle').first().getAttribute('aria-expanded'), 'true');
  assert.equal(await card.locator('.nested-call-toggle').nth(1).getAttribute('aria-expanded'), 'false');
  await toolCommand(page, 'Collapse All Tools');
  assert.equal(await card.locator('.nested-calls-toggle').getAttribute('aria-expanded'), 'false');
  await assertNoPageErrors(errors);
});

test('a final record uses the known assistant definition when the root start was missed', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors, id, card, broadcast, start, end, finish } = await openNestedPage();
  broadcast({ type: 'message_end', message: {
    role: 'assistant', content: [{ type: 'toolCall', id, name: 'codemode', arguments: { code: 'known root arguments' } }],
    api: 'openai-completions', provider: 'test', model: 'test', stopReason: 'toolUse', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } });
  start('/1', id);
  end('/1', id);
  finish({ complete: false, calls: [
    { id: id + '/1', name: 'read', arguments: { path: '/tmp/missed-root.txt' }, status: 'ok', durationMs: 8 },
    { id: id + '/2/1', name: 'bash', arguments: { command: 'unobserved final call' }, status: 'unfinished' },
  ] });
  await card.locator('.nested-call-row').nth(1).waitFor({ state: 'attached' });
  assert.equal(await page.locator('#messages > .tool-card').count(), 1);
  assert.match(await card.textContent() || '', /known root arguments/);
  assert.deepEqual(await card.locator('.nested-call-status').allTextContents(), ['succeeded', 'unfinished']);
  assert.equal(await card.locator('.nested-call-row').count(), 2, 'missing intermediate calls are not invented');
  assert.equal(await card.locator('.tool-output').textContent(), 'parent result');
  await assertNoPageErrors(errors);
});

test('tool-result messages do not finalize assistant text or fabricate unknown parent cards', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors, id, card, broadcast, start } = await openNestedPage();
  start();
  const assistant = {
    role: 'assistant', content: [], api: 'openai-completions', provider: 'test', model: 'test',
    stopReason: 'pending', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } satisfies Extract<Extract<JsonAgentSessionEvent, { type: 'message_start' }>['message'], { role: 'assistant' }>;
  broadcast({ type: 'message_start', message: assistant });
  const partial = { ...assistant, content: [{ type: 'text' as const, text: 'assistant text' }] };
  broadcast({ type: 'message_update', usage: assistant.usage,
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'assistant text' } });
  await page.waitForFunction(() => document.querySelector('.message-content.streaming')?.textContent?.includes('assistant text'));
  const result = { role: 'toolResult', toolCallId: id, toolName: 'codemode',
    content: [{ type: 'text', text: 'separate parent output' }], isError: false, timestamp: Date.now(),
    usage: { ...assistant.usage, input: 999, cost: { ...assistant.usage.cost, total: 99 } },
    nestedCalls: { complete: true, calls: [{ id: id + '/1', name: 'read', status: 'ok', durationMs: 6 }] },
  } satisfies ToolResultMessage;
  broadcast({ type: 'message_end', message: { ...result, toolCallId: 'unknown-root' } });
  broadcast({ type: 'message_end', message: result });
  await page.waitForFunction((root: string) =>
    document.querySelector(`.tool-card[data-tool-call-id="${root}"] .tool-output`)?.textContent === 'separate parent output', id);
  assert.equal(await page.locator('#messages > .tool-card').count(), 1);
  assert.equal(await page.locator('.message-content.streaming').count(), 1);
  assert.equal(await page.locator('#messages > .message').last().locator('.message-usage').count(), 0);
  const continued = { ...partial, content: [{ type: 'text' as const, text: 'assistant text continues' }] };
  broadcast({ type: 'message_update', usage: assistant.usage,
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' continues' } });
  await page.waitForFunction(() => document.querySelector('.message-content.streaming')?.textContent?.includes('assistant text continues'));
  broadcast({ type: 'message_end', message: { ...continued, stopReason: 'stop' } });
  await page.waitForFunction(() => document.querySelectorAll('.message-content.streaming').length === 0);
  assert.equal(await card.locator('.tool-output').textContent(), 'separate parent output');
  await assertNoPageErrors(errors);
});

test('unobserved final records and empty incomplete records have honest notices', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors, id, card, start, end, finish, broadcast } = await openNestedPage();
  start();
  end('', undefined, false, 'parent result');
  finish({ complete: false, calls: [] });
  await card.locator('.nested-calls').waitFor({ state: 'attached' });
  assert.equal(await card.locator('.nested-call-row').count(), 0);
  assert.match(await card.locator('.nested-calls-notice').textContent() || '', /incomplete/i);
  const second = id + '-unobserved';
  broadcast({ type: 'tool_execution_start', toolCallId: second, toolName: 'codemode', args: { code: 'unobserved' } });
  broadcast({ type: 'message_end', message: { role: 'toolResult', toolCallId: second, toolName: 'codemode',
    content: [{ type: 'text', text: 'second parent output' }], isError: false, timestamp: Date.now(),
    nestedCalls: { complete: true, calls: [{ id: second + '/1', name: 'read', status: 'ok', durationMs: 19 }] },
  } });
  const secondCard = page.locator(`.tool-card[data-tool-call-id="${second}"]`);
  await secondCard.locator('.nested-call-row').waitFor({ state: 'attached' });
  assert.equal(await secondCard.locator('.nested-call-status').textContent(), 'succeeded');
  assert.equal(await secondCard.locator('.nested-call-duration').textContent(), '19 ms');
  assert.equal(await page.locator('#messages > .tool-card').count(), 2);
  await assertNoPageErrors(errors);
});

test('parent completion and interruption mark observed running children unfinished', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors, id, card, session, start, end, broadcast, finish } = await openNestedPage();
  start();
  start('/1', id);
  await card.locator('.nested-call-row').waitFor();
  end('', undefined, false, 'parent result');
  await page.waitForFunction((root: string) =>
    document.querySelector(`.tool-card[data-tool-call-id="${root}"] .nested-call-status`)?.textContent === 'unfinished', id);
  assert.equal(await card.locator('.nested-calls-toggle').getAttribute('aria-expanded'), 'true');
  assert.match(await card.locator('.nested-calls-notice').textContent() || '', /observed/i);
  const interrupted = id + '-interrupted';
  broadcast({ type: 'tool_execution_start', toolCallId: interrupted, toolName: 'codemode', args: {} });
  broadcast({ type: 'tool_execution_start', toolCallId: interrupted + '/1', parentToolCallId: interrupted, toolName: 'read', args: {} });
  await page.locator(`.tool-card[data-tool-call-id="${interrupted}"] .nested-call-row`).waitFor();
  liveManager.broadcast({ type: 'event', sessionId: session.id, event: { type: 'agent_settled' } });
  await page.waitForFunction((root: string) =>
    document.querySelector(`.tool-card[data-tool-call-id="${root}"] .nested-call-status`)?.textContent === 'unfinished', interrupted);
  finish({ complete: true, calls: [{ id: id + '/1', name: 'read', status: 'ok', durationMs: 2 }] });
  await page.waitForFunction((root: string) =>
    document.querySelector(`.tool-card[data-tool-call-id="${root}"] .nested-call-status`)?.textContent === 'succeeded', id);
  await assertNoPageErrors(errors);
});

test('session changes discard buffered children and ignore background events', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors, id, card, session, start, end } = await openNestedPage();
  start();
  start('/1', id);
  await card.locator('.nested-call-row').waitFor();
  start('-buffered/1', id + '-buffered');
  await page.click(sessionItemSelector(smallFile));
  await page.waitForFunction(() => document.getElementById('messages')?.textContent?.includes('other-asst-2'));
  const active = liveManager.findBySessionFile(smallFile);
  assert.ok(active);
  liveManager.broadcast({ type: 'event', sessionId: active.id, event: { type: 'tool_execution_start', toolCallId: id, toolName: 'codemode', args: {} } satisfies JsonAgentSessionEvent });
  await card.waitFor();
  end('/1', id, true, 'background error');
  start('/2', id);
  liveManager.broadcast({ type: 'event', sessionId: active.id, event: { type: 'tool_execution_update', toolCallId: id, toolName: 'codemode', args: {}, partialResult: { content: [{ type: 'text', text: 'active session fence' }], details: {} } } satisfies JsonAgentSessionEvent });
  await page.waitForFunction((root: string) =>
    document.querySelector(`.tool-card[data-tool-call-id="${root}"] .tool-output`)?.textContent === 'active session fence', id);
  assert.equal(await card.locator('.nested-call-row').count(), 0);
  assert.ok(!(await page.locator('#messages').textContent())?.includes('background error'));
  liveManager.broadcast({ type: 'event', sessionId: active.id, event: { type: 'tool_execution_start', toolCallId: id + '-buffered', toolName: 'codemode', args: {} } satisfies JsonAgentSessionEvent });
  await page.locator(`.tool-card[data-tool-call-id="${id}-buffered"]`).waitFor();
  assert.equal(await page.locator(`.tool-card[data-tool-call-id="${id}-buffered"] .nested-call-row`).count(), 0);
  assert.notEqual(active.id, session.id);
  await assertNoPageErrors(errors);
});

test('nested controls work with a keyboard on a narrow screen', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors, id, card, start, end, finish } = await openNestedPage();
  await page.setViewportSize({ width: 375, height: 740 });
  start();
  start('/1', id, 'read-' + 'long-name-'.repeat(20), { path: '/tmp/' + 'long-path/'.repeat(30) });
  await card.locator('.nested-calls-toggle').waitFor();
  const toggle = card.locator('.nested-calls-toggle');
  await toggle.focus();
  await page.keyboard.press('Enter');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await card.locator('.nested-calls-list').isVisible(), false);
  await page.keyboard.press('Space');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  await card.locator('.nested-call-toggle').focus();
  await page.keyboard.press('Enter');
  assert.equal(await card.locator('.nested-call-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(await card.locator('.nested-call-details').isVisible(), true);
  const bounds = await card.locator('.nested-call-status').evaluate(el => {
    const status = el.getBoundingClientRect();
    const owner = el.closest('.tool-card')!.getBoundingClientRect();
    return { statusLeft: status.left, statusRight: status.right, left: owner.left, right: owner.right };
  });
  assert.ok(bounds.statusLeft >= bounds.left && bounds.statusRight <= bounds.right + 1, 'long names leave status inside the card');
  end('/1', id);
  end('', undefined, false, 'parent result');
  finish({ complete: true, calls: [{ id: id + '/1', name: 'read', arguments: { path: '/tmp/child.txt' }, status: 'ok', durationMs: 5 }] });
  await assertNoPageErrors(errors);
});

test('unfinished snapshot calls open for live children without reopening completed history', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors, id, card, session, start, end, finish, broadcast } = await openNestedPage();
  const manual = id + '-manual';
  const completed = [id + '-old', id + '-saved'];
  session.entries.push({ type: 'message', message: { role: 'assistant', content: [id, manual, ...completed].map(root => ({
    type: 'toolCall', id: root, name: 'codemode', arguments: { code: 'snapshot arguments' },
  })) } });
  for (const root of completed) {
    session.entries.push({ type: 'message', message: {
      role: 'toolResult', toolCallId: root, toolName: 'codemode', content: [], isError: false, timestamp: Date.now(),
      ...(root.endsWith('-saved') ? { nestedCalls: { complete: true, calls: [{ id: root + '/1', name: 'read', status: 'ok' }] } } : {}),
    } });
  }
  session.isStreaming = true;
  await page.reload();
  await card.waitFor({ state: 'attached' });
  await page.waitForFunction(() => document.querySelectorAll('#messages > .tool-card').length === 4);
  assert.equal(await card.locator('.tool-card-body.expanded').count(), 0);
  // Opening and closing the snapshot card records an explicit manual choice.
  const manualCard = page.locator(`.tool-card[data-tool-call-id="${manual}"]`);
  await manualCard.locator('.tool-card-header').click();
  await manualCard.locator('.tool-card-header').click();
  start('/1', id);
  broadcast({ type: 'tool_execution_start', toolCallId: manual + '/1', parentToolCallId: manual, toolName: 'read', args: {} });
  for (const root of completed) {
    broadcast({ type: 'tool_execution_start', toolCallId: root + '/2', parentToolCallId: root, toolName: 'read', args: {} });
  }
  await card.locator('.nested-call-row').waitFor({ state: 'attached' });
  await manualCard.locator('.nested-call-row').waitFor({ state: 'attached' });
  assert.equal(await card.locator('.tool-card-body.expanded').count(), 1);
  assert.equal(await card.locator('.nested-calls-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(await card.locator('.tool-status').textContent(), 'pending');
  assert.equal(await manualCard.locator('.tool-card-body.expanded').count(), 0);
  end('/1', id, true, 'handled snapshot failure');
  end('', undefined, false, 'parent result');
  finish({ complete: true, calls: [{ id: id + '/1', name: 'read', status: 'error', error: 'handled snapshot failure', durationMs: 9 }] });
  await page.waitForFunction((root: string) =>
    document.querySelector(`.tool-card[data-tool-call-id="${root}"] .nested-call-duration`)?.textContent === '9 ms', id);
  assert.equal(await card.locator('.tool-status').textContent(), 'complete');
  assert.equal(await card.locator('.tool-card-body.expanded').count(), 1);
  assert.equal(await card.locator('.nested-calls-toggle').getAttribute('aria-expanded'), 'true');
  assert.match(await card.locator('.nested-calls-indicator').textContent() || '', /1 failed/);
  for (const [index, root] of completed.entries()) {
    const old = page.locator(`.tool-card[data-tool-call-id="${root}"]`);
    assert.equal(await old.locator('.tool-card-body.expanded').count(), 0);
    assert.equal(await old.locator('.nested-call-row').count(), index);
  }
  assert.equal(await page.locator('#messages > .tool-card').count(), 4);
  await assertNoPageErrors(errors);
});

test('live children received before a deferred snapshot card still open that card', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors, id, card, session, broadcast, start } = await openNestedPage();
  session.entries.push({ type: 'message', message: { role: 'assistant', content: [
    { type: 'toolCall', id, name: 'codemode', arguments: { code: 'deferred root' } },
  ] } });
  for (let n = 0; n < 100; n++) session.entries.push({ type: 'message', message: { role: 'user', content: `deferred-padding-${n}` } });
  await page.addInitScript(() => {
    const callbacks: IdleRequestCallback[] = [];
    window.requestIdleCallback = callback => { callbacks.push(callback); return callbacks.length; };
    Object.assign(window, { finishHistory: () => {
      while (callbacks.length) callbacks.shift()!({ didTimeout: false, timeRemaining: () => 100 });
    } });
  });
  await page.reload();
  await page.waitForFunction(() => document.getElementById('messages')?.textContent?.includes('deferred-padding-99'));
  assert.equal(await card.count(), 0);
  start('/1', id);
  broadcast({ type: 'tool_execution_start', toolCallId: id + '-fence', toolName: 'read', args: {} });
  await page.locator(`.tool-card[data-tool-call-id="${id}-fence"]`).waitFor({ state: 'attached' });
  await page.evaluate(() => (window as unknown as { finishHistory: () => void }).finishHistory());
  await card.waitFor({ state: 'attached' });
  assert.equal(await card.locator('.nested-call-status').textContent(), 'running');
  assert.equal(await card.locator('.tool-card-body.expanded').count(), 1);
  assert.equal(await card.locator('.nested-calls-toggle').getAttribute('aria-expanded'), 'true');
  await assertNoPageErrors(errors);
});

test('a reader at the bottom follows child rows across small and large live updates', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors, id, card, start } = await openNestedPage();
  await page.setViewportSize({ width: 800, height: 450 });
  await page.addStyleTag({ content: '.messages { scroll-behavior: auto !important; }' });
  start();
  await card.waitFor({ state: 'attached' });
  await page.evaluate(() => {
    const el = document.getElementById('messages')!;
    el.scrollTop = el.scrollHeight;
  });
  for (const count of [1, 2, 30, 31, 32]) {
    const first = count === 30 ? 3 : count;
    for (let n = first; n <= count; n++) start(`/${n}`, id);
    await page.waitForFunction(({ root, count }) =>
      document.querySelectorAll(`.tool-card[data-tool-call-id="${root}"] .nested-call-row`).length === count, { root: id, count });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const gap = await page.evaluate(() => {
      const el = document.getElementById('messages')!;
      return el.scrollHeight - el.scrollTop - el.clientHeight;
    });
    assert.ok(gap <= 3, `${count} child rows left the reader ${gap} pixels above the bottom`);
  }
  assert.equal(await card.locator('.tool-status').textContent(), 'pending');
  await assertNoPageErrors(errors);
});

test('pending bottom scrolls respect a reader scroll and conversation clearing', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage();
  const positions = await page.evaluate(async () => {
    const { ToolCardRenderer } = await import(new URL('/tool-card.js', location.href).href);
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;top:0;left:0;width:500px;height:200px;overflow:auto;scroll-behavior:auto';
    const padding = document.createElement('div');
    padding.style.height = '1000px';
    container.appendChild(padding);
    document.body.appendChild(container);
    const renderer = new ToolCardRenderer(container);
    renderer.createToolCard({ toolCallId: 'scroll-root', toolName: 'codemode', args: {}, status: 'pending' });
    const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await frames();
    container.scrollTop = container.scrollHeight;
    renderer.observeNestedCall({ type: 'tool_execution_start', toolCallId: 'scroll-root/1', parentToolCallId: 'scroll-root', toolName: 'read', args: {} });
    container.scrollTop = 0;
    await frames();
    const afterReaderScroll = container.scrollTop;
    container.scrollTop = container.scrollHeight;
    renderer.observeNestedCall({ type: 'tool_execution_start', toolCallId: 'scroll-root/2', parentToolCallId: 'scroll-root', toolName: 'read', args: {} });
    renderer.clear();
    container.replaceChildren(padding);
    container.scrollTop = 77;
    await frames();
    const afterClear = container.scrollTop;
    container.remove();
    return { afterReaderScroll, afterClear };
  });
  assert.deepEqual(positions, { afterReaderScroll: 0, afterClear: 77 });
  await assertNoPageErrors(errors);
});

test('an unrelated live root leaves completed history DOM untouched', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage();
  await page.click(sessionItemSelector(largeFile));
  await page.waitForFunction((expected: number) =>
    document.querySelectorAll('#messages > .message, #messages > .tool-card').length === expected, TOTAL_ITEMS, { timeout: 60000 });
  await page.evaluate(() => {
    let mutations = 0;
    const observer = new MutationObserver(records => { mutations += records.length; });
    document.querySelectorAll('.tool-card.history').forEach(card => observer.observe(card, {
      attributes: true, childList: true, characterData: true, subtree: true,
    }));
    Object.assign(window, { historyMutationCount: () => { observer.disconnect(); return mutations; } });
  });
  const session = liveManager.findBySessionFile(largeFile);
  const id = 'unrelated-history-root';
  liveManager.broadcast({ type: 'event', sessionId: session.id, event: {
    type: 'tool_execution_start', toolCallId: id, toolName: 'codemode', args: {},
  } satisfies JsonAgentSessionEvent });
  await page.locator(`.tool-card[data-tool-call-id="${id}"]`).waitFor({ state: 'attached' });
  assert.equal(await page.evaluate(() => (window as unknown as { historyMutationCount: () => number }).historyMutationCount()), 0);
  assert.equal(await page.locator('.tool-card.history').count(), Math.ceil(ROUNDS / TOOL_EVERY));
  await assertNoPageErrors(errors);
});

test('nested updates do not move a reader scrolled above a live parent', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage();
  await page.click(sessionItemSelector(largeFile));
  await page.waitForFunction((expected: number) =>
    document.querySelectorAll('#messages > .message, #messages > .tool-card').length === expected, TOTAL_ITEMS, { timeout: 60000 });
  const session = liveManager.findBySessionFile(largeFile);
  assert.ok(session);
  await page.waitForFunction(() => {
    const el = document.getElementById('messages')!;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 10;
  });
  const anchor = page.locator('#messages > .message').first();
  await anchor.evaluate(el => el.scrollIntoView({ behavior: 'instant', block: 'start' }));
  await page.waitForSelector('#scroll-bottom-btn:not(.hidden)');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const before = await anchor.evaluate(el => el.getBoundingClientRect().top);
  const id = 'offscreen-nested-parent';
  const broadcast = (event: JsonAgentSessionEvent) => liveManager.broadcast({ type: 'event', sessionId: session.id, event });
  broadcast({ type: 'tool_execution_start', toolCallId: id, toolName: 'codemode', args: {} });
  broadcast({ type: 'tool_execution_start', toolCallId: id + '/1', parentToolCallId: id, toolName: 'read', args: { path: '/tmp/offscreen.txt' } });
  broadcast({ type: 'tool_execution_update', toolCallId: id + '/1', parentToolCallId: id, toolName: 'read', args: {}, partialResult: { content: [{ type: 'text', text: 'offscreen child secret' }], details: {} } });
  broadcast({ type: 'tool_execution_end', toolCallId: id + '/1', parentToolCallId: id, toolName: 'read', result: { content: [{ type: 'text', text: 'offscreen child secret' }], details: {} }, isError: false });
  await page.waitForFunction((root: string) =>
    document.querySelector(`.tool-card[data-tool-call-id="${root}"] .nested-call-status`)?.textContent === 'succeeded', id);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const after = await anchor.evaluate(el => el.getBoundingClientRect().top);
  assert.ok(Math.abs(after - before) <= 3, `nested events moved the reading anchor from ${before} to ${after}`);
  assert.ok(!(await page.locator('#messages').textContent())?.includes('offscreen child secret'));
  await assertNoPageErrors(errors);
});
