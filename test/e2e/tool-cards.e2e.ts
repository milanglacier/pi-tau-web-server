import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import {
  setupHistoryE2E,
  skipUnlessBrowser,
  openPage,
  openNestedPage,
  assertNoPageErrors,
  toolCommand,
  B_ROUNDS,
} from './history-harness.ts';
import type { ToolResultMessage } from './history-harness.ts';

// Real-browser tests of tool-card rendering: codemode source, the built-in
// bash, edit, read, and write cards, and their layout on narrow screens, in
// live, nested, and reloaded history cards.

setupHistoryE2E();

test('codemode arguments are safe highlighted JavaScript in live and reloaded cards', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors, card, broadcast, id, session, finish } = await openNestedPage(t);
  const source = '// Read a file.\r\nconst result = await tools.read({ path: "file.txt" });\r\nconst markup = "<img src=x onerror=alert(1)>";\r\nconst fence = "```";\r\n\r\n';
  broadcast({ type: 'tool_execution_start', toolCallId: id, toolName: 'codemode', args: { code: source } });
  await card.waitFor({ state: 'attached' });
  const assertSource = async () => {
    assert.equal(await card.locator('.tool-args code').textContent(), source);
    assert.ok(await card.locator('.tool-args .hljs-keyword').count() > 0);
    assert.equal(await card.locator('.tool-args .code-block-header span').textContent(), 'JavaScript');
    assert.equal(await card.locator('.tool-args img, .tool-args script').count(), 0);
  };
  await assertSource();
  const liveHtml = await card.locator('.tool-args code').innerHTML();

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await card.locator('.tool-args .copy-btn').click();
  await page.waitForFunction(() => document.querySelector('.tool-args .copy-btn')?.textContent === 'Copied!');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), source);
  assert.equal(await card.locator('.tool-card-header').getAttribute('aria-expanded'), 'true');

  const result = finish({ complete: true, calls: [] }, 'Plain tool output <script>');
  session.entries.push(
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'codemode', arguments: { code: source } }] } },
    { type: 'message', message: result },
  );
  await page.reload();
  await card.waitFor({ state: 'attached' });
  await card.locator('.tool-card-header').click();
  await assertSource();
  assert.equal(await card.locator('.tool-args code').innerHTML(), liveHtml);
  assert.equal(await card.locator('.tool-output').textContent(), 'Plain tool output <script>');

  const keyword = card.locator('.tool-args .hljs-keyword').first();
  await page.evaluate(() => document.documentElement.dataset.theme = 'night');
  const darkColor = await keyword.evaluate(element => getComputedStyle(element).color);
  await page.evaluate(() => document.documentElement.dataset.theme = 'clean');
  const lightColor = await keyword.evaluate(element => getComputedStyle(element).color);
  assert.notEqual(lightColor, darkColor);
  assert.notEqual(lightColor, await card.locator('.tool-args code').evaluate(element => getComputedStyle(element).color));
  await page.setViewportSize({ width: 360, height: 740 });
  assert.equal(await card.evaluate(element => element.scrollWidth <= element.clientWidth), true);
  await assertNoPageErrors(errors);
});

test('codemode source stays readable and safe when highlighting assets cannot load', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors, card, broadcast, id } = await openNestedPage(t, { blockServiceWorkers: true });
  await page.route('**/vendor/highlight/*.js', route => route.abort());
  await page.reload();
  await page.waitForFunction((count: number) =>
    document.querySelectorAll('#messages > .message').length === count, B_ROUNDS * 2);
  const source = 'const html = "<img src=x onerror=alert(1)>";\nreturn "```";\n';
  broadcast({ type: 'tool_execution_start', toolCallId: id, toolName: 'codemode', args: { code: source } });
  await card.waitFor({ state: 'attached' });
  assert.equal(await card.locator('.tool-args code').textContent(), source);
  assert.equal(await card.locator('.tool-args code span, .tool-args img').count(), 0);
  await assertNoPageErrors(errors);
});

test('codemode argument fallbacks preserve JSON, empty code, and omitted nested notices', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openPage(t);
  const results = await page.evaluate(async () => {
    const { ToolCardRenderer } = await import(new URL('/tool-card.js', location.href).href);
    const host = document.createElement('div');
    document.getElementById('messages')!.appendChild(host);
    const renderer = new ToolCardRenderer(host);
    const cases = [
      { toolCallId: 'missing-code', toolName: 'codemode', args: { path: 'file.txt' } },
      { toolCallId: 'invalid-code', toolName: 'codemode', args: { code: 42 } },
      { toolCallId: 'empty-code', toolName: 'codemode', args: { code: '' } },
      { toolCallId: 'ordinary-tool', toolName: 'write', args: { code: 'const value = 1;' } },
      { toolCallId: 'edit-diff', toolName: 'edit', args: { oldText: 'old', newText: 'new' } },
    ];
    const rendered = cases.map(execution => {
      const card = renderer.createToolCard({ ...execution, status: 'pending' });
      const history = renderer.createHistoryCard({ ...execution, toolCallId: `${execution.toolCallId}-history` });
      return [card, history].map(element => ({
        args: element.querySelector('.tool-args')?.textContent,
        code: element.querySelector('code')?.textContent,
        diff: element.querySelector('.tool-diff')?.textContent,
      }));
    });
    renderer.reconcileToolResult('missing-code', { nestedCalls: { complete: false, calls: [
      { id: 'omitted', name: 'read', argumentsBytes: 100, status: 'ok' },
      { id: 'empty', name: 'read', arguments: {}, status: 'ok' },
    ] } }, false);
    for (const button of host.querySelectorAll<HTMLButtonElement>('.nested-call-toggle')) button.click();
    return { rendered, nested: Array.from(host.querySelectorAll('.nested-call-arguments'), el => el.textContent) };
  });
  for (const view of results.rendered[0]) assert.equal(view.args, JSON.stringify({ path: 'file.txt' }, null, 2));
  for (const view of results.rendered[1]) assert.equal(view.args, JSON.stringify({ code: 42 }, null, 2));
  for (const view of results.rendered[2]) assert.equal(view.code, '');
  for (const view of results.rendered[3]) assert.equal(view.args, JSON.stringify({ code: 'const value = 1;' }, null, 2));
  for (const view of results.rendered[4]) assert.equal(view.diff, '- old+ new');
  assert.deepEqual(results.nested, ['Arguments omitted (100 bytes)', '{}']);
  await assertNoPageErrors(errors);
});

test('built-in bash, edit, read, and write tool calls render cleanly in live, nested, and reloaded history cards with JSON fallbacks', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors, session, broadcast } = await openNestedPage(t);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  const bashCmd = '# Check files\nif [ -f "$HOME/.bashrc" ]; then\n  echo "found <script>"\nfi';
  const writeJsContent = 'const greeting = "hello\\nworld";\nexport default greeting;\n';
  const writeTxtContent = 'line one\nline two\n<img src=x onerror=alert(1)>';
  const editBlocks = [
    {
      oldText: 'const a = 1;\nconst b = 2;\nconst c = 3;',
      newText: 'const a = 1;\nconst b = 20;\nconst c = 3;',
    },
    {
      oldText: 'remove me',
      newText: '',
    },
  ];

  const toolCalls = [
    { id: 'builtin-bash-timeout', name: 'bash', arguments: { command: bashCmd, timeout: 30 } },
    { id: 'builtin-bash-plain', name: 'bash', arguments: { command: 'echo ok' } },
    { id: 'builtin-edit-multi', name: 'edit', arguments: { path: 'src/demo.ts', edits: editBlocks } },
    { id: 'builtin-read-range', name: 'read', arguments: { path: 'src/demo.ts', offset: 10, limit: 25 } },
    { id: 'builtin-write-js', name: 'write', arguments: { path: 'src/out.js', content: writeJsContent } },
    { id: 'builtin-write-txt', name: 'write', arguments: { path: 'notes/todo.txt', content: writeTxtContent } },
  ];

  for (const tc of toolCalls) {
    broadcast({ type: 'tool_execution_start', toolCallId: tc.id, toolName: tc.name, args: tc.arguments });
    broadcast({
      type: 'tool_execution_end',
      toolCallId: tc.id,
      toolName: tc.name,
      result: { content: [{ type: 'text', text: `${tc.id}-output` }], details: {} },
      isError: false,
    });
  }

  // Also test nested bash, edit, read, and write inside a codemode card
  const nestedRootId = 'builtin-nested-root';
  const nestedCallsList: NonNullable<ToolResultMessage['nestedCalls']>['calls'] = [
    { id: `${nestedRootId}/1`, name: 'bash', arguments: { command: bashCmd, timeout: 15 }, status: 'ok', durationMs: 11 },
    { id: `${nestedRootId}/2`, name: 'edit', arguments: { path: 'src/demo.ts', edits: editBlocks }, status: 'ok', durationMs: 14 },
    { id: `${nestedRootId}/3`, name: 'read', arguments: { path: 'src/demo.ts', offset: 10, limit: 25 }, status: 'ok', durationMs: 5 },
    { id: `${nestedRootId}/4`, name: 'write', arguments: { path: 'src/out.js', content: writeJsContent }, status: 'ok', durationMs: 8 },
  ];

  broadcast({ type: 'tool_execution_start', toolCallId: nestedRootId, toolName: 'codemode', args: { code: 'await tools.bash({ command: "echo hi" });' } });
  for (const nc of nestedCallsList) {
    broadcast({
      type: 'tool_execution_start',
      toolCallId: nc.id,
      parentToolCallId: nestedRootId,
      toolName: nc.name,
      args: nc.arguments,
    });
  }

  const nestedRootCard = page.locator(`.tool-card[data-tool-call-id="${nestedRootId}"]`);
  await nestedRootCard.locator('.nested-call-row').nth(3).waitFor({ state: 'attached' });

  // Open nested rows while still running and verify status updates preserve open DOM nodes
  for (let i = 0; i < nestedCallsList.length; i++) {
    await nestedRootCard.locator('.nested-call-row').nth(i).locator('.nested-call-toggle').click();
  }
  const nestedBashCodeHandle = await nestedRootCard.locator('.nested-call-row').nth(0).locator('code').elementHandle();

  for (const nc of nestedCallsList) {
    broadcast({
      type: 'tool_execution_end',
      toolCallId: nc.id,
      parentToolCallId: nestedRootId,
      toolName: nc.name,
      result: { content: [], details: {} },
      isError: false,
    });
  }
  await page.waitForFunction(
    (root: string) =>
      document.querySelector(`.tool-card[data-tool-call-id="${root}"] .nested-call-row[data-call-id="${root}/4"] .nested-call-status`)?.textContent === 'succeeded',
    nestedRootId,
  );
  assert.equal(
    await nestedRootCard.locator('.nested-call-row').nth(0).locator('code').evaluate((current, previous) => current === previous, nestedBashCodeHandle),
    true,
    'nested status updates keep the same highlighted code block element',
  );

  broadcast({
    type: 'tool_execution_end',
    toolCallId: nestedRootId,
    toolName: 'codemode',
    result: { content: [{ type: 'text', text: 'nested-root-output' }], details: {} },
    isError: false,
  });
  const nestedRootResultMsg = {
    role: 'toolResult',
    toolCallId: nestedRootId,
    toolName: 'codemode',
    content: [{ type: 'text', text: 'nested-root-output' }],
    isError: false,
    timestamp: Date.now(),
    nestedCalls: { complete: true, calls: nestedCallsList },
  } satisfies ToolResultMessage;
  broadcast({ type: 'message_end', message: nestedRootResultMsg });

  const bashCard = page.locator('.tool-card[data-tool-call-id="builtin-bash-timeout"]');
  const bashPlainCard = page.locator('.tool-card[data-tool-call-id="builtin-bash-plain"]');
  const editCard = page.locator('.tool-card[data-tool-call-id="builtin-edit-multi"]');
  const readCard = page.locator('.tool-card[data-tool-call-id="builtin-read-range"]');
  const writeJsCard = page.locator('.tool-card[data-tool-call-id="builtin-write-js"]');
  const writeTxtCard = page.locator('.tool-card[data-tool-call-id="builtin-write-txt"]');

  await writeTxtCard.waitFor({ state: 'attached' });

  const expectedDiffLines = [
    { cls: 'diff-line diff-context', text: '  const a = 1;' },
    { cls: 'diff-line diff-removed', text: '- const b = 2;' },
    { cls: 'diff-line diff-added', text: '+ const b = 20;' },
    { cls: 'diff-line diff-context', text: '  const c = 3;' },
    { cls: 'diff-line diff-removed', text: '- remove me' },
  ];

  const assertCards = async () => {
    // 1. bash with and without timeout
    assert.equal(await bashCard.locator('.tool-args .code-block-header span').textContent(), 'Bash · timeout 30s');
    assert.equal(await bashCard.locator('.tool-args code').textContent(), bashCmd);
    assert.ok(await bashCard.locator('.tool-args .hljs-keyword').count() > 0);
    assert.ok(await bashCard.locator('.tool-args .hljs-variable').count() > 0);
    assert.equal(await bashCard.locator('.tool-args script').count(), 0);
    assert.equal(await bashPlainCard.locator('.tool-args .code-block-header span').textContent(), 'Bash');

    // Copy exact bash command without the timeout label
    await bashCard.locator('.tool-args .copy-btn').click();
    await page.waitForFunction(() =>
      document.querySelector('.tool-card[data-tool-call-id="builtin-bash-timeout"] .tool-args .copy-btn')?.textContent === 'Copied!'
    );
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), bashCmd);

    // 2. edit with edits[] (context lines, removed/added lines, empty replacement, separator)
    assert.equal(await editCard.locator('.tool-args-preview').textContent(), 'src/demo.ts');
    assert.equal(await editCard.locator('.tool-args').count(), 0);
    assert.equal(await editCard.locator('.tool-diff .diff-separator').count(), 1);
    assert.deepEqual(
      await editCard.locator('.tool-diff .diff-line').evaluateAll(els =>
        els.map(el => ({ cls: el.className, text: el.textContent }))
      ),
      expectedDiffLines,
    );

    // 3. read with offset/limit in header and no .tool-args block
    assert.equal(await readCard.locator('.tool-args-preview').textContent(), 'src/demo.ts:10-34');
    assert.equal(await readCard.locator('.tool-args').count(), 0);
    assert.equal(await readCard.locator('.tool-output').textContent(), 'builtin-read-range-output');

    // 4. write with highlighted JS and plain text multi-line content + Copy code
    assert.equal(await writeJsCard.locator('.tool-args .code-block-header span').textContent(), 'JavaScript');
    assert.equal(await writeJsCard.locator('.tool-args code').textContent(), writeJsContent);
    assert.ok(await writeJsCard.locator('.tool-args .hljs-keyword').count() > 0);

    assert.equal(await writeTxtCard.locator('.tool-args .code-block-header span').textContent(), 'notes/todo.txt');
    assert.equal(await writeTxtCard.locator('.tool-args code').textContent(), writeTxtContent);
    assert.equal(await writeTxtCard.locator('.tool-args img').count(), 0);

    await writeTxtCard.locator('.tool-args .copy-btn').click();
    await page.waitForFunction(() =>
      document.querySelector('.tool-card[data-tool-call-id="builtin-write-txt"] .tool-args .copy-btn')?.textContent === 'Copied!'
    );
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), writeTxtContent);

    // 5. Nested bash, edit, read, and write inside codemode
    const nestedBashRow = nestedRootCard.locator(`.nested-call-row[data-call-id="${nestedRootId}/1"]`);
    const nestedEditRow = nestedRootCard.locator(`.nested-call-row[data-call-id="${nestedRootId}/2"]`);
    const nestedReadRow = nestedRootCard.locator(`.nested-call-row[data-call-id="${nestedRootId}/3"]`);
    const nestedWriteRow = nestedRootCard.locator(`.nested-call-row[data-call-id="${nestedRootId}/4"]`);

    assert.equal(await nestedBashRow.locator('.nested-call-arguments .code-block-header span').textContent(), 'Bash · timeout 15s');
    assert.equal(await nestedBashRow.locator('.nested-call-arguments code').textContent(), bashCmd);
    assert.ok(await nestedBashRow.locator('.nested-call-arguments .hljs-keyword').count() > 0);
    await nestedBashRow.locator('.nested-call-arguments .copy-btn').click();
    await page.waitForFunction((root: string) =>
      document.querySelector(`.tool-card[data-tool-call-id="${root}"] .nested-call-row[data-call-id="${root}/1"] .copy-btn`)?.textContent === 'Copied!',
      nestedRootId,
    );
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), bashCmd);

    assert.equal(await nestedEditRow.locator('.nested-call-preview').textContent(), 'src/demo.ts');
    assert.equal(await nestedEditRow.locator('.nested-call-arguments.tool-diff .diff-separator').count(), 1);
    assert.deepEqual(
      await nestedEditRow.locator('.nested-call-arguments.tool-diff .diff-line').evaluateAll(els =>
        els.map(el => ({ cls: el.className, text: el.textContent }))
      ),
      expectedDiffLines,
    );

    assert.equal(await nestedReadRow.locator('.nested-call-preview').textContent(), 'src/demo.ts:10-34');
    assert.equal(await nestedReadRow.locator('pre.nested-call-arguments').textContent(), 'src/demo.ts:10-34');

    assert.equal(await nestedWriteRow.locator('.nested-call-preview').textContent(), 'src/out.js');
    assert.equal(await nestedWriteRow.locator('.nested-call-arguments .code-block-header span').textContent(), 'JavaScript');
    assert.equal(await nestedWriteRow.locator('.nested-call-arguments code').textContent(), writeJsContent);
    assert.ok(await nestedWriteRow.locator('.nested-call-arguments .hljs-keyword').count() > 0);
  };

  for (const tc of toolCalls) {
    await page.locator(`.tool-card[data-tool-call-id="${tc.id}"] .tool-card-header`).click();
  }
  await nestedRootCard.locator('.tool-card-header').click();
  await nestedRootCard.locator('.nested-calls-toggle').click();
  await assertCards();

  // Persist into session history and reload to verify history cards and nested calls match live cards
  session.entries.push({
    type: 'message',
    message: {
      role: 'assistant',
      content: [
        ...toolCalls.map(tc => ({ type: 'toolCall', id: tc.id, name: tc.name, arguments: tc.arguments })),
        { type: 'toolCall', id: nestedRootId, name: 'codemode', arguments: { code: 'await tools.bash({ command: "echo hi" });' } },
      ],
    },
  });
  for (const tc of toolCalls) {
    session.entries.push({
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: tc.id,
        toolName: tc.name,
        content: [{ type: 'text', text: `${tc.id}-output` }],
        isError: false,
        timestamp: Date.now(),
      } satisfies ToolResultMessage,
    });
  }
  session.entries.push({ type: 'message', message: nestedRootResultMsg });

  await page.reload();
  await writeTxtCard.waitFor({ state: 'attached' });
  await toolCommand(page, 'Expand All Tools');
  for (let i = 0; i < nestedCallsList.length; i++) {
    await nestedRootCard.locator('.nested-call-row').nth(i).locator('.nested-call-toggle').click();
  }
  await assertCards();

  // Verify JSON fallbacks when required fields are missing, invalid, or accompanied by unknown keys
  const fallbacks = await page.evaluate(async () => {
    const { ToolCardRenderer } = await import(new URL('/tool-card.js', location.href).href);
    const host = document.createElement('div');
    document.getElementById('messages')!.appendChild(host);
    const renderer = new ToolCardRenderer(host);
    const invalidCases = [
      { toolCallId: 'fb-bash-missing', toolName: 'bash', args: { timeout: 10 } },
      { toolCallId: 'fb-bash-extra', toolName: 'bash', args: { command: 'ls', extra: true } },
      { toolCallId: 'fb-edit-empty', toolName: 'edit', args: { path: 'a.ts', edits: [] } },
      { toolCallId: 'fb-read-extra', toolName: 'read', args: { path: 'a.ts', extra: true } },
      { toolCallId: 'fb-read-bad-offset', toolName: 'read', args: { path: 'a.ts', offset: 'bad' } },
      { toolCallId: 'fb-write-no-path', toolName: 'write', args: { content: 'abc' } },
    ];
    const topLevel = invalidCases.map(item => {
      const live = renderer.createToolCard({ ...item, status: 'pending' });
      const hist = renderer.createHistoryCard({ ...item, toolCallId: `${item.toolCallId}-h` });
      return {
        expected: JSON.stringify(item.args, null, 2),
        liveArgs: live.querySelector('.tool-args')?.textContent,
        histArgs: hist.querySelector('.tool-args')?.textContent,
      };
    });
    renderer.reconcileToolResult('fb-bash-missing', {
      nestedCalls: {
        complete: true,
        calls: invalidCases.map((item, idx) => ({
          id: `fb-bash-missing/${idx + 1}`,
          name: item.toolName,
          arguments: item.args,
          status: 'ok' as const,
        })),
      },
    }, false);
    const nestedParent = host.querySelector('.tool-card[data-tool-call-id="fb-bash-missing"]')!;
    for (const btn of nestedParent.querySelectorAll<HTMLButtonElement>('.nested-call-toggle')) btn.click();
    const nestedArgs = Array.from(nestedParent.querySelectorAll('.nested-call-arguments'), el => el.textContent);
    return { topLevel, nestedArgs };
  });
  for (const [idx, fb] of fallbacks.topLevel.entries()) {
    assert.equal(fb.liveArgs, fb.expected);
    assert.equal(fb.histArgs, fb.expected);
    assert.equal(fallbacks.nestedArgs[idx], fb.expected);
  }

  await assertNoPageErrors(errors);
});

test('expanded file tool cards show full targets on narrow screens', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openNestedPage(t);
  await page.locator('#sidebar-toggle').click();
  await page.setViewportSize({ width: 380, height: 780 });

  const targets = await page.evaluate(async () => {
    const { ToolCardRenderer } = await import(new URL('/tool-card.js', location.href).href);
    const host = document.createElement('div');
    document.getElementById('messages')!.appendChild(host);
    const renderer = new ToolCardRenderer(host);
    const longPath = '/home/user/projects/' + 'long-directory/'.repeat(4) + 'target<file>';
    const cases = [
      { toolName: 'read', args: { path: longPath + '.ts', offset: 50, limit: 20 }, target: longPath + '.ts:50-69' },
      { toolName: 'Read', args: { file_path: longPath + '.txt', offset: 10 }, target: longPath + '.txt:10' },
      { toolName: 'edit', args: { path: longPath + '.ts', edits: [{ oldText: 'old', newText: 'new' }] }, target: longPath + '.ts' },
      { toolName: 'write', args: { path: longPath + '.js', content: 'const value = 1;' }, target: longPath + '.js' },
      { toolName: 'Write', args: { file_path: longPath + '.sh', content: 'echo ok' }, target: longPath + '.sh' },
      { toolName: 'write', args: { path: longPath + '.txt', content: 'notes' }, target: longPath + '.txt' },
    ];
    const cards: Array<{ card: HTMLElement; expected: string }> = cases.flatMap((item, index) => [
      { card: renderer.createToolCard({ ...item, toolCallId: `target-live-${index}`, status: 'pending' }), expected: item.target },
      { card: renderer.createHistoryCard({ ...item, toolCallId: `target-history-${index}` }), expected: item.target },
    ]);
    const root: HTMLElement = renderer.createHistoryCard({ toolCallId: 'target-root', toolName: 'codemode', args: { code: 'await tools.read({ path: "file" });' } });
    renderer.reconcileToolResult('target-root', {
      nestedCalls: {
        complete: true,
        calls: cases.map((item, index) => ({
          id: `target-root/${index + 1}`, name: item.toolName, arguments: item.args, status: 'ok' as const,
        })),
      },
    }, false);
    renderer.expandAll();
    for (const toggle of root.querySelectorAll<HTMLButtonElement>('.nested-call-toggle')) toggle.click();
    const views = [
      ...cards.map(({ card, expected }) => ({ view: card.querySelector('.tool-card-body')!, expected })),
      ...Array.from(root.querySelectorAll('.nested-call-details'), (view, index) => ({ view, expected: cases[index].target })),
    ];
    return views.map(({ view, expected }) => {
      const target = view.querySelector<HTMLElement>('.tool-file-target');
      return {
        expected,
        actual: target?.textContent,
        fits: !!target && target.scrollWidth <= target.clientWidth + 1,
        selectable: !!target && getComputedStyle(target).userSelect !== 'none',
        injectedElements: target?.querySelectorAll('*').length,
      };
    });
  });
  for (const target of targets) {
    assert.equal(target.actual, target.expected, 'expanded cards show the full path and read range');
    assert.equal(target.fits, true, 'full targets wrap within narrow cards');
    assert.equal(target.selectable, true);
    assert.equal(target.injectedElements, 0, 'file paths are text, not HTML');
  }
  await assertNoPageErrors(errors);
});

test('long write labels keep Copy code visible and usable on narrow screens', async (t: TestContext) => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openNestedPage(t);
  await page.locator('#sidebar-toggle').click();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const content = 'first line\nsecond line\n';
  const selectors = await page.evaluate(async (content: string) => {
    const { ToolCardRenderer } = await import(new URL('/tool-card.js', location.href).href);
    const host = document.createElement('div');
    document.getElementById('messages')!.appendChild(host);
    const renderer = new ToolCardRenderer(host);
    const args = { path: 'notes/' + 'x'.repeat(80) + '.txt', content };
    renderer.createToolCard({ toolCallId: 'copy-long-live', toolName: 'write', args, status: 'pending' });
    renderer.createHistoryCard({ toolCallId: 'copy-long-history', toolName: 'write', args });
    const root: HTMLElement = renderer.createHistoryCard({ toolCallId: 'copy-long-root', toolName: 'codemode', args: { code: 'await tools.write({ path: "notes.txt", content: "notes" });' } });
    renderer.reconcileToolResult('copy-long-root', {
      nestedCalls: { complete: true, calls: [{ id: 'copy-long-root/1', name: 'write', arguments: args, status: 'ok' }] },
    }, false);
    renderer.expandAll();
    root.querySelector<HTMLButtonElement>('.nested-call-toggle')!.click();
    return [
      '.tool-card[data-tool-call-id="copy-long-live"] .tool-args',
      '.tool-card[data-tool-call-id="copy-long-history"] .tool-args',
      '.tool-card[data-tool-call-id="copy-long-root"] .nested-call-arguments',
    ];
  }, content);

  for (const width of [380, 360]) {
    await page.setViewportSize({ width, height: 780 });
    for (const selector of selectors) {
      const view = page.locator(selector);
      const layout = await view.evaluate(element => {
        const wrapper = element.querySelector('.code-block-wrapper')!;
        const button = wrapper.querySelector('.copy-btn')!.getBoundingClientRect();
        const bounds = wrapper.getBoundingClientRect();
        const label = wrapper.querySelector<HTMLElement>('.code-block-header span')!;
        return {
          buttonFits: button.left >= bounds.left && button.right <= bounds.right + 1,
          labelFits: label.scrollWidth <= label.clientWidth + 1,
          labelText: label.textContent,
        };
      });
      assert.equal(layout.buttonFits, true, 'Copy code stays inside the visible block');
      assert.equal(layout.labelFits, true, 'long labels wrap within the header');
      assert.equal(layout.labelText, 'notes/' + 'x'.repeat(80) + '.txt');
      await view.locator('.copy-btn').click();
      await page.waitForFunction((selector: string) =>
        document.querySelector(`${selector} .copy-btn`)?.textContent === 'Copied!', selector);
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), content);
    }
  }
  await assertNoPageErrors(errors);
});
