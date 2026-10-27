import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  compactionRowHtml, compactionRunningText, compactionDoneText, compactionFailedText, summaryRetryText, formatTokenCount, formatElapsed,
} = (await import('../public/compaction-row.js')) as any;

test('the running row says why compaction started', () => {
  assert.equal(compactionRunningText('manual'), 'Compacting context…');
  assert.equal(compactionRunningText('threshold'), 'Context is nearly full. Compacting automatically…');
  assert.equal(compactionRunningText('overflow'), 'Context overflowed. Compacting…');
});

test('the running row shows how long it has been running and a scheduled summary retry', () => {
  const html = compactionRowHtml({ status: 'running', reason: 'manual', startedAt: 1000, retry: { attempt: 1, maxAttempts: 3, delayMs: 2000 } }, 66_000);
  assert.match(html, /Compacting context…/);
  assert.match(html, /<span class="compaction-elapsed">1m 05s<\/span>/);
  assert.match(html, /Summary request failed\. Retrying in 2s \(attempt 1\/3\)…/);
  assert.equal(summaryRetryText({ attempt: 2, maxAttempts: 3, started: true }), 'Summary request failed. Retrying (attempt 2/3)…');
});

test('the finished row shows the token counts and says when Pi retries the reply', () => {
  assert.equal(compactionDoneText({ tokensBefore: 150_000, estimatedTokensAfter: 32_000 }), 'Context compacted · 150k → ~32k tokens');
  assert.equal(compactionDoneText({ tokensBefore: 150_000 }), 'Context compacted · was 150k tokens');
  assert.equal(compactionDoneText({}), 'Context compacted');
  const html = compactionRowHtml({ status: 'done', summary: 'S', tokensBefore: 150_000, estimatedTokensAfter: 32_000, willRetry: true });
  assert.match(html, /Retrying the reply…/);
  assert.match(html, /<details class="compaction-summary"><summary>Summary<\/summary>/);
  assert.doesNotMatch(compactionRowHtml({ status: 'done', summary: 'S' }), /Retrying the reply/);
});

test('cancelled and failed compactions say so instead of claiming success', () => {
  assert.match(compactionRowHtml({ status: 'cancelled' }), /Compaction cancelled/);
  assert.doesNotMatch(compactionRowHtml({ status: 'cancelled' }), /Context compacted/);
  assert.equal(compactionFailedText('Compaction failed: Nothing to compact (session too small)'), 'Compaction failed: Nothing to compact (session too small)');
  assert.equal(compactionFailedText('Summary model unavailable'), 'Compaction failed: Summary model unavailable');
  assert.equal(compactionFailedText(undefined), 'Compaction failed');
  assert.match(compactionRowHtml({ status: 'failed', errorMessage: '<b>bad</b>' }), /Compaction failed: &lt;b&gt;bad&lt;\/b&gt;/);
});

test('HTML in the summary is shown as text, while its markdown still renders', () => {
  const html = compactionRowHtml({ status: 'done', summary: '## Goal\n\n**Ship it** <img src=x onerror=alert(1)>\n\n```html\n<div>kept</div>\n```' });
  assert.match(html, /<h2>Goal<\/h2>/);
  assert.match(html, /<strong>Ship it<\/strong>/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;div&gt;kept&lt;\/div&gt;/);
});

test('token counts and elapsed times are short', () => {
  assert.equal(formatTokenCount(850), '850');
  assert.equal(formatTokenCount(1240), '1.2k');
  assert.equal(formatTokenCount(3000), '3k');
  assert.equal(formatTokenCount(150_400), '150k');
  assert.equal(formatElapsed(4_200), '4s');
  assert.equal(formatElapsed(-50), '0s');
  assert.equal(formatElapsed(125_000), '2m 05s');
});
