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
