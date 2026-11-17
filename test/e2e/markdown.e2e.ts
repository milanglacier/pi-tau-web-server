import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupHistoryE2E,
  skipUnlessBrowser,
  openPage,
  assertNoPageErrors,
} from './history-harness.ts';

setupHistoryE2E();

test('checklist paragraphs and code stack below the label on desktop and mobile', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const command = `echo '${'long command argument '.repeat(12)}'`;
  const text = [
    '- [ ] **Run the test suite and check each reported failure**',
    '  Use this command:',
    '  ```sh',
    `  ${command}`,
    '  ```',
    '  Read the output before continuing.',
    '- [x] Finish the checklist',
  ].join('\n');
  const { page, errors } = await openPage(t);
  await page.evaluate(async (content) => {
    const { MessageRenderer } = await import(new URL('/message-renderer.js', location.href).href);
    const renderer = new MessageRenderer(document.getElementById('messages')!);
    renderer.renderAssistantMessage({ content });
  }, text);

  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 800 });
    const layout = await page.locator('.task-list-item').first().evaluate((item) => {
      const box = (selector: string) => {
        const rect = item.querySelector(selector)!.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width };
      };
      return {
        checkbox: box('input'),
        label: box('strong'),
        details: box('p'),
        code: box('.code-block-wrapper'),
        after: box('p:last-child'),
        itemRight: item.getBoundingClientRect().right,
      };
    });
    assert.ok(layout.details.top >= Math.max(layout.checkbox.bottom, layout.label.bottom), `${width}px: details must appear below the checkbox label`);
    assert.ok(layout.code.top >= layout.details.bottom, `${width}px: code must appear below the details`);
    assert.ok(layout.after.top >= layout.code.bottom, `${width}px: the last paragraph must appear below the code`);
    assert.ok(Math.abs(layout.code.left - layout.details.left) < 1, `${width}px: code and details must share a left edge`);
    assert.ok(layout.code.right <= layout.itemRight + 1, `${width}px: long code must stay inside its item`);
    assert.ok(layout.code.width >= layout.details.width - 1, `${width}px: code must use the available text width`);
    assert.equal(await page.locator('.task-list-item input').nth(1).isChecked(), true);
    assert.equal(await page.locator('.task-list-item pre code').textContent(), command);
  }
  await assertNoPageErrors(errors);
});
