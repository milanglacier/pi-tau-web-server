const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// The frontend modules are compiled to ES modules; node's require(esm) loads
// them fine since the graph has no top-level await.
const { renderMarkdown, renderUserMarkdown } = require('../public/markdown.js');

// Stub KaTeX with a marker-emitting renderer so tests can assert on what was
// sent to it without pulling the real library into node.
const katexStub = {
  renderToString(src: string, opts: { displayMode: boolean }) {
    return `<span data-math data-display="${!!opts.displayMode}">${src}</span>`;
  },
};

beforeEach(() => {
  (globalThis as { katex?: unknown }).katex = katexStub;
});

test('multi-line $$...$$ becomes its own display math block', () => {
  const html = renderMarkdown('before\n\n$$\na + b\n$$\n\nafter');
  assert.match(html, /<div class="math-block"><span data-math data-display="true">a \+ b<\/span><\/div>/);
  assert.match(html, /<p>before<\/p>/);
  assert.match(html, /<p>after<\/p>/);
});

test('inline $$...$$ inside a paragraph is lifted into a display block', () => {
  const html = renderMarkdown('the sum $$a+b$$ is here');
  assert.match(html, /data-display="true">a\+b</);
});

test('\\[...\\] renders as display math', () => {
  const html = renderMarkdown('\\[x^2\\]');
  assert.match(html, /<div class="math-block"><span data-math data-display="true">x\^2<\/span><\/div>/);
});

test('\\(...\\) renders as inline math', () => {
  const html = renderMarkdown('value \\(x^2\\) here');
  assert.match(html, /<p>value <span data-math data-display="false">x\^2<\/span> here<\/p>/);
});

test('$...$ renders as inline math and is protected from emphasis regexes', () => {
  const html = renderMarkdown('so $a_i * b_i$ and $c_j * d_j$ hold');
  assert.match(html, /data-display="false">a_i \* b_i</);
  assert.match(html, /data-display="false">c_j \* d_j</);
  assert.doesNotMatch(html, /<em>/);
});

test('math works in user messages too', () => {
  const html = renderUserMarkdown('inline $x^2$ and\n$$\ny = mx\n$$');
  assert.match(html, /data-display="false">x\^2</);
  assert.match(html, /<div class="math-block"><span data-math data-display="true">y = mx<\/span><\/div>/);
});

test('math inside inline code stays literal', () => {
  const html = renderMarkdown('use `$x$` in shell');
  assert.match(html, /<code>\$x\$<\/code>/);
  assert.doesNotMatch(html, /data-math/);
});

test('math inside fenced code blocks stays literal', () => {
  const html = renderMarkdown('```sh\necho $$ and $HOME\n```');
  assert.match(html, /echo \$\$ and \$HOME/);
  assert.doesNotMatch(html, /data-math/);
});

test('currency amounts are not treated as math', () => {
  for (const text of ['it costs $5 and $10 total', 'a $ x$ b', 'a $x $ b', 'pay \\$5 now']) {
    assert.doesNotMatch(renderMarkdown(text), /data-math/, text);
  }
});

test('falls back to escaped source when katex is unavailable', () => {
  delete (globalThis as { katex?: unknown }).katex;
  const html = renderMarkdown('inline $a < b$ math');
  assert.match(html, /<code class="math-fallback">a &lt; b<\/code>/);
});

test('falls back to escaped source when katex throws', () => {
  (globalThis as { katex?: unknown }).katex = {
    renderToString() { throw new Error('boom'); },
  };
  const html = renderMarkdown('$a+b$');
  assert.match(html, /<code class="math-fallback">a\+b<\/code>/);
});
