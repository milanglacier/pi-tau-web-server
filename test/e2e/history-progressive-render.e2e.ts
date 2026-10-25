import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { Page } from 'playwright';
import {
  setupHistoryE2E,
  skipUnlessBrowser,
  openPage,
  sessionItemSelector,
  assertNoPageErrors,
  toolCommand,
  largeFile,
  smallFile,
  TOTAL_ITEMS,
  LAST_MARKER,
  B_ROUNDS,
} from './history-harness.ts';

// Real-browser tests of the progressive session-history render: opening a
// large session paints the newest messages first, older history fills in
// above without moving the reader, and tool commands and session switches
// behave correctly while the fill is still running. These tests throttle the
// CPU so the fill spans many frames and the in-progress state is observable.

setupHistoryE2E();

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

test('opening a large session paints the newest messages first, pinned to the bottom', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage(t, { throttleCpu: true });

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
  const { page, errors } = await openPage(t);

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
  const { page, errors } = await openPage(t, { throttleCpu: true });

  await assertProgressiveFillPreservesReadingPosition(page, 'native scroll anchoring');
  await assertNoPageErrors(errors);
});

test('manual anchoring preserves the reading position when native anchoring is unavailable', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage(t, { forceManualScrollAnchoring: true, throttleCpu: true });

  await assertProgressiveFillPreservesReadingPosition(page, 'manual scroll anchoring');
  await assertNoPageErrors(errors);
});

test('Expand All Tools also expands cards rendered by later history chunks', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage(t, { throttleCpu: true });

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
  const { page, errors } = await openPage(t, { throttleCpu: true });
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
  const { page, errors } = await openPage(t, { throttleCpu: true });

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
