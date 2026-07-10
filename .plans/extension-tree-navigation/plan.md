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
