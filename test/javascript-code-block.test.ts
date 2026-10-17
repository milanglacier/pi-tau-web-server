import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as CodeBlock from '../src/public/javascript-code-block.js';
import type * as ToolCard from '../src/public/tool-card.js';

const { highlightJavaScript, highlightBash } = (await import('../public/javascript-code-block.js')) as unknown as typeof CodeBlock;
const { computeLineDiff, extractEdits, formatReadLineRange } = (await import('../public/tool-card.js')) as unknown as typeof ToolCard;

test('JavaScript source has syntax colors without losing whitespace', () => {
  const source = '// Read a file.\nconst result = await tools.read({ path: "file.txt" });\n\n';
  const html = highlightJavaScript(source);
  assert.match(html, /class="hljs-keyword"/);
  assert.match(html, /class="hljs-string"/);
  assert.match(html, /class="hljs-comment"/);
  assert.equal(html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"'), source);
});

test('Bash source has syntax colors without losing whitespace', () => {
  const source = '# Run build\nif [ -n "$TARGET" ]; then\n  echo "building $TARGET"\nfi\n';
  const html = highlightBash(source);
  assert.match(html, /class="hljs-comment"/);
  assert.match(html, /class="hljs-keyword"/);
  assert.match(html, /class="hljs-built_in"/);
  assert.match(html, /class="hljs-string"/);
  assert.match(html, /class="hljs-variable"/);
  assert.equal(html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"'), source);
});

test('computeLineDiff preserves unchanged context and orders removals before additions', () => {
  const diff = computeLineDiff(
    'const a = 1;\nconst b = 2;\nconst c = 3;',
    'const a = 1;\nconst b = 20;\nconst d = 4;\nconst c = 3;',
  );
  assert.deepEqual(diff, [
    { type: 'context', text: 'const a = 1;' },
    { type: 'removed', text: 'const b = 2;' },
    { type: 'added', text: 'const b = 20;' },
    { type: 'added', text: 'const d = 4;' },
    { type: 'context', text: 'const c = 3;' },
  ]);
});

test('computeLineDiff handles empty oldText or newText without spurious blank lines', () => {
  assert.deepEqual(computeLineDiff('removed line', ''), [
    { type: 'removed', text: 'removed line' },
  ]);
  assert.deepEqual(computeLineDiff('', 'added line'), [
    { type: 'added', text: 'added line' },
  ]);
  assert.deepEqual(computeLineDiff('', ''), []);
});

test('extractEdits normalizes current and legacy edit shapes and rejects malformed args', () => {
  assert.deepEqual(
    extractEdits({
      path: 'src/app.ts',
      edits: [
        { oldText: 'a', newText: 'b' },
        { old_text: 'c', new_text: '' },
      ],
    }),
    [
      { oldText: 'a', newText: 'b' },
      { oldText: 'c', newText: '' },
    ],
  );
  assert.deepEqual(
    extractEdits({ path: 'src/app.ts', edits: { oldText: 'one', newText: 'two' } }),
    [{ oldText: 'one', newText: 'two' }],
  );
  assert.deepEqual(
    extractEdits({ path: 'src/app.ts', edits: JSON.stringify([{ oldText: 'x', newText: 'y' }]) }),
    [{ oldText: 'x', newText: 'y' }],
  );
  assert.deepEqual(
    extractEdits({ file_path: 'src/app.ts', oldText: 'old', newText: '' }),
    [{ oldText: 'old', newText: '' }],
  );
  assert.equal(extractEdits({ path: 'src/app.ts', edits: [] }), undefined);
  assert.equal(extractEdits({ path: 'src/app.ts', oldText: 'only-old' }), undefined);
  assert.equal(extractEdits({ path: 'src/app.ts', edits: [{ oldText: 'a', newText: 123 }] }), undefined);
  assert.equal(extractEdits({ path: 'src/app.ts', oldText: 'a', newText: 'b', unexpected: true }), undefined);
});

test('formatReadLineRange formats offset and limit like Pi', () => {
  assert.equal(formatReadLineRange(undefined, undefined), '');
  assert.equal(formatReadLineRange(null, null), '');
  assert.equal(formatReadLineRange(1, 100), ':1-100');
  assert.equal(formatReadLineRange(undefined, 50), ':1-50');
  assert.equal(formatReadLineRange(50, undefined), ':50');
  assert.equal(formatReadLineRange(50, 20), ':50-69');
  assert.equal(formatReadLineRange('10', '20'), ':10-29');
  assert.equal(formatReadLineRange('invalid', 20), '');
  assert.equal(formatReadLineRange(10, 'invalid'), '');
});
