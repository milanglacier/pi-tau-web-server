import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import type { TestContext } from 'node:test';
import type { Page } from 'playwright';
import type { JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent';
import {
  setupHistoryE2E,
  skipUnlessBrowser,
  openPage,
  sessionItemSelector,
  assertNoPageErrors,
  writeSession,
  liveManager,
  largeFile,
  smallFile,
  TOTAL_ITEMS,
  LAST_MARKER,
  B_ROUNDS,
} from './history-harness.ts';

// Real-browser tests of switching between open tabs. A tab this browser
// already showed keeps its built conversation while hidden, so switching back
// neither downloads nor rebuilds it, and events that arrive while it is
// hidden are applied when it is shown again.

setupHistoryE2E();

const ITEMS = '#messages > .message, #messages > .tool-card';

function writeChat(name: string, rounds = 3) {
  const entries: Array<Record<string, unknown>> = [
    { type: 'session', id: name, timestamp: '2026-01-03T00:00:00.000Z', cwd: os.tmpdir() },
  ];
  for (let i = 0; i < rounds; i++) {
    entries.push({ type: 'message', message: { role: 'user', content: `${name}-user-${i}` } });
    entries.push({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: `${name}-asst-${i}` }] } });
  }
  return writeSession(`${name}.jsonl`, entries);
}

async function waitForText(page: Page, text: string) {
  await page.waitForFunction((expected: string) => document.getElementById('messages')?.textContent?.includes(expected), text, { timeout: 30000 });
}

function countSnapshotRequests(page: Page) {
  let count = 0;
  page.on('request', request => { if (request.url().includes('/snapshot')) count++; });
  return () => count;
}

const liveTab = (file: string) => `.live-tab[data-session-id="${liveManager.findBySessionFile(file).id}"]`;

// Marks the first shown message, so a test can tell whether the same
// elements come back or were built again.
const markFirstMessage = (page: Page) => page.evaluate(() => {
  document.querySelector<HTMLElement>('#messages > .message')!.dataset.kept = 'yes';
});
const firstMessageKept = (page: Page) => page.evaluate(() =>
  document.querySelector<HTMLElement>('#messages > .message')?.dataset.kept === 'yes');

test('switching back to a tab shows its kept conversation at the same scroll position without asking the server', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const a = writeChat('keep-a', 40);
  const b = writeChat('keep-b');
  const { page, errors } = await openPage(t);
  const snapshots = countSnapshotRequests(page);

  await page.click(sessionItemSelector(a));
  await page.waitForFunction((selector: string) => document.querySelectorAll(selector).length === 80, ITEMS);
  await markFirstMessage(page);
  const scrollTop = await page.evaluate(() => {
    const container = document.getElementById('messages')!;
    container.style.scrollBehavior = 'auto';
    container.scrollTop = 300;
    return container.scrollTop;
  });
  assert.equal(scrollTop, 300);

  await page.click(sessionItemSelector(b));
  await waitForText(page, 'keep-b-asst-2');
  assert.equal(await page.evaluate(() => /keep-a-/.test(document.getElementById('messages')!.textContent || '')), false);
  const requestsBefore = snapshots();

  await page.click(liveTab(a));
  await waitForText(page, 'keep-a-asst-39');
  assert.equal(await firstMessageKept(page), true, 'the conversation was built again');
  assert.equal(snapshots(), requestsBefore, 'switching back asked the server for the history again');
  assert.equal(await page.locator(ITEMS).count(), 80);
  assert.equal(await page.evaluate(() => /keep-b-/.test(document.getElementById('messages')!.textContent || '')), false);
  assert.ok(Math.abs(await page.evaluate(() => document.getElementById('messages')!.scrollTop) - 300) <= 2);

  // Selecting the shown tab again reloads it from the server.
  await page.click(liveTab(a));
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#messages > .message')?.dataset.kept !== 'yes');
  await waitForText(page, 'keep-a-asst-39');
  assert.equal(snapshots(), requestsBefore + 1);

  await assertNoPageErrors(errors);
});

test('a hidden tab shows the replies, tool output and streaming state it missed when shown again', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const a = writeChat('catch-a');
  const b = writeChat('catch-b');
  const { page, errors } = await openPage(t);
  const snapshots = countSnapshotRequests(page);

  await page.click(sessionItemSelector(a));
  await waitForText(page, 'catch-a-asst-2');
  await markFirstMessage(page);
  await page.click(sessionItemSelector(b));
  await waitForText(page, 'catch-b-asst-2');
  const requestsBefore = snapshots();

  const sessionId = liveManager.findBySessionFile(a).id;
  const send = (event: Record<string, unknown>) =>
    liveManager.broadcast({ type: 'event', sessionId, event: event as JsonAgentSessionEvent });
  const answer = 'catch-a-hidden-**answer**';
  send({ type: 'agent_start' });
  send({ type: 'message_start', message: { role: 'user', content: 'catch-a-hidden-question' } });
  send({ type: 'message_start', message: { role: 'assistant', content: [] } });
  for (const delta of ['catch-a-', 'hidden-', '**answer**']) {
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });
  }
  send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } });
  send({ type: 'tool_execution_start', toolCallId: 'catch-tool', toolName: 'bash', args: { command: 'echo caught' } });
  for (const text of ['partial one', 'partial two']) {
    send({ type: 'tool_execution_update', toolCallId: 'catch-tool', partialResult: { content: [{ type: 'text', text }] } });
  }
  send({ type: 'tool_execution_end', toolCallId: 'catch-tool', result: { content: [{ type: 'text', text: 'caught output' }] }, isError: false });
  // A second reply is still streaming when the tab is shown.
  send({ type: 'message_start', message: { role: 'assistant', content: [] } });
  send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'catch-a-still-' } });
  send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'streaming' } });
  await page.waitForSelector(`${liveTab(a)} .live-tab-streaming-dot`);
  assert.equal(await page.evaluate(() => /catch-a-/.test(document.getElementById('messages')!.textContent || '')), false);

  await page.click(liveTab(a));
  await waitForText(page, 'catch-a-still-streaming');
  assert.equal(await firstMessageKept(page), true, 'the conversation was built again');
  assert.equal(snapshots(), requestsBefore);
  const shown = await page.evaluate(() => {
    const messages = Array.from(document.querySelectorAll('#messages > .message'));
    return {
      questions: messages.filter(m => m.textContent?.includes('catch-a-hidden-question')).length,
      answer: messages.find(m => m.textContent?.includes('catch-a-hidden-answer'))?.querySelector('strong')?.textContent,
      output: document.querySelector('.tool-card[data-tool-call-id="catch-tool"] .tool-output')?.textContent,
      status: document.querySelector('.tool-card[data-tool-call-id="catch-tool"] .tool-status')?.textContent,
      streaming: !!document.querySelector('#messages > .message.assistant:last-child .message-content.streaming'),
      typing: !document.getElementById('typing-indicator')!.classList.contains('hidden'),
    };
  });
  assert.deepEqual(shown, { questions: 1, answer: 'answer', output: 'caught output', status: 'complete', streaming: true, typing: true });

  // The streaming reply keeps going in place once the tab is shown.
  send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '-done' } });
  await waitForText(page, 'catch-a-still-streaming-done');
  send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'catch-a-still-streaming-done' }] } });
  send({ type: 'agent_settled' });
  await page.waitForSelector('#typing-indicator.hidden', { state: 'attached' });
  assert.equal(await page.locator('#messages > .message.assistant .message-content.streaming').count(), 0);
  assert.equal(await page.locator(ITEMS).count(), 6 + 4);

  await assertNoPageErrors(errors);
});

test('a hidden tab whose history was replaced, as after a tree navigation, is built again from the server', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const a = writeChat('tree-a');
  const b = writeChat('tree-b');
  const { page, errors } = await openPage(t);
  const snapshots = countSnapshotRequests(page);

  await page.click(sessionItemSelector(a));
  await waitForText(page, 'tree-a-asst-2');
  await markFirstMessage(page);
  await page.click(sessionItemSelector(b));
  await waitForText(page, 'tree-b-asst-2');
  const requestsBefore = snapshots();

  const session = liveManager.findBySessionFile(a);
  liveManager.broadcast({ type: 'live_session_snapshot', sessionId: session.id, ...session.snapshot() });
  await page.click(liveTab(a));
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#messages > .message')?.dataset.kept !== 'yes');
  await waitForText(page, 'tree-a-asst-2');
  assert.equal(snapshots(), requestsBefore + 1);
  assert.equal(await page.locator(ITEMS).count(), 6);

  await assertNoPageErrors(errors);
});

test('a tab hidden while its older history was still filling in finishes the fill when shown again', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage(t, { throttleCpu: true });

  await page.click(sessionItemSelector(largeFile));
  await waitForText(page, LAST_MARKER);
  const countWhenHidden = await page.locator(ITEMS).count();
  await page.click(sessionItemSelector(smallFile));
  await waitForText(page, `other-asst-${B_ROUNDS - 1}`);
  assert.ok(countWhenHidden < TOTAL_ITEMS, 'the tab must be hidden while older history is still pending');

  await page.click(liveTab(largeFile));
  await page.waitForFunction((expected: number) =>
    document.querySelectorAll('#messages > .message, #messages > .tool-card').length === expected, TOTAL_ITEMS, { timeout: 60000 });
  const { first, last, other } = await page.evaluate(() => {
    const nodes = document.querySelectorAll('#messages > .message, #messages > .tool-card');
    return {
      first: nodes[0]?.textContent || '',
      last: nodes[nodes.length - 1]?.textContent || '',
      other: /other-user-|other-asst-/.test(document.getElementById('messages')!.textContent || ''),
    };
  });
  assert.match(first, /msg-user-0000/);
  assert.ok(last.includes(LAST_MARKER));
  assert.equal(other, false);

  await assertNoPageErrors(errors);
});
