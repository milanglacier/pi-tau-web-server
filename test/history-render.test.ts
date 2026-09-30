import { test } from 'node:test';
import assert from 'node:assert/strict';

// The compiled frontend module is a plain JS artifact without declarations;
// the old require() call typed these as any, so keep that contract here.
const { buildHistoryItems } = (await import('../public/history-render.js')) as any;

type Entry = { type?: string; message?: Record<string, unknown> };

function msg(message: Record<string, unknown>): Entry {
  return { type: 'message', message };
}

test('string user content becomes a user item', () => {
  const { items } = buildHistoryItems([msg({ role: 'user', content: 'hello' })]);
  assert.deepEqual(items, [{ kind: 'user', content: 'hello', images: undefined }]);
});

test('block user content joins text blocks and extracts images', () => {
  const { items } = buildHistoryItems([
    msg({
      role: 'user',
      content: [
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
        { type: 'image', source: { data: 'abc123', media_type: 'image/jpeg' } },
      ],
    }),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].content, 'line one\nline two');
  assert.deepEqual(items[0].images, [{ data: 'abc123', mimeType: 'image/jpeg' }]);
});

test('empty user message produces no item', () => {
  const { items } = buildHistoryItems([msg({ role: 'user', content: '' }), msg({ role: 'user', content: [] })]);
  assert.equal(items.length, 0);
});

test('image-only user message still produces an item', () => {
  const { items } = buildHistoryItems([
    msg({ role: 'user', content: [{ type: 'image', data: 'xyz', media_type: 'image/png' }] }),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].content, '');
  assert.deepEqual(items[0].images, [{ data: 'xyz', mimeType: 'image/png' }]);
});

test('assistant text and thinking blocks become one assistant item with block content', () => {
  const blocks = [
    { type: 'thinking', thinking: 'hmm' },
    { type: 'text', text: 'answer' },
  ];
  const { items } = buildHistoryItems([msg({ role: 'assistant', content: blocks })]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'assistant');
  assert.deepEqual(items[0].content, blocks);
});

test('thinking-only assistant message still produces an item', () => {
  const { items } = buildHistoryItems([
    msg({ role: 'assistant', content: [{ type: 'thinking', thinking: 'pondering' }] }),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'assistant');
});

test('tool-call-only assistant message produces toolCall items but no assistant item', () => {
  const { items } = buildHistoryItems([
    msg({
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { command: 'ls' } },
        { type: 'toolCall', id: 'tc-2', name: 'read', arguments: { path: '/x' } },
      ],
    }),
  ]);
  assert.deepEqual(
    items.map((i: { kind: string }) => i.kind),
    ['toolCall', 'toolCall']
  );
  assert.equal(items[0].toolCallId, 'tc-1');
  assert.equal(items[0].toolName, 'bash');
  assert.deepEqual(items[0].args, { command: 'ls' });
});

test('toolResult attaches to its toolCall item and emits no item of its own', () => {
  const { items } = buildHistoryItems([
    msg({
      role: 'assistant',
      content: [
        { type: 'text', text: 'running' },
        { type: 'toolCall', id: 'tc-1', name: 'bash', arguments: {} },
      ],
    }),
    msg({ role: 'toolResult', toolCallId: 'tc-1', content: [{ type: 'text', text: 'output here' }] }),
  ]);
  assert.equal(items.length, 2);
  const tc = items[1];
  assert.equal(tc.kind, 'toolCall');
  assert.deepEqual(tc.result, { content: [{ type: 'text', text: 'output here' }] });
  assert.equal(tc.isError, false);
});

test('multiple toolCalls in one assistant message each get their own result', () => {
  const { items } = buildHistoryItems([
    msg({
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'a', name: 'bash', arguments: {} },
        { type: 'toolCall', id: 'b', name: 'read', arguments: {} },
      ],
    }),
    msg({ role: 'toolResult', toolCallId: 'b', content: [{ type: 'text', text: 'result-b' }] }),
    msg({ role: 'toolResult', toolCallId: 'a', content: [{ type: 'text', text: 'result-a' }], isError: true }),
  ]);
  const byId = new Map<string, Record<string, unknown>>(
    items.map((i: { toolCallId: string }) => [i.toolCallId, i])
  );
  assert.deepEqual(byId.get('a')!.result, { content: [{ type: 'text', text: 'result-a' }] });
  assert.equal(byId.get('a')!.isError, true);
  assert.deepEqual(byId.get('b')!.result, { content: [{ type: 'text', text: 'result-b' }] });
  assert.equal(byId.get('b')!.isError, false);
});

test('nested records stay paired with their own parent without adding history items', () => {
  const first = {
    complete: true,
    calls: [{ id: 'a/1', name: 'read', arguments: { path: '/a' }, status: 'ok', durationMs: 12 }],
  };
  const second = { complete: false, calls: [] };
  const { items } = buildHistoryItems([
    msg({ role: 'assistant', content: [
      { type: 'toolCall', id: 'a', name: 'codemode', arguments: { code: 'a()' } },
      { type: 'toolCall', id: 'b', name: 'codemode', arguments: { code: 'b()' } },
    ] }),
    msg({ role: 'toolResult', toolCallId: 'b', content: [], nestedCalls: second }),
    msg({ role: 'toolResult', toolCallId: 'a', content: [{ type: 'text', text: 'parent output' }], nestedCalls: first }),
  ]);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item: { kind: string }) => item.kind), ['toolCall', 'toolCall']);
  assert.deepEqual(items[0].result, { content: [{ type: 'text', text: 'parent output' }], nestedCalls: first });
  assert.deepEqual(items[1].result, { content: [], nestedCalls: second });
});

test('tool-result usage is separate from assistant usage', () => {
  const { totalCost, lastInputTokens, lastUsage } = buildHistoryItems([
    msg({ role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'codemode', arguments: {} }] }),
    msg({ role: 'toolResult', toolCallId: 'a', content: [], usage: { input: 999, cost: { total: 12 } } }),
  ]);
  assert.equal(totalCost, 0);
  assert.equal(lastInputTokens, 0);
  assert.equal(lastUsage, null);
});

test('unmatched toolResult is dropped without throwing', () => {
  const { items } = buildHistoryItems([
    msg({ role: 'toolResult', toolCallId: 'ghost', content: [{ type: 'text', text: 'orphan' }] }),
  ]);
  assert.equal(items.length, 0);
});

test('totalCost sums usage.cost.total across assistant messages', () => {
  const { totalCost } = buildHistoryItems([
    msg({ role: 'assistant', content: [{ type: 'text', text: 'a' }], usage: { cost: { total: 0.5 } } }),
    msg({ role: 'assistant', content: [{ type: 'text', text: 'b' }], usage: { cost: { total: 0.25 } } }),
  ]);
  assert.equal(totalCost, 0.75);
});

test('lastInputTokens/lastUsage come from the last assistant message with usage', () => {
  const first = { input: 100, cacheRead: 10, cost: { total: 0.1 } };
  const last = { input: 200, cacheRead: 50, cost: { total: 0.2 } };
  const { lastInputTokens, lastUsage } = buildHistoryItems([
    msg({ role: 'assistant', content: [{ type: 'text', text: 'a' }], usage: first }),
    msg({ role: 'user', content: 'more' }),
    msg({ role: 'assistant', content: [{ type: 'text', text: 'b' }], usage: last }),
  ]);
  assert.equal(lastInputTokens, 250);
  assert.deepEqual(lastUsage, last);
});

test('non-message entries and empty messages are skipped', () => {
  const { items } = buildHistoryItems([
    { type: 'session' },
    { type: 'message' },
    { type: 'event', message: { role: 'user', content: 'wrong entry type' } },
    msg({ role: 'user', content: 'real' }),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].content, 'real');
});

test('items preserve conversation order', () => {
  const { items } = buildHistoryItems([
    msg({ role: 'user', content: 'q1' }),
    msg({
      role: 'assistant',
      content: [
        { type: 'text', text: 'a1' },
        { type: 'toolCall', id: 't1', name: 'bash', arguments: {} },
      ],
    }),
    msg({ role: 'toolResult', toolCallId: 't1', content: [] }),
    msg({ role: 'user', content: 'q2' }),
    msg({ role: 'assistant', content: [{ type: 'text', text: 'a2' }] }),
  ]);
  assert.deepEqual(
    items.map((i: { kind: string }) => i.kind),
    ['user', 'assistant', 'toolCall', 'user', 'assistant']
  );
});
