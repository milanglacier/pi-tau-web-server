## Findings

### [P2] Invalidate stale suggestions as soon as the input changes

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/completion-list.ts:133-135`

Changing the input only schedules a refresh; it does not abort the previous request, invalidate its request ID, or clear its suggestions. With the directory field's 100 ms debounce, a response for `a` can arrive after the user changes the text to `b`, pass the stale-response check, and let Tab replace `b` with an unrelated `alpha/` path. Already displayed suggestions remain selectable during the same interval. Invalidate pending requests and clear outdated items immediately on input, before scheduling the next lookup.

### [P2] Preserve the final dot component when expanding tilde paths

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/server/path-completion.ts:26-30`

For a prefix such as `~/.`, `path.join` removes the final `.` before the prefix is split into its directory and partial name. The endpoint consequently searches the home directory's parent for the user's home name instead of listing hidden directories inside the home directory; accepting the result selects the wrong path. Split off the partial name before normalizing the directory, or expand `~` without normalizing away the unfinished component.

### [P2] Refresh model suggestions when the model list finishes loading

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/app-main.ts:719-721`

On the first popup opening, typing a model query before `get_available_models` returns searches the initially empty array. When the response arrives, this assignment does not refresh the completion list, so matching models remain invisible until another input event occurs. This is reproducible with a delayed response and leaves a completed query without suggestions even after loading succeeds. Refresh the focused model field when the list arrives, or make its lookup await the pending model-list request.

**User decision:** Do not fix this finding. Suggestions appear on the next input event after the model list arrives, so the user considers the impact on the experience too small to justify the added complexity.

## Overall assessment

**Verdict:** Patch is incorrect.

**Explanation:** Type checking and all 256 unit tests passed, but targeted browser checks confirmed stale directory results can replace newer input and delayed model loading leaves suggestions empty. Tilde-prefixed dot-directory completion also returns results from the wrong directory.

## Fix summaries

### Finding 1: Fixed stale suggestions

`src/public/completion-list.ts` clears the list, aborts pending requests, and invalidates their results immediately when the input changes. Accepting a directory also clears its previous suggestions before loading the next level. Two browser regression tests cover clearing displayed suggestions and rejecting a delayed result even when the lookup ignores cancellation.

### Finding 2: Fixed tilde-dot path completion

`src/server/path-completion.ts` expands `~` without normalizing the unfinished path component. Four unit tests use a temporary home directory to cover `~/.`, a nested dot prefix, `~/..`, and trailing slashes.

### Validation

Type checking passed. All 260 unit tests and all 6 completion browser tests passed. The full end-to-end suite was not run. The model-list refresh behavior remains unchanged, as requested.
