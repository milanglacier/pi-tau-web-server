import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chromium } from 'playwright';
import type { TestContext } from 'node:test';
import type { Browser, Page } from 'playwright';
import type { JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent';

// Shared setup for the real-browser tests of session history and tool cards.
// They drive the actual UI against the in-process server, with the pi child
// process mocked the same way test/http-routes.test.ts does. Run them via
// `npm run test:e2e` (scripts/e2e.sh provides Playwright browsers through Nix
// when needed); each test skips itself when no browser install is available.
//
// Each test file runs in its own process, so every file that imports this
// module gets its own server, session directories, and browser. Call
// `setupHistoryE2E()` once at the top level of the test file.

export type ToolResultMessage = Extract<Extract<JsonAgentSessionEvent, { type: 'message_end' }>['message'], { role: 'toolResult' }>;

// Loopback host; isolate session/settings dirs before loading the server.
process.env.TAU_HOST = '127.0.0.1';
process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-e2e-'));
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions');
process.env.TAU_PROJECTS_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'projects');

// Load the server after the env is in place: the module reads it at load
// time, and ESM hoists static imports ahead of this body.
const tau = (await import('../../bin/tau.js')) as any;
const { server, computeUrls, SESSIONS_DIR, _setSpawnPiForTest, _setExecFileForTest } = tau;
export const liveManager = tau.liveManager;

let base = '';
let browser: Browser | null = null;
let browserUnavailable = '';

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
export const ROUNDS = 700;
export const TOOL_EVERY = 5;
const LAST_USAGE = { input: 12000, cacheRead: 30000, cost: { total: 0.001 } };
// user + assistant per round, plus one toolCall item per tool round.
export const TOTAL_ITEMS = ROUNDS * 2 + Math.ceil(ROUNDS / TOOL_EVERY);
export const LAST_MARKER = `msg-asst-${String(ROUNDS - 1).padStart(4, '0')}`;

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
export const B_ROUNDS = 3;
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

export let largeFile = '';
export let smallFile = '';

// ── Setup / teardown ──────────────────────────────────────────────────────

export function setupHistoryE2E() {
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
    if (browser) await browser.close().catch(() => {});
    await liveManager.shutdown();
    _setSpawnPiForTest(null);
    _setExecFileForTest(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
}

export function skipUnlessBrowser(t: TestContext) {
  if (!browser) {
    t.skip(browserUnavailable);
    return true;
  }
  return false;
}

// ── Page helpers ──────────────────────────────────────────────────────────

// Each test gets a fresh incognito context, closed when the test ends. A
// fresh context clears localStorage, so the app never auto-restores the
// previous test's active session. Closing it disconnects the page, so it
// does not keep rendering broadcasts meant for later tests.
//
// `throttleCpu` slows the page 4x. Tests that must observe the history while
// it is still filling need it, because it makes the progressive fill span
// many frames even on fast machines.
export type OpenPageOptions = { forceManualScrollAnchoring?: boolean; blockServiceWorkers?: boolean; throttleCpu?: boolean };

export async function openPage(t: TestContext, options: OpenPageOptions = {}) {
  const context = await browser!.newContext({ serviceWorkers: options.blockServiceWorkers ? 'block' : 'allow' });
  t.after(() => context.close());
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
  if (options.throttleCpu) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  }
  await page.goto(base);
  if (options.forceManualScrollAnchoring) {
    // Chromium normally applies native anchoring even when app code takes the
    // manual branch. Disable it so this page behaves like stable Safari.
    await page.addStyleTag({ content: '.messages { overflow-anchor: none !important; }' });
  }
  await page.waitForSelector('.session-item', { timeout: 15000 });
  return { page, errors };
}

export function sessionItemSelector(filePath: string) {
  return `.session-item[data-file-path="${path.resolve(filePath)}"]`;
}

export async function assertNoPageErrors(errors: string[]) {
  assert.deepEqual(errors, []);
}

let nestedFixtureNumber = 0;

// Opens a fresh small session and returns helpers that broadcast live tool
// events for one root tool call whose id contains slashes.
export async function openNestedPage(t: TestContext, options: OpenPageOptions = {}) {
  const number = ++nestedFixtureNumber;
  const entries = buildSmallSession(fs.mkdtempSync(path.join(os.tmpdir(), 'tau-e2e-nested-cwd-')));
  entries[0].id = `nested-${number}`;
  const file = writeSession(`nested-${number}.jsonl`, entries);
  const { page, errors } = await openPage(t, options);
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

export async function toolCommand(page: Page, label: 'Expand All Tools' | 'Collapse All Tools') {
  await page.click('#command-btn');
  await page.locator('.command-item').filter({ hasText: label }).click();
}
