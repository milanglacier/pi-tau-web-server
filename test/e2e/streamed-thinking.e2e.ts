import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { Page } from 'playwright';
import type { JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent';
import {
  setupHistoryE2E,
  skipUnlessBrowser,
  openNestedPage,
  assertNoPageErrors,
} from './history-harness.ts';

// Real-browser tests that streamed thinking stays inside the thinking block
// and never leaks into the assistant's main text.

setupHistoryE2E();

// Text of an assistant message that sits outside its thinking block.
async function textOutsideThinking(message: ReturnType<Page['locator']>) {
  return message.locator('.message-content').evaluate((el) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('.thinking-block').forEach((block) => block.remove());
    return copy.textContent?.trim() || '';
  });
}

type AssistantContent = Extract<Extract<JsonAgentSessionEvent, { type: 'message_end' }>['message'], { role: 'assistant' }>['content'];

// Each case streams the same thinking in small deltas, optionally with text
// before or after it, and then ends the message with the given final blocks.
const THINKING_CASES: Array<{ label: string; textBefore?: string; textAfter?: string; body: string }> = [
  { label: 'thinking followed only by a tool call', body: '' },
  { label: 'thinking followed by text', textAfter: 'visible answer', body: 'visible answer' },
  { label: 'text that arrives before the thinking', textBefore: 'early answer', body: 'early answer' },
];

for (const { label, textBefore, textAfter, body } of THINKING_CASES) {
  test(`streamed thinking stays inside the thinking block for ${label}`, async (t: TestContext) => {
    if (skipUnlessBrowser(t)) return;
    const { page, errors, broadcast } = await openNestedPage(t);
    const assistant = {
      role: 'assistant', content: [], api: 'openai-completions', provider: 'test', model: 'test',
      stopReason: 'pending', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    } satisfies Extract<Extract<JsonAgentSessionEvent, { type: 'message_start' }>['message'], { role: 'assistant' }>;
    const thinking = 'private reasoning that belongs only in the thinking block';
    const content: AssistantContent = [];
    const text = (delta: string) => broadcast({ type: 'message_update', usage: assistant.usage,
      assistantMessageEvent: { type: 'text_delta', contentIndex: content.length, delta } });

    broadcast({ type: 'message_start', message: assistant });
    if (textBefore) {
      text(textBefore);
      content.push({ type: 'text', text: textBefore });
    }
    for (const delta of thinking.match(/.{1,8}/g)!) {
      broadcast({ type: 'message_update', usage: assistant.usage,
        assistantMessageEvent: { type: 'thinking_delta', contentIndex: content.length, delta } });
    }
    content.push({ type: 'thinking', thinking });
    const message = page.locator('#messages > .message.assistant').last();
    await page.waitForFunction((expected: string) =>
      document.querySelector('.streaming-thinking .thinking-content')?.textContent === expected, thinking);
    assert.equal(await textOutsideThinking(message), textBefore || '', 'thinking leaked into the main text while streaming');

    if (textAfter) {
      text(textAfter);
      content.push({ type: 'text', text: textAfter });
    } else {
      content.push({ type: 'toolCall', id: 'thinking-only-call', name: 'bash', arguments: { command: 'ls' } });
    }
    broadcast({ type: 'message_end', message: { ...assistant, content, stopReason: textAfter ? 'stop' : 'toolUse' } });
    await page.waitForFunction(() => document.querySelectorAll('.message-content.streaming').length === 0);

    assert.equal(await message.locator('.thinking-block').count(), 1);
    assert.equal(await message.locator('.thinking-block .thinking-content').textContent(), thinking);
    assert.equal(await textOutsideThinking(message), body, 'thinking leaked into the main text after the message finished');
    await assertNoPageErrors(errors);
  });
}
