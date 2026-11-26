## Findings

### [P1] Bind deferred command handling to the submitted draft and tab

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/app-main.ts:1585-1587`

Submitting `/settings` before the command list loads schedules `sendMessage()` against the current textarea and active tab, not the original submission. If the user replaces the text or switches tabs and starts another draft while the request is pending, that unsubmitted draft is sent without another Enter. Both scenarios were reproduced with a delayed command response. Capture the original text and session, and cancel deferred handling when either changes.

### [P2] Invalidate pending completions when a message is sent

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/completion-list.ts:167-169`

Typing `@ap` and pressing Enter before suggestions arrive sends the message and clears the textarea, but leaves the completion request valid: clearing the value does not dispatch an input event or close completion. Its response then opens suggestions on the empty composer, and Tab or Enter inserts the previous message's file reference. Close completion on submission and programmatic clearing, or reject results when the captured text and caret no longer match.

### [P2] Put exact slash-command names ahead of longer matches

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/slash-commands.ts:108-112`

When Pi lists `review-code` before `review`, querying `review` returns `review-code` first because the reused fuzzy matcher gives both prefix matches the same score and preserves their original order. Consequently, typing the complete `/review` and pressing Enter replaces it with `/review-code ` instead of running `/review`; the `alreadyTyped` exception only checks the highlighted row. Rank exact full command names before fuzzy or prefix matches.

### [P2] Refresh commands when a new slash menu opens

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/composer-completion.ts:115-117`

Sending a fully typed `/model` clears the textarea without an input event, so `commandMenuSession` remains set. Typing `/` again in that tab reuses the cached commands without requesting `get_commands`; dismissing the menu with Escape likewise leaves the marker set. Added or removed commands therefore remain stale after an extension reload. Track new menu openings and reset this marker on submission or dismissal, rather than only on non-slash input.

### [P2] Separate the fd pattern from command-line options

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/server/file-completion.ts:81-83`

Queries beginning with `-` are passed directly to `fd`, which interprets them as options instead of filename patterns. For example, `searchFiles('--help', cwd)` returns a fabricated file suggestion with the path `  -h, --help` from fd's help output, while other dash-prefixed queries fail silently. Insert the `--` option terminator before passing the search pattern so these filenames can be completed correctly.

### [P2] Recognize Windows drive-qualified absolute paths

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/server/file-completion.ts:191-193`

On Windows, an absolute query such as `D:/docs/gu` is treated as relative because only a leading `/` is recognized. Joining its directory to a session cwd such as `C:\project` produces `C:\project\D:\docs\`, so the scoped search fails and cannot complete the requested absolute path. Use the platform's absolute-path check before joining the directory to the session cwd.

### [P2] Check cancellation and deadlines before each directory read

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/server/file-completion.ts:140-144`

The fallback checks cancellation and its deadline only while processing returned entries. If queued directories are empty or unreadable, it continues reading them after cancellation or deadline expiry, which can keep obsolete searches doing filesystem work on slow mounts. An in-memory reproduction with 1,000 empty directories performed all 1,002 reads despite aborting at the first child directory. Check the stop conditions before each `readdir`, including paths that otherwise reach `catch` and continue.

### [P3] Preserve filename whitespace when parsing fd output

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/server/file-completion.ts:106-106`

`stdout.trim()` removes meaningful leading whitespace from the first filename and trailing whitespace from the last filename. For example, fd output containing ` leading.txt` becomes the suggestion `leading.txt`, so accepting it references a different or nonexistent file. Remove only output separators, or use NUL-delimited output, rather than trimming filename characters.

## Overall assessment

**Verdict:** Patch is incorrect.

**Explanation:** Reviewed `feat/input-at-file-and-slash-completion` against `main` from merge base `96d2afb39f3e4de3afbf96732fa4e17674dfeaa4`. The patch has an unintended-submission race and completion correctness and cancellation bugs. Typechecking, all 375 unit/HTTP tests, and all 114 end-to-end tests pass, but do not cover the reproduced cases.

## Revisit and decisions

Each finding was weighed by how likely a user is to hit it in daily use and by
how much code the fix needs.

| Finding | How likely | Decision |
|---|---|---|
| [P1] Deferred command handling | Rare. The text or the tab must change in the few milliseconds before `get_commands` answers, the first time a Tau-handled command is sent in a tab. The result, a draft sent without Enter, is serious. | Fix. Lower to P2. |
| [P2] Pending completions after send | Common. Typing `@file` and pressing Enter at once is normal, and `fd` takes long enough for the late answer to arrive. | Fix. |
| [P2] Exact command names first | Common. Pairs like `review` and `review-code` are a normal way to name skills and prompts, and the wrong command runs without any sign. | Fix. |
| [P2] Refresh commands on a new menu | Rare. Only matters after an extension reload, which happens mostly while developing extensions, and the list refreshes after any non-slash typing. | Fix partly: reset the cached marker when a message is sent. Leave Escape as it is, because tracking each menu opening is more state than the gain is worth. |
| [P2] `--` before the fd pattern | Rare. File names starting with `-` are uncommon, but the fix is one line. | Fix. |
| [P2] Windows drive-qualified paths | Only on Windows, which is not a tested or supported platform. Fixing one Windows path case suggests support that is not there. | Do not fix. |
| [P2] Stop checks before each directory read | Only without `fd`, on a slow mount, with many empty or unreadable folders. The cost is wasted background reads that the user cannot see. | Fix, since it only moves an existing check. Lower to P3. |
| [P3] Whitespace in fd output | Only for names that start or end with a space, and only when they are the first or last result. | Fix by dropping `trim()`. NUL-delimited output is not needed. |

## Fix summary

- `src/public/app-main.ts`: the deferred send after loading Pi's command list
  happens only if the input still holds the same text and the same tab is
  still being viewed. Every path that sends a message and clears the input
  also closes the composer menu.
- `src/public/completion-list.ts`: when suggestions arrive, they are shown
  only if the text and caret still match the request. Otherwise the list
  closes. This covers any code that changes the input without an `input`
  event.
- `src/public/composer-completion.ts`: closing the composer menu from code
  also forgets which tab's command list the current menu has read, so the
  next `/` menu after a sent message reads Pi's list again.
- `src/public/slash-commands.ts`: a command whose full name equals the query
  is moved to the top of the matches.
- `src/server/file-completion.ts`: `--` goes before the `fd` pattern. Only
  empty lines are removed from `fd` output, so spaces in names are kept. The
  fallback checks cancellation and its deadline before reading each folder.

Checked with typecheck, 375 unit and HTTP tests, and the end-to-end suite.
Real `fd` runs now find `-dash.txt` for `-da`, return nothing for `--help`,
and keep ` lead.txt` with its leading space. `/review` now ranks above
`/review-code`. The end-to-end test "typing a model name lists matching
models" fails now and then. It also failed on the code before these fixes,
in 1 of 12 runs of that file alone. The likely cause, not yet confirmed, is
that typing starts before the popup has loaded its model list. In full-suite
runs it failed in 2 of 7 runs with these fixes and in 0 of 9 without them, so
the fixes may make it fail more often and it needs a closer look.

## Follow-up: Windows drive-qualified paths

The Windows finding is now fixed after all, because the fix is one line and
does not claim wider Windows support. A query folder is treated as absolute
when `path.isAbsolute` says so, instead of only when it starts with `/`. On
Linux and macOS this is the same check as before. On Windows, a query such as
`D:/docs/gu` now searches `D:/docs/` instead of a folder under the session
cwd. No other Windows path handling was changed or tested. Checked with
typecheck and the unit and HTTP tests on Linux.
