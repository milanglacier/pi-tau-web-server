import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The compiled frontend module is a plain JS artifact without declarations;
// the old require() call typed these as any, so keep that contract here.
const { renderMarkdown, renderUserMarkdown } = (await import('../public/markdown.js')) as any;

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

// Matches a generated tag with an event handler attribute or a script URL.
// Quoted attribute values are skipped whole, so escaped text inside a value
// does not count as an attribute.
const UNSAFE = /<(img|a)\b(\s+[\w-]+="[^"]*")*\s*(on\w+=|(src|href)="\s*javascript:)/i;

test('HTML in assistant text shows as text, except <br>', () => {
  const html = renderMarkdown('hi <img src=x onerror=alert(1)> and a <div> wrapper\n\n| a | b |\n|---|---|\n| one<br>two | x<BR />y |\n\nbad <br onclick=alert(1)>');
  assert.doesNotMatch(html, /<img|<div>/);
  assert.match(html, /hi &lt;img src=x onerror=alert\(1\)&gt; and a &lt;div&gt; wrapper/);
  assert.match(html, /<td style="text-align:left">one<br>two<\/td>/);
  assert.match(html, /x<br>y/);
  assert.match(html, /bad &lt;br onclick=alert\(1\)&gt;/);
});

test('markdown links and images cannot add event handlers or script URLs', () => {
  for (const render of [renderMarkdown, renderUserMarkdown]) {
    for (const text of [
      '![x](x" onerror="alert(1))',
      '[click](javascript:alert(1))',
      '[click](JavaScript:alert(1))',
      '[click](java\tscript:alert(1))',
      '[click](javascript&#58;alert(1))',
      '![x](javascript:alert(1))',
      'see https://a.com/"onmouseover="alert(1)',
    ]) {
      assert.doesNotMatch(render(text), UNSAFE, text);
    }
  }
});

test('nested link syntax in an image URL stays inside the image attribute', () => {
  const payload = '![x](x[a]( y onerror=window.summaryExecuted=1 a=))';
  for (const render of [renderMarkdown, renderUserMarkdown]) {
    const html = render(payload);
    assert.match(html, /<img src="x\[a\]\( y onerror=window\.summaryExecuted=1 a=" alt="x" class="inline-image">/);
    assert.doesNotMatch(html, /<a\b/);
  }
});

test('safe links and images still render', () => {
  assert.match(renderMarkdown('[a](https://a.com/?a=1&b=2)'), /<a href="https:\/\/a\.com\/\?a=1&amp;b=2" target="_blank" rel="noopener">a<\/a>/);
  assert.match(renderUserMarkdown('[a](https://a.com/?a=1&b=2)'), /href="https:\/\/a\.com\/\?a=1&amp;b=2"/);
  assert.match(renderMarkdown('[doc](docs/a.md) and [top](#top) and [me](mailto:a@b.c)'), /href="docs\/a\.md".*href="#top".*href="mailto:a@b\.c"/);
  assert.match(renderMarkdown('![cat](https://a.com/cat.png)'), /<img src="https:\/\/a\.com\/cat\.png" alt="cat" class="inline-image">/);
  assert.match(renderMarkdown('see https://a.com/x?y=1'), /<a href="https:\/\/a\.com\/x\?y=1"/);
});

test('image attributes keep Markdown punctuation, code and math as text', () => {
  for (const render of [renderMarkdown, renderUserMarkdown]) {
    const html = render('![**cat** `tag` $x$](https://a.com/a_b_c/$y$)');
    assert.match(html, /src="https:\/\/a\.com\/a_b_c\/\$y\$" alt="\*\*cat\*\* `tag` \$x\$"/);
    assert.doesNotMatch(html, /<strong>|<em>|<code>|data-math|%%INLINE/);
    assert.match(render('![`"` $x$](missing)'), /alt="`&quot;` \$x\$"/);
  }
});

test('link labels keep formatting, code, math and linked images', () => {
  for (const render of [renderMarkdown, renderUserMarkdown]) {
    const html = render('[**bold** `<x>` $y$](https://a.com/page) and [![cat](https://a.com/cat.png)](https://a.com/cat)');
    assert.match(html, /<strong>bold<\/strong> <code>&lt;x&gt;<\/code> <span data-math data-display="false">y<\/span><\/a>/);
    assert.match(html, /href="https:\/\/a\.com\/cat"[^>]*><img src="https:\/\/a\.com\/cat.png" alt="cat" class="inline-image"><\/a>/);
    assert.equal((html.match(/<a\b/g) || []).length, 2);
    assert.doesNotMatch(html, /%%INLINE/);
  }
});

test('math and code keep their source when HTML is escaped', () => {
  const html = renderMarkdown('a & b, $x < y & z$, and `<b>`');
  assert.match(html, /a &amp; b/);
  assert.match(html, /data-display="false">x < y & z</);
  assert.match(html, /<code>&lt;b&gt;<\/code>/);
});
