# Plan: `@` file completion and `/` command completion in the chat input

Branch: `feat/input-at-file-and-slash-completion`

## Goal

Make the chat input work like the Pi terminal editor:

1. Typing `@` suggests files and folders. Accepting a suggestion inserts
   `@path/to/file ` into the text, just as Pi's terminal does.
2. Typing `/` at the start of the input suggests commands: Pi's extension
   commands, prompt templates, and skills, plus the few built-in commands Tau
   runs itself.
3. Remove the file browser sidebar (the folder button in the header) and all
   code that only exists to support it.

## Findings

### How Pi's terminal does `@`

- Pi's `@` handling is purely client-side (`CombinedAutocompleteProvider` in
  `@earendil-works/pi-tui`, `dist/autocomplete.js`). The prompt Pi sends to
  the model contains the literal text `@src/foo.ts`; nothing is expanded or
  attached. Tau can match this by inserting the same text.
- Pi searches with `fd`, using `~/.pi/agent/bin/fd` (`$PI_CODING_AGENT_DIR/bin`)
  first, then `fd` on `PATH`. It respects `.gitignore`, includes hidden files,
  follows symlinks, and skips `.git`.
- Search algorithm (`getFuzzyFileSuggestions`):
  - If the query contains `/`, everything up to the last `/` is a base folder,
    resolved as `~/…` (home), `/…` (absolute), or relative to the cwd. The
    rest is the query. If that folder does not exist, the cwd is searched with
    the whole query.
  - Two `fd` runs: depth 1 in the base folder, then recursive. Each is capped
    at 100 results, and the results are merged without duplicates.
  - Score: exact name 100, name starts with query 80, name contains query 50,
    path contains query 30, plus 10 for folders. Ties are broken by depth,
    then path length, then alphabetical order. Show the top 20.
  - A path containing spaces is inserted quoted: `@"my file.txt"`. Typing
    `@"` starts a quoted query.
  - Accepting a file adds a trailing space. Accepting a folder inserts
    `@dir/` with no space, so the user can keep drilling down.
- The `@` token starts after a space, tab, quote, `=`, or newline, and may
  sit after an opening bracket or backtick, as in `(@src/a`.

### What RPC mode offers for `/`

- `get_commands` returns extension commands, prompt templates, and skills,
  with `name`, `description` and `source` (`extension` / `prompt` / `skill`).
  On this machine it lists `/reg`, `/regenerate`, `/session-model`, `/bg`,
  `/workflow`, `/yolo`, `/mcp`, `/llama`, `/review`, and every `/skill:*`.
  Sending `/name args` through the normal `prompt` command runs it.
- Built-in terminal commands (`/settings`, `/tree`, `/model`, …) are not in
  that list and do not run over RPC. If they are sent, the model receives the
  literal text. Tau already intercepts `/compact` for this reason.
- Argument completion (`getArgumentCompletions`) and
  `ctx.ui.addAutocompleteProvider()` are not exposed over RPC. Only command
  names can be completed.
- Tau's own bundled extension registers `/tau-tree-navigate`. It must not
  appear in the menu.
- Whether an extension command works in Tau depends on the UI calls it makes:
  `select`, `confirm`, `input`, `editor` and `notify` work; `ctx.ui.custom()`
  returns `undefined` in RPC mode; Tau ignores `setStatus`, `setWidget`,
  `setTitle` and `set_editor_text`. This plan does not change that.

## Decisions

- The `/` menu lists Pi's `get_commands` results plus these Tau built-ins,
  which map to features Tau already has:
  `/compact [instructions]`, `/tree`, `/export`, `/session`, `/model`.
- `@` completion matches Pi's terminal: relative paths search the session
  cwd, and `@~/…` and `@/absolute/…` reach outside it.
- File search uses `fd`, located the way Pi locates it. If `fd` is missing,
  a bounded Node directory walk is used instead. It skips common heavy
  folders (`node_modules`, `.git`, `dist`, …) but does not read
  `.gitignore`.
- When the user sends a terminal-only built-in that RPC cannot run (for
  example `/settings`), Tau keeps the text in the input and shows a note
  saying the command only works in Pi's terminal. A command name that
  appears in the session's `get_commands` list is never blocked; `/mcp` and
  `/llama` are sent to Pi, for example.
- The plug-shaped command palette button next to the input stays unchanged.

## Part 1: server

### File search endpoint

Add `GET /api/complete/files?sessionId=<id>&query=<text>` in a new module
`src/server/file-completion.ts`:

- `sessionId` is required, and the session's cwd is the base for relative
  queries. A missing session returns 404. A missing `sessionId` returns 400.
- `query` is the raw text after `@`, without the `@` and without the
  opening `"` of a quoted query.
- Port Pi's algorithm described above: scoped base folder, a depth-1 pass
  plus a recursive pass, scoring, sorting, and the top-20 cap.
- Response: `{ items: [{ name, path, isDirectory }] }`. `path` is the text
  to insert after `@`, written relative to the cwd, or kept in the user's
  `~/` or absolute form, with a trailing `/` for folders. The client adds the
  `@` and the quotes.
- Locate `fd` once and remember it: `$PI_CODING_AGENT_DIR/bin/fd` (default
  `~/.pi/agent/bin/fd`), then `fd`, then `fdfind` (the Debian name) on
  `PATH`. Kill the `fd` process when the HTTP request is closed.
- Node fallback: breadth-first walk with a visited-entry cap (about 20 000)
  and a time cap, skipping the heavy-folder list. This list is the current
  `IGNORED_NAMES` from `server-main.ts`, minus the entries that are files.
  The walk feeds the same scoring.
- Unreadable or missing folders return an empty list, not an error.
- The route goes through the normal auth check, like every other `/api/`
  route.

### Commands

- Read the session's commands through `/api/rpc` with `get_commands`, which
  is already forwarded to the Pi child. Filter `tau-tree-navigate` out on the
  server so no client ever sees it. If adding a filtered pass-through to
  `handleRpcCommand` is awkward, add
  `GET /api/live-sessions/:id/commands` instead.

## Part 2: client

### Completion engine for the textarea

`src/public/completion-list.ts` only works with an `<input>`, and it
replaces the whole value. Generalize it, keeping the launcher fields'
behavior unchanged:

- Accept an `HTMLInputElement` or an `HTMLTextAreaElement`.
- Let a caller supply a context function. It looks at the text before the
  caret and returns the range to replace plus the query, or `null` for no
  menu. Accepting a row replaces only that range and places the caret after
  it.
- Allow a per-row choice to re-query after accepting, so folders drill down
  and files do not.
- An option to open the list above the input. The chat input sits at the
  bottom of the screen.

Put the token parsing in a pure module, `src/public/composer-tokens.ts`, so
it can be unit-tested without a browser:

- `findAtToken(textBeforeCaret)`: Pi's rules for the `@` token, including
  `@"…` quoted queries and opening brackets or backticks.
- `findSlashToken(textBeforeCaret)`: matches only when the whole text before
  the caret is `/` followed by non-space characters, at the very start of the
  input, which is what Pi's terminal does.
- `formatFileInsertion(path, quoted)`: adds `@`, adds quotes when the path
  contains spaces or the query was quoted, and adds a trailing space for
  files.

### Wiring in `app-main.ts`

- `@`: debounce about 100 ms, abort the earlier request, and call
  `/api/complete/files` for the viewed tab. Rows show the name, with the
  path dimmed on the right.
- `/`: when the menu opens, fetch `get_commands` for the viewed tab and cache
  the result by session id. Fetch again the next time a `/` menu opens, since
  commands can change after a reload. Merge the Tau built-ins in. Match
  fuzzily on the name, and also on the bare name for skills (`tdd` finds
  `skill:tdd`), as Pi does. Each row shows a badge (`extension`, `prompt`,
  `skill`, `tau`) and the description. Accepting inserts `/name `.
- Keys while the menu is open: the first row starts highlighted, as in Pi.
  Arrow keys move the highlight. Tab or Enter accepts. Escape only closes the
  menu and must not abort a running reply. Enter must not send the message
  while the menu is open. This means the completion keydown handler has to
  run before the existing Enter-to-send handler, and both keep the IME
  composition guard.
- Clicking or tapping a row accepts it without blurring the input.
- With no live tab selected, show no menu.

### Sending

Extend the command parsing next to `parseCompactCommand` (in
`compact-command.ts`, or a renamed `slash-commands.ts`):

- `/tree`, `/export`, `/session`, `/model` on their own run the same actions
  as the command palette and the model button, then clear the input.
- A name from the list of terminal-only built-ins (`settings`, `thinking`,
  `scoped-models`, `login`, `logout`, `new`, `resume`, `name`, `fork`,
  `clone`, `import`, `copy`, `share`, `bug`, `trust`, `reload`, `hotkeys`,
  `changelog`, `quit`, plus the Tau built-ins when they are given arguments
  they do not take) is blocked with a note in the transcript, and the text
  stays in the input. A name that appears in the cached `get_commands` list
  for that tab is never blocked.
- Anything else that starts with `/` is sent to Pi unchanged, as today.

## Part 3: remove the file browser

- `public/index.html`: the `#file-sidebar-toggle` header button, the whole
  `#file-sidebar` panel, and the "use the file browser sidebar" sentence in
  the attach button's tooltip. The new tooltip mentions `@`.
- Delete `src/public/file-browser.ts`.
- `src/public/app-main.ts`: the file sidebar setup, its reload on tab switch,
  the `/api/health` platform lookup that only sets the "Open in file manager"
  tooltip, the `tau-file-sidebar` localStorage handling, `pendingFilePaths`
  and the file-path chips in `renderAttachmentPreviews`, `IMAGE_EXTS`, and
  `getFileChipIcon`. Image attachments (button, paste, OS drag and drop) stay.
- `src/public/app-types.ts`: `PendingFilePath`.
- `public/style.css`: the `file-sidebar*`, `file-item`, `file-list`,
  `file-loading`, `file-chip*` and `file-drop-hover` rules, plus any
  mobile-only rules that hide the panel.
- Server: the `/api/files` and `/api/file/preview` routes, `serveFileList`,
  and `serveFilePreview`. `IGNORED_NAMES` moves to the new file-completion
  module. `/api/open` stays, because the sidebar's "export session" action
  uses it. Its `sessionId` branch in `resolveOpenPath` has no caller left and
  is removed.
- Tests: remove the `/api/files` and `/api/file/preview` cases in
  `test/http-routes.test.ts`.
- Docs: replace README's "File Browser" section with a short section on `@`
  and `/` completion. Remove the "File browser hidden" line from `MOBILE.md`.

## Tests

- Unit, `composer-tokens`: `@` after a space, at the start, after `(` and
  a backtick, inside `@"…`, and not in `a@b` (an email address);
  `/` only at the very start and only before the first space; insertion
  quoting and trailing spaces.
- Unit, `file-completion`: scoring and ordering, scoped queries (`src/`,
  `~/`, absolute paths), the fallback walk skipping heavy folders, and the
  result cap. Test the `fd` path when `fd` is on `PATH` and skip it
  otherwise.
- Unit, command parsing: the Tau built-ins, blocking of terminal-only names,
  never blocking a name in the `get_commands` list, and `/compact` unchanged.
- HTTP, `/api/complete/files`: 400 without `sessionId`, 404 for an unknown
  session, results for a live session, and auth required when auth is on.
- E2E, a new `test/e2e/composer-completion.e2e.ts`: typing `@ap` and pressing
  Tab inserts `@src/app.ts `; accepting a folder drills down; typing `/`
  shows a prompt template from a fixture and the Tau built-ins; Enter with
  the menu open accepts instead of sending; Escape closes the menu without
  aborting; `/settings` is blocked with a note. Keep the full e2e run near
  35 seconds, and close pages after each test.
- Run `npm run typecheck`, `npm test`, and `npm run test:e2e`.

## Changelog

Under `## [Unreleased]`:

- Added: typing `@` in the chat input suggests files and folders, and
  typing `/` suggests Pi's extension commands, prompt templates, and skills,
  plus Tau's own commands.
- Added: terminal-only Pi commands such as `/settings` are no longer sent to
  the model as text. Tau keeps them in the input and explains why.
- Removed: the file browser sidebar. Use `@` in the chat input to reference
  files.

## Rollout steps

1. Server file-completion module with unit and HTTP tests.
2. Generalize `completion-list.ts` and confirm the launcher e2e still passes.
3. `composer-tokens.ts` with unit tests.
4. Wire `@` completion into the chat input.
5. Wire `/` completion, then the built-in and blocked command handling.
6. Remove the file browser (client, server, CSS, tests).
7. Docs, changelog, and the e2e file. Run all checks.

## Out of scope

- Rendering the extension updates Tau ignores today (`setStatus`, text-only
  `setWidget`, `setTitle`, `set_editor_text`). Left for a future branch.
