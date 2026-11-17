/**
 * Lightweight Markdown renderer — no dependencies.
 * Handles: headings, bold, italic, inline code, code blocks with language,
 * links, unordered/ordered lists, blockquotes, horizontal rules, tables,
 * task lists, images, paragraphs.
 *
 * HTML in the text shows as text, so assistant replies and compaction
 * summaries cannot inject markup. The one exception is `<br>`, which models
 * use for line breaks inside table cells.
 */

export function renderMarkdown(text: string) {
  if (!text) return '';

  // Normalize line endings
  text = text.replace(/\r\n/g, '\n');

  // Extract code blocks first to protect them
  const codeBlocks: CodeBlock[] = [];
  text = extractCodeBlocks(text, codeBlocks);

  // Extract display math after code fences (so $$ inside fences stays literal)
  // but before the line split, since $$...$$ may span multiple lines.
  const mathBlocks: string[] = [];
  text = extractDisplayMath(text, mathBlocks);

  // Split into lines and process block-level elements
  const lines = text.split('\n');
  let html = '';
  let inList = false;
  let listType = '';
  let inBlockquote = false;
  let blockquoteLines: string[] = [];

  // Quoted text lines are joined with <br>; a code block placeholder line
  // becomes the code block itself, with no <br> on either side.
  function flushBlockquote() {
    if (inBlockquote) {
      let body = '';
      let text: string[] = [];
      const flushText = () => {
        if (text.length) body += text.map(l => renderInline(l)).join('<br>');
        text = [];
      };
      for (const l of blockquoteLines) {
        const codeMatch = l.match(CODE_PLACEHOLDER);
        if (codeMatch) {
          flushText();
          body += renderCodeBlock(codeBlocks[Number(codeMatch[1])]);
        } else {
          text.push(l);
        }
      }
      flushText();
      html += '<blockquote>' + body + '</blockquote>';
      inBlockquote = false;
      blockquoteLines = [];
    }
  }

  // The current list item stays open so indented lines after it can join it.
  function flushList() {
    if (inList) { html += `</li></${listType}>`; inList = false; }
  }

  // Opens a list item, continuing the current list when it has the same type.
  // `opening` is the list tag's attributes, used only for a new list.
  function startListItem(type: 'ul' | 'ol', opening: string, itemHtml: string) {
    if (inList && listType === type) {
      html += '</li>';
    } else {
      flushList();
      html += `<${type}${opening}>`;
      inList = true;
      listType = type;
    }
    html += itemHtml;
  }

  // A blank line inside a list keeps the list open when the next non-blank
  // line is indented or is another list item.
  function listContinuesAfter(i: number) {
    while (i < lines.length && lines[i].trim() === '') i++;
    return i < lines.length && (/^\s/.test(lines[i]) || /^([*\-+]|\d+\.)\s/.test(lines[i]));
  }

  // Check if a line is a table separator (e.g. |---|---|)
  function isTableSeparator(line: string) {
    return /^\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line);
  }

  // Check if a line looks like a table row
  function isTableRow(line: string) {
    return line.trim().startsWith('|') && line.trim().endsWith('|');
  }

  // Parse alignment from separator row
  function parseAlignments(line: string) {
    return line.split('|').filter((c: string) => c.trim()).map((cell: string) => {
      const trimmed = cell.trim();
      if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center';
      if (trimmed.endsWith(':')) return 'right';
      return 'left';
    });
  }

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Code block placeholder
    const codeMatch = line.match(CODE_PLACEHOLDER);
    if (codeMatch) {
      // An indented block right after a list item belongs to that item.
      if (!/^\s/.test(line)) flushList();
      flushBlockquote();
      html += renderCodeBlock(codeBlocks[Number(codeMatch[1])]);
      continue;
    }

    // Display math placeholder
    const mathMatch = line.match(/^%%MATHBLOCK(\d+)%%$/);
    if (mathMatch) {
      flushList();
      flushBlockquote();
      html += `<div class="math-block">${mathBlocks[parseInt(mathMatch[1])]}</div>`;
      continue;
    }

    // Table detection: look ahead for header + separator pattern
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushList();
      flushBlockquote();

      const alignments = parseAlignments(lines[i + 1]);

      // Parse header
      const headerCells = line.split('|').filter((c: string) => c.trim() !== '' || line.trim() === '|');
      // More robust: split between first and last pipe
      const headerRow = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');

      html += '<div class="table-wrapper"><table><thead><tr>';
      headerRow.forEach((cell: string, idx: number) => {
        const align = alignments[idx] || 'left';
        html += `<th style="text-align:${align}">${renderInline(cell.trim())}</th>`;
      });
      html += '</tr></thead><tbody>';

      // Skip separator
      i += 2;

      // Parse body rows
      while (i < lines.length && isTableRow(lines[i])) {
        const rowCells = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
        html += '<tr>';
        rowCells.forEach((cell: string, idx: number) => {
          const align = alignments[idx] || 'left';
          html += `<td style="text-align:${align}">${renderInline(cell.trim())}</td>`;
        });
        html += '</tr>';
        i++;
      }

      html += '</tbody></table></div>';
      i--; // back up since the for loop will increment
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushList();
      flushBlockquote();
      html += '<hr>';
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushList();
      flushBlockquote();
      const level = headingMatch[1].length;
      html += `<h${level}>${renderInline(headingMatch[2])}</h${level}>`;
      continue;
    }

    // Blockquote — handle `>` with or without trailing space, and empty `>` lines
    if (/^>\s?/.test(line)) {
      flushList();
      if (!inBlockquote) { inBlockquote = true; blockquoteLines = []; }
      const content = line.replace(/^>\s?/, '');
      if (content === '') {
        // Empty blockquote line acts as paragraph break within quote
        blockquoteLines.push('');
      } else {
        blockquoteLines.push(content);
      }
      continue;
    } else if (inBlockquote) {
      flushBlockquote();
    }

    // Task list (must check before regular list)
    const taskMatch = line.match(/^(\s*)[*\-+]\s+\[([ xX])\]\s+(.+)$/);
    if (taskMatch) {
      const checked = taskMatch[2] !== ' ';
      startListItem('ul', ' class="task-list"', `<li class="task-list-item"><input type="checkbox" disabled ${checked ? 'checked' : ''}><span>${renderInline(taskMatch[3])}</span>`);
      continue;
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)[*\-+]\s+(.+)$/);
    if (ulMatch) {
      flushBlockquote();
      startListItem('ul', '', `<li>${renderInline(ulMatch[2])}`);
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
    if (olMatch) {
      flushBlockquote();
      const start = Number(olMatch[2]);
      startListItem('ol', start === 1 ? '' : ` start="${start}"`, `<li>${renderInline(olMatch[3])}`);
      continue;
    }

    // Empty line. Only the first blank line of a run decides whether the
    // list goes on.
    if (line.trim() === '') {
      if (inList && lines[i - 1].trim() !== '' && !listContinuesAfter(i)) flushList();
      continue;
    }

    // An indented line after a list item is another paragraph of that item.
    if (inList && /^\s/.test(line)) {
      html += `<p>${renderInline(line.trim())}</p>`;
      continue;
    }

    flushList();

    // Regular paragraph
    html += `<p>${renderInline(line)}</p>`;
  }

  // Close any open blocks
  flushList();
  flushBlockquote();

  return html;
}

type CodeBlock = { lang: string; code: string };

// A code block placeholder on its own line, after optional indentation.
const CODE_PLACEHOLDER = /^\s*%%CODEBLOCK(\d+)%%$/;

// Optional quote marker, indentation, three or more backticks or tildes, and
// the info string.
const OPENING_FENCE = /^(\s*>\s?)?([ \t]*)(`{3,}|~{3,})(.*)$/;
const QUOTE_MARKER = /^\s*>\s?/;

/**
 * Replaces each fenced code block with a %%CODEBLOCK<N>%% placeholder line
 * and pushes its language and code into `blocks`. The placeholder keeps the
 * opening fence's quote marker and indentation, so a block inside a quote or
 * list item stays there. It has no underscore, so the italic rule cannot
 * split it.
 *
 * The rules follow CommonMark fenced code blocks: a fence may be indented, a
 * backtick fence's info string has no backticks, and the closing fence uses
 * the same character, is at least as long, and has only whitespace after it.
 * The closing fence may be indented at most three spaces more than the
 * opening fence. Each code line loses up to as many leading spaces or tabs as
 * the opening fence has. A block opened inside a quote ends at the first line
 * without a quote marker. A block that is never closed runs to the end of
 * the text.
 */
function extractCodeBlocks(text: string, blocks: CodeBlock[]) {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(OPENING_FENCE);
    if (!open || (open[3][0] === '`' && open[4].includes('`'))) {
      out.push(lines[i]);
      continue;
    }
    const [, quote = '', indent, fence, info] = open;
    const closing = new RegExp(`^[ \\t]{0,${indent.length + 3}}${fence[0]}{${fence.length},}\\s*$`);
    const code: string[] = [];
    for (i++; i < lines.length; i++) {
      let line = lines[i];
      if (quote) {
        const marker = line.match(QUOTE_MARKER);
        if (!marker) { i--; break; }
        line = line.slice(marker[0].length);
      }
      if (closing.test(line)) break;
      code.push(line.replace(new RegExp(`^[ \\t]{0,${indent.length}}`), ''));
    }
    out.push(`${quote}${indent}%%CODEBLOCK${blocks.push({ lang: info.trim().split(/\s/)[0], code: code.join('\n') }) - 1}%%`);
  }
  return out.join('\n');
}

function renderCodeBlock(block: CodeBlock) {
  return `<div class="code-block-wrapper">`
    + `<div class="code-block-header"><span>${escapeHtml(block.lang || 'code')}</span><button class="copy-btn" onclick="copyCode(this)">Copy</button></div>`
    + `<pre><code>${escapeHtml(block.code)}</code></pre></div>`;
}

/**
 * Lightweight user-message renderer — inline formatting + blockquotes only.
 * Preserves whitespace/newlines for everything else. HTML the user typed is
 * kept as HTML.
 */
export function renderUserMarkdown(text: string) {
  if (!text) return '';
  text = text.replace(/\r\n/g, '\n');

  const mathBlocks: string[] = [];
  text = extractDisplayMath(text, mathBlocks);

  const lines = text.split('\n');
  let html = '';
  let inBlockquote = false;
  let bqLines: string[] = [];

  function flushBq() {
    if (inBlockquote) {
      html += '<blockquote>' + bqLines.map(l => renderInline(l, false)).join('<br>') + '</blockquote>';
      inBlockquote = false;
      bqLines = [];
    }
  }

  for (const line of lines) {
    const mathMatch = line.match(/^%%MATHBLOCK(\d+)%%$/);
    if (mathMatch) {
      flushBq();
      html += `<div class="math-block">${mathBlocks[parseInt(mathMatch[1])]}</div>`;
      continue;
    }
    if (/^>\s?/.test(line)) {
      if (!inBlockquote) { inBlockquote = true; bqLines = []; }
      bqLines.push(line.replace(/^>\s?/, ''));
      continue;
    }
    flushBq();
    html += renderInline(line, false) + '\n';
  }
  flushBq();

  return html.replace(/\n$/, '');
}

/**
 * A link or image URL is safe if it is http(s), mailto, or has no scheme at
 * all (a relative path or #fragment). Browsers ignore whitespace and control
 * characters inside a scheme, so those are removed before checking. An `&`
 * before the first `/`, `?` or `#` is rejected because an HTML entity there
 * could spell out a colon.
 */
function isSafeUrl(url: string) {
  const compact = url.replace(/[\u0000-\u0020\u007f]/g, '');
  if (/^(https?:\/\/|mailto:)/i.test(compact)) return true;
  return !/[:&]/.test(compact.split(/[/?#]/)[0]);
}

/**
 * With `escapeRawHtml`, HTML in the text shows as text, except `<br>`.
 * Without it, HTML passes through, but link and image attributes are still
 * escaped and their URLs checked.
 */
function renderInline(text: string, escapeRawHtml = true) {
  // Keep generated HTML out of later Markdown replacements. Attribute
  // values use the original text, while labels can use the rendered HTML.
  const spans: { html: string; source: string }[] = [];
  const keep = (html: string, source: string) => `%%INLINE${spans.push({ html, source }) - 1}%%`;
  const restore = (value: string, field: 'html' | 'source') =>
    value.replace(/%%INLINE(\d+)%%/g, (match, index: string) => spans[Number(index)]?.[field] ?? match);
  const sourceText = (value: string) => escapeRawHtml ? escapeHtml(value) : value;

  // Inline code (must come first to protect content)
  text = text.replace(/`([^`]+)`/g, (match, code: string) =>
    keep(`<code>${escapeHtml(code)}</code>`, sourceText(match)));

  // Inline math — after inline code (so `$x$` stays code) but before the
  // emphasis regexes, which would otherwise mangle math like $a_i * b_i$.
  const putMath = (match: string, src: string) => keep(renderMath(src.trim(), false), sourceText(match));
  text = text.replace(/\\\((.+?)\\\)/g, putMath);
  // Single-$ form with currency heuristics: opening $ not escaped/doubled and
  // not followed by whitespace; closing $ not escaped, not preceded by
  // whitespace, not followed by a digit ("$5 and $10" stays text).
  text = text.replace(/(?<![\\$])\$(?!\s)((?:\\.|[^$])+?)(?<![\s\\])\$(?!\d)/g, putMath);

  // Escape after code and math are taken out, so their source reaches the
  // code and KaTeX renderers unchanged. Escaped text is already safe inside
  // an attribute; raw text is escaped when it is put into one.
  if (escapeRawHtml) text = escapeHtml(text).replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  const attr = (value: string) => {
    const source = restore(value, 'source');
    return escapeRawHtml ? source : escapeHtml(source);
  };

  // Images (before links so ![...](...) isn't caught by link regex)
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt: string, url: string) =>
    isSafeUrl(restore(url, 'source'))
      ? keep(`<img src="${attr(url)}" alt="${attr(alt)}" class="inline-image">`, restore(match, 'source'))
      : match);

  // Bold + italic
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');

  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
  text = text.replace(/_(.+?)_/g, '<em>$1</em>');

  // Strikethrough
  text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label: string, url: string) =>
    isSafeUrl(restore(url, 'source'))
      ? keep(`<a href="${attr(url)}" target="_blank" rel="noopener">${restore(label, 'html')}</a>`, restore(match, 'source'))
      : match);

  // Auto-link bare URLs. A URL stops at a quote so it cannot close the href.
  text = text.replace(/(^|[^"'])(https?:\/\/[^\s<"']+)/g, (_, prefix: string, url: string) =>
    prefix + keep(`<a href="${attr(url)}" target="_blank" rel="noopener">${restore(url, 'html')}</a>`, restore(url, 'source')));

  return restore(text, 'html');
}

type Katex = {
  renderToString(tex: string, opts: { displayMode: boolean; throwOnError: boolean }): string;
};

function renderMath(src: string, displayMode: boolean) {
  const katex = (globalThis as { katex?: Katex }).katex;
  if (!katex) return `<code class="math-fallback">${escapeHtml(src)}</code>`;
  try {
    return katex.renderToString(src, { displayMode, throwOnError: false });
  } catch {
    return `<code class="math-fallback">${escapeHtml(src)}</code>`;
  }
}

// Replaces $$...$$ and \[...\] segments with %%MATHBLOCK<N>%% placeholders on
// their own lines, pushing the KaTeX-rendered HTML into `blocks`. The
// placeholder deliberately has no underscore (matching %%INLINE0%%) so the
// italic regex can never split it.
function extractDisplayMath(text: string, blocks: string[]) {
  const put = (_: string, src: string) =>
    `\n%%MATHBLOCK${blocks.push(renderMath(src.trim(), true)) - 1}%%\n`;
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, put);
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, put);
  return text;
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Global copy function for code blocks. Guarded so the module can be imported
// under node --test, where there is no window.
if (typeof window !== 'undefined') {
  window.copyCode = function(btn) {
    const wrapper = btn.closest('.code-block-wrapper');
    if (!wrapper) return;
    const codeBlock = wrapper.querySelector('code');
    if (!codeBlock) return;
    const text = codeBlock.textContent || '';
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('copied');
      }, 2000);
    });
  };
}
