import { parseArgs } from 'node:util';
import katex from 'katex';
import { PRESETS, buildSession } from './fixtures.ts';

// Measures, without a browser, the string work the page does to turn a
// session's history into HTML: parsing the snapshot, building history items,
// rendering Markdown and math, highlighting code arguments, and diffing edit
// arguments. It shows which of these grows with session size. Layout, style
// and painting are not included; benchmark/tab-switch.ts covers those.
//
//   npm run benchmark:render -- --preset long --iterations 10

const { values: options } = parseArgs({
  options: {
    preset: { type: 'string', default: 'typical,long,images' },
    iterations: { type: 'string', default: '5' },
  },
});

// Math renders through KaTeX in the browser; give the Markdown renderer the
// same library here.
(globalThis as { katex?: unknown }).katex = katex;

const { buildHistoryItems } = (await import('../public/history-render.js')) as any;
const { renderMarkdown, renderUserMarkdown } = (await import('../public/markdown.js')) as any;
const { highlightBash, highlightJavaScript } = (await import('../public/javascript-code-block.js')) as any;
const { computeLineDiff, extractEdits } = (await import('../public/tool-card.js')) as any;

const iterations = Math.max(1, Number(options.iterations) || 1);

function median(values: number[]) {
  const sorted = [...values].sort((x, y) => x - y);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function measure(fn: () => void) {
  fn();
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  return median(times);
}

type Item = { kind: string; content?: unknown; toolName?: string; args?: Record<string, unknown> };

for (const name of options.preset.split(',').map(value => value.trim()).filter(Boolean)) {
  if (!PRESETS[name]) throw new Error(`Unknown preset "${name}". Known presets: ${Object.keys(PRESETS).join(', ')}`);
  const { entries } = buildSession(PRESETS[name], name, '/tmp/benchmark');
  const body = JSON.stringify({ entries });
  const items: Item[] = buildHistoryItems(entries).items;

  const assistantTexts = items.flatMap(item => item.kind === 'assistant' && Array.isArray(item.content)
    ? (item.content as Array<{ type: string; text?: string }>).filter(block => block.type === 'text').map(block => block.text || '')
    : []);
  const userTexts = items.filter(item => item.kind === 'user').map(item => String(item.content || ''));
  const tools = items.filter(item => item.kind === 'toolCall');
  const bashCommands = tools.filter(tool => tool.toolName === 'bash').map(tool => String(tool.args?.command || ''));
  const jsWrites = tools
    .filter(tool => tool.toolName === 'write' && String(tool.args?.path || '').endsWith('.js'))
    .map(tool => String(tool.args?.content || ''));
  const edits = tools.filter(tool => tool.toolName === 'edit').flatMap(tool => extractEdits(tool.args) || []);

  const rows: Array<[string, number]> = [
    ['parse snapshot JSON', measure(() => JSON.parse(body))],
    ['build history items', measure(() => buildHistoryItems(entries))],
    [`Markdown, ${assistantTexts.length} replies`, measure(() => assistantTexts.forEach(text => renderMarkdown(text)))],
    [`Markdown, ${userTexts.length} user messages`, measure(() => userTexts.forEach(text => renderUserMarkdown(text)))],
    [`highlight, ${bashCommands.length} bash commands`, measure(() => bashCommands.forEach(command => highlightBash(command)))],
    [`highlight, ${jsWrites.length} JavaScript writes`, measure(() => jsWrites.forEach(content => highlightJavaScript(content)))],
    [`diff, ${edits.length} edits`, measure(() => edits.forEach((edit: { oldText: string; newText: string }) => computeLineDiff(edit.oldText, edit.newText)))],
  ];
  const total = rows.reduce((sum, [, ms]) => sum + ms, 0);

  console.log(`${name}: ${entries.length} entries, ${items.length} history items, ${(body.length / 1e6).toFixed(1)} MB snapshot`);
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, ms] of rows) {
    console.log(`  ${label.padEnd(width)}  ${ms.toFixed(1).padStart(8)} ms  ${((ms / total) * 100).toFixed(0).padStart(3)}%`);
  }
  console.log(`  ${'total'.padEnd(width)}  ${total.toFixed(1).padStart(8)} ms`);
  console.log();
}
