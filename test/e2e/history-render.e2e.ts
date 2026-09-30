import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chromium } from 'playwright';
import type { JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent';

type ToolExecutionEvent = Extract<JsonAgentSessionEvent, { type: 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end' }>;
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
        message: { role: 'toolResult', toolCallId: `tool-${pad(i)}`, content: [{ type: 'text', text: `tool-result-${pad(i)}` }] },
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
      return { count: document.querySelectorAll('#messages > .message, #messages > .tool-card').length };
    },
    LAST_MARKER,
    { timeout: 30000 }
  );
  const countAtFirstPaint = (await handle.jsonValue())!;

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
  const broadcast = (event: ToolExecutionEvent | { type: 'auto_compaction_start'; parentToolCallId: string }) => liveManager.broadcast({ type: 'event', sessionId: session.id, event });
  broadcast({ type: 'tool_execution_start', toolCallId, toolName: 'codemode', args: { code: 'tools.read()' } });
  await card.waitFor({ state: 'attached' });
  broadcast({ type: 'tool_execution_update', toolCallId, toolName: 'codemode', args: { code: 'tools.read()' }, partialResult: { content: [{ type: 'text', text: 'root partial output' }], details: {} } });
  await page.waitForFunction((id: string) =>
    document.querySelector(`.tool-card[data-tool-call-id="${id}"] .tool-output`)?.textContent === 'root partial output', toolCallId);

  const parentToolCallId = toolCallId;
  broadcast({ type: 'tool_execution_start', parentToolCallId, toolCallId: 'nested-read', toolName: 'read', args: { path: '/tmp/nested.txt' } });
  broadcast({ type: 'tool_execution_update', parentToolCallId, toolCallId: 'nested-read', toolName: 'read', args: { path: '/tmp/nested.txt' }, partialResult: { content: [{ type: 'text', text: 'nested output' }], details: {} } });
  broadcast({ type: 'tool_execution_end', parentToolCallId, toolCallId: 'nested-read', toolName: 'read', result: { content: [{ type: 'text', text: 'nested output' }], details: {} }, isError: false });
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

  const result = { content: [{ type: 'text', text: 'root final output' }], details: {} } satisfies Pick<ToolResultMessage, 'content' | 'details'>;
  broadcast({ type: 'tool_execution_end', toolCallId, toolName: 'codemode', result, isError: false });
  await page.waitForFunction((id: string) =>
    document.querySelector(`.tool-card[data-tool-call-id="${id}"] .tool-output`)?.textContent === 'root final output', toolCallId);
  const liveIds = await page.locator('#messages > .tool-card').evaluateAll(cards => cards.map(card => card.getAttribute('data-tool-call-id')));

  session.entries.push(
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: toolCallId, name: 'codemode', arguments: { code: 'tools.read()' } }] } },
    { type: 'message', message: { role: 'toolResult', toolCallId, toolName: 'codemode', ...result, isError: false, timestamp: Date.now(),
      nestedCalls: { complete: true, calls: [{ id: 'nested-read', name: 'read', arguments: { path: '/tmp/nested.txt' }, status: 'ok' }] } } satisfies ToolResultMessage }
  );
  await page.reload();
  await card.waitFor({ state: 'attached' });
  assert.deepEqual(await page.locator('#messages > .tool-card').evaluateAll(cards => cards.map(card => card.getAttribute('data-tool-call-id'))), liveIds);
  assert.equal(await card.locator('.tool-output').textContent(), 'root final output');
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
  }

  await assertNoPageErrors(errors);
});
