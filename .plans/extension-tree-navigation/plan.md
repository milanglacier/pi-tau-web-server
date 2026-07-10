# Replace out-of-process jsonl editing with a tau-bundled pi extension for tree navigation

## Context

The `feat/session-tree` branch implements a /tree-style session tree view. Reading the tree uses pi's native `get_tree` RPC command, but **moving the leaf** (rollback/navigation) is done by out-of-process file surgery: `src/server/tree.ts` dynamically imports the pi SDK, opens the session `.jsonl` with `SessionManager.open()`, calls `branch()`/`resetLeaf()`, appends a `tau:navigate-tree` marker entry, then forces the live `pi --mode rpc` child to reload the file via a same-path `switch_session`. This works but requires rollback markers, `beforeMutate` re-checks, a runtime pi-SDK peer dependency, and relies on undocumented SDK/reload behavior.

The maintainer asked whether this is the only way — specifically, whether tau could instead ship an **in-project pi extension** and trigger it over RPC. **Answer: yes, and it is strictly better.** Per `references/pi-development-guide.md` (verified against the installed pi dist):

- Extensions can be loaded via the `--extension/-e <path>` CLI flag (no files dropped in user projects, no settings.json mutation; loads regardless of project trust).
- `pi.registerCommand(name, {handler})` registers a slash command; RPC clients trigger it with `{"type": "prompt", "message": "/name args"}`. Matched extension commands never reach the LLM and never append a user message; the `prompt` response is emitted **after** the handler completes, so it doubles as the completion signal.
- The handler gets `ctx.navigateTree(entryId, {summarize: false})` — the same API pi's own TUI `/tree` uses, including the "user message → move leaf to parent + editorText" selection semantics.
- Caveat verified in pi's source: `navigateTree` with `summarize: false` only moves the **in-memory** leaf (on load pi derives the leaf from the last file entry), so the existing `tau:navigate-tree` marker entry is still needed — but the extension appends it in-process via `pi.appendEntry()` (→ `sessionManager.appendCustomEntry`). Same customType as today → old and new sessions are indistinguishable on disk; no migration, no frontend changes.

Outcome: delete all file mutation, `switch_session` reload, and rollback logic; drop the runtime pi-SDK dependency; navigation runs in-process inside pi using its documented, stable extension API (and now respects other extensions' `session_before_tree` hooks, which file surgery silently bypassed).

## Implementation

### 1. New file: `src/pi-extension/tau-tree.ts` (~30 lines)

```ts
export default function (pi: ExtensionAPI) {
  pi.registerCommand('tau-tree-navigate', {
    handler: async (args, ctx) => {
      const entryId = (args ?? '').trim();
      if (!entryId) throw new Error('tau-tree-navigate: missing entry id');
      if (!ctx.isIdle()) throw new Error('agent is busy');   // authoritative in-process guard
      const before = ctx.sessionManager.getLeafId();
      const res = await ctx.navigateTree(entryId, { summarize: false });
      if (res?.cancelled) throw new Error('navigation cancelled by an extension hook');
      if (ctx.sessionManager.getLeafId() !== before) {
        pi.appendEntry('tau:navigate-tree', { navigatedTo: entryId });  // persist leaf across restarts
      }
    },
  });
}
```

Pass the **original** entryId — pi applies the user-message→parent rule itself; pre-resolving would land one node too high. pi loads `.ts` extensions directly (jiti) and aliases `@earendil-works/pi-coding-agent` imports, so tau does not compile this file. `package.json` `files` already includes `"src"`, so it ships with the npm package. Keep it out of `tsconfig.server.json` (rootDir is `src/server`); typecheck it via `tsconfig.test.json` include (types come from the existing `@earendil-works/pi-coding-agent` devDependency).

### 2. `src/server/sessions.ts` — load the extension

In `start()` (~line 129), append to spawn args:
`'-e', path.resolve(__dirname, '..', 'src', 'pi-extension', 'tau-tree.ts')`
(compiled server runs from `bin/`, extension source stays under `src/`). Keep `TAU_DISABLED=1` — it toggles pi's own bundled tau extension, unrelated to `-e`.

### 3. `src/server/tree.ts` — gut the file-surgery half

**Delete:** `loadPiSdk`/`PiSdk` (lines 36-44), `applyTreeNavigation` (110-127), `rollbackTreeNavigation` (136-148), `AppliedNavigation`, and the `switch_session`/rollback/cancelled branch inside `navigateTree` (258-283). Update the header comment (the "RPC only exposes READ-ONLY tree commands" rationale is now solved by the extension, not file surgery).

**Keep unchanged:** `NAVIGATION_MARKER_TYPE`, `TreeEntry`, `SessionTreeNodeLike`, `selectNavigationTarget`, `flattenTree`, `pathFromRoot`, `leafDescendsFrom`, `NavigableSession`, `isTreeNavigationInProgress`, the in-flight `Set`, and `assertNotStreaming`.

**Rewrite `navigateTree(session, entryId)`** as:
1. In-flight guard + streaming guard + sessionFile check (as today, 237-256).
2. Preflight `get_tree` (as today — liveness check) and from its data resolve the entry; if not found, error. Compute `selectNavigationTarget(entry)` locally for `editorText` and no-op detection (`leafTargetId === current leafId` → skip the prompt entirely, return early). Tau must compute `editorText` itself because RPC-mode editor APIs are no-ops.
3. One-time per child (cached flag on the session): `get_commands` and verify a `tau-tree-navigate` extension command exists — guards against a broken install where the literal `/tau-tree-navigate …` text would otherwise be sent to the LLM as a prompt.
4. `await session.send({type: 'prompt', message: '/tau-tree-navigate ' + entryId}, {timeoutMs: 30000})`. Note: handler errors do **not** fail this response (`success: true` + a separate `extension_error` event), so success here means "handler finished", not "navigation succeeded".
5. Follow-up `get_tree`, then reuse the existing tail verbatim (284-298): refresh `session.entries = pathFromRoot(...)`, broadcast `live_session_snapshot` + `broadcastUpdated`, verify `leafDescendsFrom(byId, leafId, expectedLeaf)` where expectedLeaf is `leafTargetId` (leaf lands on the marker or housekeeping entries under it). If verification fails, surface any `extension_error` event text captured since step 4 (small addition in `PiRpcSession.handleStdout` to record the last `extension_error` per session).
6. Return `{editorText}` as today.

### 4. `src/server/server-main.ts`

`navigate_tree` handler (248-256) and the prompt-refusal guard during in-flight navigation (299-301) stay — pi's stdin loop does not serialize a new `prompt` behind a running command handler, so the guard is still needed. Update stale comments ("rewriting files" → "navigating in-process").

### 5. `package.json`

Remove the `peerDependencies` entry for `@earendil-works/pi-coding-agent` (runtime SDK use is gone); keep it as a devDependency for extension types and tests.

### 6. Tests: `test/tree-navigate.test.ts`

- Pure-helper tests: unchanged.
- Fake-`NavigableSession` tests: update the mock `send` to the new protocol — respond to `get_tree`, `get_commands`, and `prompt` (assert message is `/tau-tree-navigate <id>`, mutate fake leaf, respond). Covers guards, no-op skip, entries refresh, broadcast, leaf-verification failure, in-flight refusal, missing-command refusal.
- New extension unit tests: import the default export with a mock `ExtensionAPI`/`ctx` (capture `registerCommand`; drive the handler: empty args, busy, cancelled, leaf-moved → `appendEntry` called with the marker type, leaf-unchanged → no append).
- Replace the `switch_session` integration test (currently spawns real pi, skip-gated on availability): spawn `pi --mode rpc --session <file> -e <abs path to extension>`, send the navigate prompt, await the response, assert the on-disk file gained a `tau:navigate-tree` marker with the expected parent, assert no user-message entry contains `/tau-tree-navigate`, then kill and re-spawn pi on the same file and assert the leaf survived (get_tree leafId descends from the target).

### No frontend changes

`tree-view.ts` / `app-main.ts` / CSS untouched — the `navigate_tree` HTTP contract (including `editorText`) is identical, and markers are already hidden by the tree renderer.

## Verification

1. `npm run typecheck && npm test` (integration test requires `pi` on PATH; it is skip-gated otherwise).
2. Manual end-to-end: start tau, open a session with a few turns, open the tree view, select an earlier assistant entry → conversation truncates to that point and a `tau:navigate-tree` marker appears at the end of the `.jsonl`; select a user message → composer prefilled with its text and leaf moved to its parent; restart the pi child (or tau) and confirm the position persisted; try navigating while a turn is streaming → clean refusal.
3. Confirm the session jsonl contains no `/tau-tree-navigate` user messages and the LLM context (next turn) behaves as if the abandoned branch never existed.

## Risks

- Exact extension API surface (`pi.appendEntry` vs `ctx.sessionManager.appendCustomEntry`, handler signature) should be confirmed against the pinned pi version (0.80.3) when writing the extension — the guide and pi dist agree today, but the implementer should typecheck against real types, which the tsconfig setup provides.
- Handler errors surface as `extension_error` events, not failed responses — step 5's leaf verification is the real success check.
- Other user extensions can now legitimately cancel navigation via `session_before_tree`; this is treated as correct behavior and reported as an error to the browser.

---

# Code review of commit 2471a5e (implementation of this plan)

Reviewed 2026-07-10 against the plan above and against the installed pi 0.80.3 dist. Verdict: **the implementation is faithful to the plan, and every place it deviates is an improvement.** `npm run typecheck` is clean and all 173 tests pass locally, including the real-pi integration test (pi was on PATH, so it was not skipped).

## Plan conformance

All six implementation sections landed as written: the extension at `src/pi-extension/tau-tree.ts`, the `--extension` spawn arg in `sessions.ts` (with `navigateCommandChecked` reset per spawn, so a restarted child is re-verified), the gutting of `applyTreeNavigation`/`rollbackTreeNavigation`/`loadPiSdk` from `tree.ts`, the comment updates in `server-main.ts` with the prompt-refusal guard kept, the `peerDependencies` removal (including the lock file), and the full test rework. The extension source is correctly excluded from the server build and typechecked via `tsconfig.test.json`, and `path.resolve(__dirname, '..', 'src', 'pi-extension', ...)` resolves correctly from the compiled `bin/` layout (the npm `files` list already ships `src`).

Deliberate deviations from the plan, all sound:

1. **Stricter leaf verification than planned.** The plan said to reuse `leafDescendsFrom(leaf, leafTargetId)`; the commit instead requires the new leaf to have *changed*, to *be* a `tau:navigate-tree` marker, and to be parented exactly at the target. This is better: a handler error that silently moved nothing would still pass `leafDescendsFrom` whenever the old leaf already descended from the target (e.g. navigating into the same subtree twice), and the strict check catches that.
2. **An extra no-op clause, `entryId === previousLeafId`, that is actually required for correctness.** pi's `navigateTree` returns early when the target *is* the current leaf — before applying the user-message→parent rule (verified in `agent-session.js`). Without tau short-circuiting this case locally, the extension would append no marker and the strict verification would spuriously fail. The commit got this right.
3. **The extension validates the entry id with `ctx.sessionManager.getEntry()` before navigating**, producing a precise error instead of relying on `navigateTree`'s internal throw. Not in the plan; harmless and clearer.

## Risk from the plan, discharged

The plan flagged the exact pi extension API surface as the main risk. Verified directly against the pinned 0.80.3 dist: `handler: (args: string, ctx: ExtensionCommandContext)` — `args` is always a string (empty when absent), so the commit dropping the plan's `(args ?? '')` is safe; `pi.appendEntry(customType, data)` exists as specified; `ctx.navigateTree` returns `{cancelled: boolean}`; `ctx.isIdle()` and `ctx.sessionManager.getEntry/getLeafId` exist (via `ReadonlySessionManager`); `get_commands` reports extension commands with `source: "extension"`; the RPC `prompt` success response is emitted only after the extension handler completes (`preflightResult` fires after `_tryExecuteExtensionCommand` returns), and handler errors surface as an `extension_error` event with an `error` string while the prompt still acks success — exactly the model the commit's follow-up-get_tree verification is built on.

One finding that makes the extension's `isIdle()` check load-bearing rather than belt-and-braces: pi executes extension commands **immediately, even while the agent is streaming** (explicit in `agent-session.js`). tau's own streaming guards are advisory; the in-process check is the only authoritative one, and the extension has it in the right place, before any state is touched.

## Findings (all minor; none block the commit)

1. **A subtle behavior change vs. the old file surgery, not called out in the plan or commit message:** when the current leaf *is* a user message (reachable after an aborted turn) and the user selects it in the tree, the old code moved the leaf to its parent so a resubmit *replaced* the message; the new code no-ops (returning `editorText` only), so a resubmit appends *after* the original message, leaving it in context. This now matches pi's own `/tree` semantics, which is a defensible position — but it is a change users could notice, and worth a line in `AGENTS.md` or the plan if it ever surfaces as a bug report.
2. **The strict marker verification can false-negative in the presence of other extensions:** if a user extension appends an entry from its `session_tree` hook, that entry becomes the leaf before tau's marker is appended, so the marker's `parentId` is that entry rather than the target and verification fails. The failure mode is an error message plus a client resync onto the child's real state — never corruption — so this is acceptable, but it is a real (if unlikely) way for a *successful* navigation to be reported as failed.
3. **Command-name collisions degrade safely but with a misleading message:** if another loaded extension also registers `tau-tree-navigate`, pi disambiguates invocation names to `tau-tree-navigate:1`/`:2` (verified in `runner.js`), tau's `get_commands` check finds no exact match, and navigation is refused with "did not load tau's extension". Correct outcome (crucially, no LLM leak), slightly wrong diagnosis. Not worth code today.
4. **`lastExtensionError` captures any extension's error, not just this command's.** It is cleared immediately before the prompt so the window is tiny, but filtering on `event.extensionPath === 'command:tau-tree-navigate'` in `handleEvent` would make the attribution exact.
5. **`NAVIGATE_COMMAND`/`NAVIGATION_MARKER_TYPE` are duplicated** between `tree.ts` and `tau-tree.ts` (forced by the server build's `rootDir`). Mitigated well: the "keep in sync" comments are present, and the extension unit test asserts the command registers under the name exported from `bin/tau.js`, so a drift would fail CI. No action needed.

## Tests

Coverage is comprehensive and matches the plan's section 6: pure helpers untouched; new extension unit tests exercise the handler through a mocked `ExtensionAPI` (original-id pass-through, marker on move, no marker on no-move, empty args / unknown entry / busy / cancelled); the fake-child orchestration tests cover the new four-step protocol, the once-per-child `get_commands` caching, both no-op shapes, the missing-extension refusal, `extension_error` surfacing with client resync, streaming races, and concurrent-navigation/prompt refusal; and the rewritten integration test proves the three things that actually matter end-to-end — the command text never lands in the session file, the marker does, and the position survives a real pi restart.

## Conclusion

Ship it. The commit removes the undocumented-behavior dependency exactly as the plan intended, the verification logic is *stronger* than planned, and the one genuine semantic change (item 1) is an inherited pi behavior rather than a defect.

---

# Review follow-up: resolution of findings 3 and 4 (2026-07-10)

**Finding 4 — fixed.** `PiRpcSession.handleEvent` (src/server/sessions.ts) now only records an `extension_error` event into `lastExtensionError` when its `extensionPath` is exactly `command:tau-tree-navigate` — the tag pi puts on errors thrown by tau's own command handler. Previously any extension's error arriving in the window between the prompt and the follow-up `get_tree` could be misattributed as the reason a navigation failed; now an unrelated extension erroring at the wrong moment can never be blamed. The command name is imported from `tree.ts`'s existing `NAVIGATE_COMMAND` export (no new string duplication, and no import cycle — `tree.ts` imports nothing from `sessions.ts`). A new unit test in `test/pi-rpc-session.test.ts` drives `handleEvent` with an unrelated command error, a hook error from another extension file, and a genuine `command:tau-tree-navigate` error, asserting only the last one is kept. Note the fake-child test in `tree-navigate.test.ts` sets `lastExtensionError` directly (it stands in for the whole child, not for `handleEvent`), so it needed no change.

**Finding 3 — deliberately not fixed.** The maintainer judged a command-name collision (another user extension also registering `tau-tree-navigate`) too implausible to warrant code: the name is tau-specific, and even if it ever happened the existing behavior is already safe — the `get_commands` preflight refuses navigation and nothing leaks to the LLM; only the error message's diagnosis would be imprecise. Left as-is by decision, not oversight.

Verification after the change: `npm run typecheck` clean; `npm test` 174/174 passing, including the real-pi integration test.
