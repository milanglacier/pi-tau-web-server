import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { CDPSession, Page } from 'playwright';
import type { JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent';
import {
  setupHistoryE2E,
  skipUnlessBrowser,
  openNestedPage,
  assertNoPageErrors,
} from './history-harness.ts';

// Real-browser tests that a reader can scroll away from a reply while it
// streams, and that the conversation follows new content again once the
// reader scrolls back to the bottom.

setupHistoryE2E();

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function distanceFromBottom(page: Page) {
  return page.evaluate(() => {
    const el = document.getElementById('messages')!;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  });
}

function scrollTop(page: Page) {
  return page.evaluate(() => document.getElementById('messages')!.scrollTop);
}

// Stream a reply that grows by a short line every 20ms until the test ends.
function streamReply(t: TestContext, broadcast: (event: JsonAgentSessionEvent) => void) {
  broadcast({ type: 'message_start', message: {
    role: 'assistant', content: [], api: 'openai-completions', provider: 'test', model: 'test',
    stopReason: 'pending', timestamp: Date.now(), usage } });
  let n = 0;
  const timer = setInterval(() => {
    n++;
    broadcast({ type: 'message_update', usage, assistantMessageEvent: {
      type: 'text_delta', contentIndex: 0, delta: n % 3 === 0 ? `word ${n}\n\n` : `word ${n} ` } } as JsonAgentSessionEvent);
  }, 20);
  t.after(() => clearInterval(timer));
}

// A finger drags down the page in small steps, which scrolls it up. It rests
// before lifting, so the page does not keep scrolling after the touch ends.
async function dragDown(cdp: CDPSession, page: Page, distance: number) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 400, y: 150 }] });
  for (let y = 155; y <= 150 + distance; y += 5) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 400, y }] });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(200);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

for (const input of ['mouse wheel', 'touch'] as const) {
  test(`a ${input} scroll up while a reply streams stays put, and scrolling back down follows the reply again`, async (t: TestContext) => {
    if (skipUnlessBrowser(t)) return;
    const { page, errors, broadcast } = await openNestedPage(t, { hasTouch: input === 'touch' });
    await page.setViewportSize({ width: 800, height: 500 });
    const cdp = await page.context().newCDPSession(page);
    streamReply(t, broadcast);
    await page.waitForFunction(() => {
      const el = document.getElementById('messages')!;
      return el.scrollHeight > el.clientHeight * 3 && el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
    });

    // Both inputs scroll in small steps, so each step is smaller than one
    // streamed line.
    if (input === 'touch') {
      await dragDown(cdp, page, 150);
    } else {
      await cdp.send('Input.synthesizeScrollGesture', {
        x: 400, y: 250, yDistance: 150, gestureSourceType: 'mouse', speed: 600,
      });
    }
    const top = await scrollTop(page);
    await page.waitForTimeout(300);
    assert.ok(Math.abs(await scrollTop(page) - top) <= 1, 'the streamed reply moved a reader who scrolled up');
    assert.ok(await distanceFromBottom(page) > 100, 'the scroll up was undone');
    await page.waitForSelector('#scroll-bottom-btn:not(.hidden)');

    await cdp.send('Input.synthesizeScrollGesture', {
      x: 400, y: 250, yDistance: -5000, gestureSourceType: 'mouse', speed: 20000,
    });
    // A reader who is not followed falls further behind with every line.
    await page.waitForTimeout(300);
    await page.waitForFunction(() => {
      const el = document.getElementById('messages')!;
      return el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
    }, undefined, { timeout: 2000 });
    await page.waitForSelector('#scroll-bottom-btn.hidden', { state: 'attached' });
    await assertNoPageErrors(errors);
  });
}
