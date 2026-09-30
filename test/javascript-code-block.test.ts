import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as CodeBlock from '../src/public/javascript-code-block.js';

const { highlightJavaScript } = (await import('../public/javascript-code-block.js')) as unknown as typeof CodeBlock;

test('JavaScript source has syntax colors without losing whitespace', () => {
  const source = '// Read a file.\nconst result = await tools.read({ path: "file.txt" });\n\n';
  const html = highlightJavaScript(source);
  assert.match(html, /class="hljs-keyword"/);
  assert.match(html, /class="hljs-string"/);
  assert.match(html, /class="hljs-comment"/);
  assert.equal(html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"'), source);
});
