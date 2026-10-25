import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent';
import {
  setupHistoryE2E,
  skipUnlessBrowser,
  openPage,
  openNestedPage,
  sessionItemSelector,
  assertNoPageErrors,
  toolCommand,
  liveManager,
  smallFile,
  B_ROUNDS,
} from './history-harness.ts';
import type { ToolResultMessage } from './history-harness.ts';

// Real-browser tests of nested tool calls shown inside a parent tool card:
// live updates, final reconciliation, manual open and closed choices, session
// changes, and scrolling while child rows arrive.

setupHistoryE2E();

test('nested tool events leave root cards unchanged and match reloaded history', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage(t);
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

test('live siblings keep start order and a handled failure remains visible after final reconciliation', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors, id, card, session, broadcast, start, end, finish } = await openNestedPage(t);
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
  const { page, errors, id, card, start, end, finish } = await openNestedPage(t);
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
  const { page, errors, id, card, broadcast, start, end, finish } = await openNestedPage(t);
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
  const { page, errors, id, card, broadcast, start } = await openNestedPage(t);
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
  const { page, errors, id, card, start, end, finish, broadcast } = await openNestedPage(t);
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
  const { page, errors, id, card, session, start, end, broadcast, finish } = await openNestedPage(t);
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
  const { page, errors, id, card, session, start, end } = await openNestedPage(t);
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
  const { page, errors, id, card, start, end, finish } = await openNestedPage(t);
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
  const { page, errors, id, card, session, start, end, finish, broadcast } = await openNestedPage(t);
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
  const { page, errors, id, card, session, broadcast, start } = await openNestedPage(t);
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
  const { page, errors, id, card, start } = await openNestedPage(t);
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
  const { page, errors } = await openPage(t);
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
