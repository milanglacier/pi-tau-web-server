# Plan: render built-in tool calls (bash, edit, read, write) cleanly instead of raw JSON

Branch: `feat/builtin-tool-call-rendering`

## Goal

Show built-in `bash`, `edit`, `read`, and `write` tool calls in clear, task-specific formats instead of dumping their raw JSON argument objects. Keep live cards and saved history cards consistent.

## Agreed decisions

1. **`bash`**:
   - Bundle the Highlight.js Bash grammar (`es/languages/bash.min.js`, ~3.2 KB) alongside the existing JavaScript grammar so Bash highlighting works offline.
   - Render `args.command` in the same code-block widget used for `codemode`, with Bash syntax highlighting and a `Copy code` button that copies the exact command string.
   - When `args.timeout` is present, show it in the code-block header label (for example `Bash · timeout 30s`) so it stays visible without polluting the copied command.
2. **`edit`**:
   - Support Pi's current `args.edits: [{ oldText, newText }, ...]` format as well as single-edit objects, JSON-encoded `edits` strings, and legacy top-level `oldText`/`newText` (`old_text`/`new_text`), including empty replacement strings (`""`).
   - Compute a line-by-line diff within each `{ oldText, newText }` block so unchanged lines appear as neutral context (`  line`), removed lines appear with `- ` and red diff styling, and added lines appear with `+ ` and green diff styling.
   - Separate multiple blocks in `edits[]` with a subtle divider inside `.tool-diff`.
3. **`read`**:
   - Append the line range directly to the path preview in the card header as `:start` or `:start-end` (for example `src/foo.ts:1-100` when `offset: 1, limit: 100`, or `src/foo.ts:50` when `offset: 50`), matching Pi's compact range format.
   - Omit the redundant `.tool-args` JSON box when `read` only has standard arguments (`path`/`file_path` and optional valid `offset`/`limit`), so expanding a `read` card shows the file output directly.
4. **`write`**:
   - Do not bundle extra language grammars beyond JavaScript and Bash.
   - Render `args.content` in the multi-line code-block widget with a `Copy code` button instead of a single-line escaped JSON string.
   - Highlight the block when the target file path ends in `.js`/`.mjs`/`.cjs` (JavaScript) or `.sh`/`.bash`/`.zsh` (Bash); otherwise render it as plain monospace text with the file path/extension label in the code-block header.
5. **Fallbacks & safety**:
   - Treat all tool arguments as untrusted text (never raw HTML). If highlighting assets fail to load, show escaped plain source.
   - Fall back to formatted JSON whenever a tool call is missing its expected primary field or carries unexpected extra fields.

## Implementation

### 1. Local Bash highlighting and shared code-block renderer

- Update `scripts/copy-highlight.ts` to copy `es/languages/bash.min.js` into `public/vendor/highlight/bash.min.js`.
- Declare `*vendor/highlight/bash.min.js` in `src/public/highlight-vendor.d.ts` and add `/vendor/highlight/bash.min.js` to the service-worker cache list in `src/public/sw.ts`.
- Extend `src/public/javascript-code-block.ts` (keeping existing exports for compatibility) with:
  - `highlightBash(source: string): string`
  - A general `createCodeBlock(source: string, options?: { language?: 'javascript' | 'bash'; label?: string }): HTMLElement` that renders the header label, `Copy code` button, and `<pre><code>` content with safe fallback when highlighting is unavailable.
- Update `public/style.css` so syntax color variables and `.hljs-*` rules apply to all highlighted code blocks (`.code-block-wrapper`), including Bash tokens such as `.hljs-variable` alongside existing classes, in both dark and light themes.

### 2. `bash` tool argument rendering

- In `src/public/tool-card.ts`, when `toolName` is `bash` (or `Bash`), `typeof args?.command === 'string'`, and there are no unexpected argument keys beyond `command` and `timeout` (with `timeout` omitted/null or a finite number):
  - Build the header label as `Bash` or `Bash · timeout ${args.timeout}s`.
  - Render `createCodeBlock(args.command, { language: 'bash', label })` inside `.tool-args.tool-code-args`.

### 3. `edit` tool diff rendering

- In `src/public/tool-card.ts`, unify argument rendering between `createToolCard` and `createHistoryCard` so both go through `renderArguments(toolName, args)`.
- Add an `extractEdits(args)` helper that normalizes:
  - `args.edits` array of `{ oldText, newText }` / `{ old_text, new_text }`
  - `args.edits` as a single edit object or JSON string
  - Legacy top-level `oldText`/`newText` (`old_text`/`new_text`)
  - Rejects unknown extra keys or non-string `oldText`/`newText` so malformed calls still fall back to JSON.
- Update `renderDiff` to accept one or more `{ oldText, newText }` blocks:
  - Compute a line-level LCS diff between `oldText.split('\n')` and `newText.split('\n')`.
  - Render removed lines (`.diff-line.diff-removed`, `- `), added lines (`.diff-line.diff-added`, `+ `), and unchanged context lines (`.diff-line.diff-context`, `  `).
  - Render a divider between multiple blocks when `edits.length > 1`.

### 4. `read` and `write` tool rendering

- **`read`**:
  - Add `formatReadLineRange(offset, limit)` (matching Pi's `:start` and `:start-end` calculation).
  - In `getArgsPreview(toolName, args)`, when `toolName` is `read`/`Read` and `path` (or `file_path`) is a string, return `${path}${formatReadLineRange(args.offset, args.limit)}`.
  - In `renderArguments(toolName, args)`, when `toolName` is `read`/`Read` with a string `path`/`file_path`, no unexpected keys, and valid optional `offset`/`limit`, return `undefined` so no `.tool-args` element is inserted.
- **`write`**:
  - In `renderArguments(toolName, args)`, when `toolName` is `write`/`Write`, `typeof args?.content === 'string'`, `typeof (args.path ?? args.file_path) === 'string'`, and there are no unexpected keys:
    - Detect whether the file path ends in `.js`/`.mjs`/`.cjs` (`language: 'javascript'`, label `'JavaScript'`) or `.sh`/`.bash`/`.zsh` (`language: 'bash'`, label `'Bash'`); otherwise use plain text with the file path (or extension) as the header label.
    - Render `createCodeBlock(args.content, { language, label })` inside `.tool-args.tool-code-args`.

## Verification

- Add unit tests in `test/javascript-code-block.test.ts` (or a dedicated tool-card / highlighting unit test) covering:
  - Bash syntax highlighting and whitespace preservation.
  - Line-level diff computation (context lines, added/removed lines, empty `oldText`/`newText`, multiple `edits[]` blocks).
  - `read` line range formatting (`:1-100`, `:50`, omitted range, malformed values).
- Extend browser e2e tests in `test/e2e/history-render.e2e.ts` covering live and history cards for:
  - `bash` with and without `timeout`, verifying Bash highlighting, timeout label in the code-block header, and exact `Copy code` behavior.
  - `edit` with `edits: [{ oldText, newText }]` (including multi-line context and multiple edit blocks) as well as legacy `oldText`/`newText`.
  - `read` with `offset` and `limit` showing `path:start-end` in the header and no redundant `.tool-args` block in the body.
  - `write` with multi-line `content`, verifying unescaped multi-line display and `Copy code`.
  - JSON fallbacks when required fields are missing or invalid.
- Run `npm run typecheck`, `npm test`, and focused/full browser e2e tests.
