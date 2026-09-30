import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NestedCallsRecord } from '../src/public/nested-tool-calls.js';

const { NestedToolCallsModel } = (await import('../public/nested-tool-calls.js')) as unknown as typeof import('../src/public/nested-tool-calls.js');

function start(model: InstanceType<typeof NestedToolCallsModel>, id: string, parent = 'root', now = 10, args: Record<string, unknown> = {}) {
  return model.observe({ type: 'tool_execution_start', toolCallId: id, parentToolCallId: parent, toolName: 'read', args }, now);
}

function end(model: InstanceType<typeof NestedToolCallsModel>, id: string, parent = 'root', now = 20, isError = false, result: unknown = { content: [{ type: 'text', text: 'full child output' }] }) {
  return model.observe({ type: 'tool_execution_end', toolCallId: id, parentToolCallId: parent, toolName: 'read', isError, result }, now);
}

function modelWithRoot(root = 'root') {
  const model = new NestedToolCallsModel();
  model.registerRoot(root);
  return model;
}

test('siblings keep start order while descendants appear under their immediate parent', () => {
  const model = modelWithRoot();
  assert.equal(start(model, 'root/1'), 'root');
  start(model, 'root/2');
  start(model, 'root/1/1', 'root/1', 15);
  end(model, 'root/2');
  end(model, 'root/1/1', 'root/1', 35);
  end(model, 'root/1', 'root', 40);
  const summary = model.get('root')!;
  assert.deepEqual(summary.calls.map(call => [call.id, call.depth, call.parentId, call.durationMs]), [
    ['root/1', 1, 'root', 30], ['root/1/1', 2, 'root/1', 20], ['root/2', 1, 'root', 10],
  ]);
  assert.equal(summary.complete, true);
  assert.equal(summary.final, false);
  assert.ok(summary.calls.every(call => call.status === 'ok'));
});

test('duplicate starts and ends preserve arguments, start times, durations, and rows', () => {
  const model = modelWithRoot();
  start(model, 'root/1', 'root', 10, { path: 'first' });
  assert.equal(start(model, 'root/1', 'root', 100, { path: 'second' }), undefined);
  end(model, 'root/1', 'root', 20);
  const before = model.get('root');
  assert.equal(end(model, 'root/1', 'root', 300, true, 'late error'), undefined);
  assert.equal(start(model, 'root/1'), undefined);
  assert.deepEqual(model.get('root'), before);
  assert.deepEqual(before!.calls[0].arguments, { path: 'first' });
});

test('missing starts have no estimated duration and missing parents do not invent rows', () => {
  const model = modelWithRoot();
  end(model, 'root/1/2', 'root/1');
  const call = model.get('root')!.calls[0];
  assert.equal(call.durationMs, undefined);
  assert.equal(call.startedAt, undefined);
  assert.equal(call.parentId, 'root');
  assert.equal(call.depth, 1);
  start(model, 'root/1');
  assert.deepEqual(model.get('root')!.calls.map(row => [row.id, row.depth]), [['root/1', 1], ['root/1/2', 2]]);
});

test('children observed before the root are resolved with their bounded summaries', () => {
  const model = new NestedToolCallsModel();
  assert.equal(start(model, 'provider/tool/1/2', 'provider/tool/1'), undefined);
  end(model, 'provider/tool/1/2', 'provider/tool/1', 40, true, 'short failure');
  start(model, 'provider/tool/1', 'provider/tool');
  model.registerRoot('provider/tool');
  assert.deepEqual(model.get('provider/tool')!.calls.map(call => [call.id, call.depth, call.status]), [
    ['provider/tool/1', 1, 'running'], ['provider/tool/1/2', 2, 'error'],
  ]);
});

test('root IDs can contain slashes and the longest registered ancestor owns a child', () => {
  const model = modelWithRoot('root');
  model.registerRoot('root/1');
  assert.equal(start(model, 'root/1/1', 'root/1'), 'root/1');
  assert.equal(model.get('root'), undefined);
  assert.equal(model.get('root/1')!.calls[0].depth, 1);
  model.registerRoot('provider/tool');
  assert.equal(start(model, 'provider/tool/1', 'provider/tool'), 'provider/tool');
});

test('a registered root removes a colliding child and takes ownership of descendants', () => {
  const model = modelWithRoot();
  start(model, 'root/1');
  start(model, 'root/1/1', 'root/1');
  model.registerRoot('root/1');
  assert.equal(model.get('root'), undefined);
  assert.equal(model.get('root/1')!.calls.length, 1);
  assert.equal(model.get('root/1')!.calls[0].parentId, 'root/1');
  assert.equal(start(model, 'root/1'), undefined);
  model.registerRoot('root/1');
  assert.equal(model.get('root/1')!.calls.length, 1);
});

test('invalid live relationships and partial updates do not retain state', () => {
  const model = modelWithRoot();
  for (const [id, parent] of [['root', 'root'], ['root/1/2', 'root'], ['root/x', 'root'], ['root/0', 'root'], ['root/01', 'root'], ['root/1', 'other'], ['root/1/', 'root']]) {
    assert.equal(start(model, id, parent), undefined);
  }
  model.observe({ type: 'tool_execution_update', toolCallId: 'root/1', parentToolCallId: 'root', result: 'partial output' });
  assert.equal(model.get('root'), undefined);
});

test('authoritative replacement preserves sibling order and hierarchy and blocks late events', () => {
  const model = modelWithRoot();
  start(model, 'root/1');
  end(model, 'root/1');
  const record: NestedCallsRecord = { complete: false, calls: [
    { id: 'root/2', name: 'bash', status: 'error', arguments: { command: 'false' }, error: 'failed', durationMs: 123 },
    { id: 'root/1/1', name: 'read', status: 'ok', argumentsBytes: 9000, durationMs: 12 },
    { id: 'root/1', name: 'codemode', status: 'unfinished' },
    { id: 'unsafe/name', name: 'read', status: 'ok' },
    { id: 'root/4/1', name: 'read', status: 'ok' },
  ] };
  model.replace('root', record);
  const saved = model.get('root')!;
  assert.deepEqual(saved.calls.map(call => [call.id, call.depth]), [
    ['root/2', 1], ['root/1', 1], ['root/1/1', 2], ['unsafe/name', 1], ['root/4/1', 1],
  ]);
  assert.equal(saved.calls[1].durationMs, undefined);
  assert.equal(saved.calls[1].startedAt, undefined);
  assert.equal(saved.final, true);
  model.replace('root', record);
  assert.deepEqual(model.get('root'), saved);
  assert.equal(start(model, 'root/3'), undefined);
  assert.equal(end(model, 'root/1', 'root', 99), undefined);
  assert.deepEqual(model.get('root'), saved);
});

test('saved duplicate IDs retain one row and saved records never add root collisions', () => {
  const model = modelWithRoot();
  model.registerRoot('root/2');
  model.replace('root', { complete: true, calls: [
    { id: 'root/1', name: 'read', status: 'ok' },
    { id: 'root/1', name: 'bash', status: 'error' },
    { id: 'root/2', name: 'codemode', status: 'ok' },
    { id: 'root', name: 'codemode', status: 'ok' },
  ] });
  assert.equal(model.get('root')!.calls.length, 1);
  assert.equal(model.get('root')!.calls[0].name, 'read');
});

test('live and buffered calls enforce the count cap and report omissions', () => {
  for (const buffered of [false, true]) {
    const model = buffered ? new NestedToolCallsModel() : modelWithRoot();
    for (let n = 1; n <= 300; n++) start(model, `root/${n}`);
    if (buffered) model.registerRoot('root');
    const summary = model.get('root')!;
    assert.equal(summary.calls.length, 256);
    assert.equal(summary.complete, false);
    assert.equal(summary.calls.at(-1)!.id, 'root/256');
  }
});

test('buffer omissions remain bounded and do not create unrelated root summaries', () => {
  const model = new NestedToolCallsModel();
  for (let n = 1; n <= 256; n++) start(model, `first/${n}`, 'first');
  start(model, 'second/1', 'second');
  model.registerRoot('unrelated');
  assert.equal(model.get('unrelated'), undefined);
  model.registerRoot('second');
  assert.deepEqual(model.get('second'), { calls: [], complete: false, final: false });
});

test('buffered omissions belong to the root whose arguments were omitted', () => {
  const model = new NestedToolCallsModel();
  start(model, 'first/1', 'first', 10, { path: 'x'.repeat(9000) });
  start(model, 'second/1', 'second', 10, { path: '/second' });
  model.registerRoot('second');
  assert.equal(model.get('second')!.complete, true);
  model.registerRoot('first');
  assert.equal(model.get('first')!.complete, false);
});

test('completed observed calls stay distinct from a final saved record', () => {
  const model = modelWithRoot();
  start(model, 'root/1');
  end(model, 'root/1');
  model.finish('root');
  assert.equal(model.get('root')!.final, false);
  assert.equal(model.get('root')!.complete, true);
  model.replace('root', { complete: true, calls: [{ id: 'root/1', name: 'read', status: 'ok' }] });
  assert.equal(model.get('root')!.final, true);
});

test('argument limits count UTF-8 bytes, preserve exact boundaries, and clone retained arguments', () => {
  const model = modelWithRoot();
  const exact = { value: 'x'.repeat(8180) };
  assert.equal(new TextEncoder().encode(JSON.stringify(exact)).length, 8192);
  start(model, 'root/1', 'root', 10, exact);
  exact.value = 'mutated';
  for (let n = 2; n <= 4; n++) start(model, `root/${n}`, 'root', 10, { value: 'x'.repeat(8180) });
  start(model, 'root/5', 'root', 10, {});
  start(model, 'root/6', 'root', 10, { value: 'é'.repeat(4091) });
  const summary = model.get('root')!;
  assert.equal((summary.calls[0].arguments!.value as string).length, 8180);
  assert.equal(summary.calls[4].arguments, undefined);
  assert.equal(summary.calls[4].argumentsBytes, 2);
  assert.equal(summary.calls[5].arguments, undefined);
  assert.equal(summary.calls[5].argumentsBytes, 8194);
  assert.equal(summary.complete, false);
});

test('saved records enforce the count, argument, and error limits without retaining extra output', () => {
  const model = modelWithRoot();
  const calls: NestedCallsRecord['calls'] = Array.from({ length: 300 }, (_, i) => ({
    id: `root/${i + 1}`, name: 'read', status: 'ok',
  }));
  calls[0] = { id: 'root/1', name: 'read', status: 'error', arguments: { value: 'é'.repeat(4091) }, error: 'x'.repeat(700), ...{ output: 'full saved child output' } };
  for (let i = 1; i <= 4; i++) calls[i].arguments = { value: 'x'.repeat(8180) };
  calls[5].arguments = {};
  model.replace('root', { complete: true, calls });
  const summary = model.get('root')!;
  assert.equal(summary.calls.length, 256);
  assert.equal(summary.complete, false);
  assert.equal(summary.calls[0].argumentsBytes, 8194);
  assert.equal(summary.calls[0].error!.length, 500);
  assert.equal(summary.calls[5].argumentsBytes, 2);
  assert.ok(!JSON.stringify(summary).includes('full saved child output'));
});

test('only bounded failed text is retained, never successful or partial output', () => {
  const model = modelWithRoot();
  start(model, 'root/1');
  model.observe({ type: 'tool_execution_update', toolCallId: 'root/1', parentToolCallId: 'root', result: 'partial secret' });
  end(model, 'root/1');
  start(model, 'root/2');
  end(model, 'root/2', 'root', 20, true, { content: [
    { type: 'image', data: 'image secret' },
    { type: 'text', text: 'a'.repeat(300) },
    { type: 'text', text: 'b'.repeat(400) },
  ], details: 'details secret' });
  const summary = model.get('root')!;
  assert.equal(summary.calls[0].error, undefined);
  assert.equal(summary.calls[1].error, `${'a'.repeat(300)}\n${'b'.repeat(199)}`);
  const json = JSON.stringify(summary);
  for (const secret of ['full child output', 'partial secret', 'image secret', 'details secret', 'result', 'content']) assert.ok(!json.includes(secret));
});

test('finish and settlement mark running calls unfinished while preserving completed calls', () => {
  const model = modelWithRoot();
  start(model, 'root/1');
  start(model, 'root/2');
  end(model, 'root/2');
  model.registerRoot('other');
  start(model, 'other/1', 'other');
  assert.deepEqual(model.settle(), ['root', 'other']);
  assert.deepEqual(model.get('root')!.calls.map(call => call.status), ['unfinished', 'ok']);
  assert.equal(model.get('root')!.complete, false);
  assert.equal(model.get('root')!.final, false, 'settlement does not make an observed record authoritative');
  assert.deepEqual(model.settle(), []);
  model.replace('root', { complete: true, calls: [{ id: 'root/1', name: 'read', status: 'ok', durationMs: 30 }] });
  model.finish('root');
  assert.equal(model.get('root')!.complete, true);
});

test('incomplete empty records render a summary and clear removes roots and buffered children', () => {
  const model = modelWithRoot();
  model.replace('root', { complete: false, calls: [] });
  assert.deepEqual(model.get('root'), { complete: false, final: true, calls: [] });
  start(model, 'other/1', 'other');
  model.clear();
  model.registerRoot('root');
  model.registerRoot('other');
  assert.equal(model.get('root'), undefined);
  assert.equal(model.get('other'), undefined);
  assert.equal(start(model, 'root/1'), 'root');
});
