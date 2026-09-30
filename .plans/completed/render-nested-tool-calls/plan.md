# Show nested tool calls inside their parent card

## Agreed behavior

Nested tool calls appear as compact rows inside the tool that called them. They do not become separate conversation cards.

Show each call's name, argument preview, status, and duration when available. A row can expand to show its recorded arguments and short error. Do not show or save full child output.

Open the calls section while the parent is running. Collapse it after successful completion when all recorded children succeeded. Keep failures visible, including when the parent handled a child failure and succeeded itself. Respect manual open and close choices throughout execution.

Example of an expanded parent:

```text
▾ codemode                                  complete
  Code / arguments
    …

  ▾ Calls · 3 succeeded, 1 failed
    ✓ read   src/server.ts                     12 ms
    ✓ read   src/config.ts                      8 ms
    ✓ edit   src/server.ts                     21 ms
    ✗ bash   npm test                         940 ms
      Command exited with code 1

  Output
    …
```

Use light indentation for calls made by other children. Preserve sibling start order even when calls finish in a different order. Keep the parent's own status, arguments, copy button, and output independent from its children.

## Context and Pi's contract

Commit `75832d5` filters nested execution events in `src/public/app-main.ts`. This prevents temporary top-level cards that disappear after reload, but also hides activity inside tools such as codemode.

Pi 0.99.1 supplies two sources:

- Live `tool_execution_start`, `tool_execution_update`, and `tool_execution_end` events identify the immediate parent with `parentToolCallId`. Pi assigns child IDs as `<parent id>/<n>`.
- The parent tool-result message contains `nestedCalls`. This is a flat record of descendants at every depth, with IDs, names, optional arguments, status, duration, and short errors. Child results are not saved.

The saved record keeps at most 256 calls. It omits arguments above 8 KiB per call or 32 KiB in total, and limits errors to 500 characters. `complete: false` can mean calls were dropped, arguments were omitted, or calls were unfinished. It does not give the number of missing calls.

Pi attaches this record at the parent tool-result message's `message_start`. The parent's execution-end payload alone is not a reliable source for it. Use the completed tool-result message as the final source of truth.

The server already forwards execution events and retains complete tool-result messages in `src/server/sessions.ts`. No server storage or wire-protocol changes are needed.

## Scope

- Support both live events and saved history through the same calls-section renderer.
- Preserve existing behavior for tools without nested calls and for older Pi versions without these fields.
- Keep progressive history rendering, scroll anchoring, session isolation, permission dialogs, and parent output unchanged.
- Do not add dependencies, save child results, modify Pi session files, or build an event replay service.
- A browser that attaches during execution can only show calls it observed until the parent's final saved record arrives. Do not invent missing activity or claim a complete live record.

## Implementation

### 1. Add a small, testable model for nested-call summaries

Create `src/public/nested-tool-calls.ts` with browser-compatible types and DOM-free helpers. Share its optional record type with `AppMessage` in `src/public/app-types.ts` and `ToolResult` in `src/public/tool-card.ts`. Keep the frontend independent of version-specific runtime imports from Pi.

Maintain child summaries separately from root tool executions. Track the immediate parent, top-level owner, start order, observed start time, status, bounded arguments, and short error. Full successful output and partial output must not enter this state. Extract only the bounded text needed to describe a failed call.

For live events, use `parentToolCallId` to attach each child. Reject invalid relationships, self-parenting, and child IDs that collide with a root card. Duplicate events must not create duplicate rows. Buffer bounded summaries when the owning card has not appeared yet; never create an orphan top-level card.

Apply the current Pi record limits while collecting live summaries, so very large executions do not create an unbounded list that disappears at completion. Label omissions. Compute live durations only when a start was observed; replace estimates with recorded durations later.

For saved records, reconstruct depth from Pi's documented numeric child-ID suffixes relative to the known root ID. Do not assume the root ID has no slashes. If an intermediate parent is absent or an ID cannot be placed safely, show the retained call under the known root without inventing another call.

Replacing live summaries with the final `nestedCalls` record must be idempotent. Preserve expansion choices for retained row IDs. Once the parent record is final, later child events must not change it. Keep `unfinished` distinct from success, failure, and currently running.

Clear summaries, buffered relationships, and expansion choices with the conversation view so session switches cannot reuse stale state.

### 2. Render one calls section for live and historical cards

Update `src/public/tool-card.ts` and `public/style.css`.

- Add a calls section only when there is recorded or observed nested activity, including an incomplete record with no retained calls.
- Add a compact count/status indicator to the parent header. When the parent is collapsed, child failures must still be visible in that indicator.
- Render child rows with their own classes, not `.tool-card`, and keep them out of the root card map.
- Use DOM text methods for names, argument previews, arguments, and errors. Use keyboard-accessible controls with clear expanded state.
- Reuse the current argument preview formatting. Show omitted arguments as omitted, with their byte size when available, rather than as an empty object.
- Show an explicit incomplete-record notice. Counts describe retained or observed calls, not an invented total.
- Keep indentation shallow on narrow screens. Long names and paths must not push statuses outside the card.
- Update changed rows in place. Do not rebuild open argument panels on every event.
- Keep parent output and copying scoped to the parent's own output. Child summaries must not replace or be copied as parent output.

For automatic expansion, open both the calls section and the containing body when nested activity starts, unless the user closed them. Collapse automatically only after a clean parent completion with no child failure or unfinished call. Never override a manual toggle; Expand All and Collapse All also count as explicit choices. History stays collapsed by default unless Expand All is active, with failure indicators visible in the header.

Keep row arguments closed by default. Build historical child details on demand to avoid multiplying DOM work across large histories. Preserve the existing history chunk sizes and scroll-anchoring behavior.

### 3. Route live child events without changing root behavior

Update `src/public/app-main.ts`.

Replace the nested-event early return in `handleRPCEvent()` with routing to the summary model and calls-section renderer. Child events must not pass through root `handleToolExecutionStart`, `handleToolExecutionUpdate`, or `handleToolExecutionEnd`.

Use starts and ends to update activity and status. Partial child results do not produce output panels or repeatedly reopen sections. Keep permission requests on their existing route.

Handle `message_end` for `role: 'toolResult'` separately from assistant-message finalization. Reconcile the parent's final nested record there, including corrected durations, omitted arguments, and unfinished calls. A tool-result message must not finalize an unrelated assistant text stream or add child usage to assistant usage accounting.

Retain known root tool-call definitions from assistant messages and displayed history. If a root execution-start was missed, use that known definition to attach the completed record or create the missing parent card, without duplicating an existing history card. If the root definition is unavailable, do not fabricate arguments or create a child-only transcript card.

Coordinate root completion and summary reconciliation so a handled child failure remains visible even though the parent itself succeeded. On settlement or interruption, observed calls without an end event must not remain labelled as actively running indefinitely; show them as unfinished until an authoritative record replaces them.

### 4. Preserve nested records in the history pre-pass

Update `src/public/history-render.ts` and its types.

`buildHistoryItems()` currently keeps only the content of each tool-result message. Carry its optional `nestedCalls` into the result paired with the parent item. Do not emit new history items for children.

Have `createHistoryCard()` / `addHistoryResult()` use the same calls-section renderer as live cards. Each parent item must remain self-contained so newest-first rendering and deferred older chunks cannot orphan a child record.

## Tests and acceptance checks

### Pure tests

Add `test/nested-tool-calls.test.ts` and extend `test/history-render.test.ts`.

Cover:

- Parallel siblings finishing in reverse order, deeper descendants, duplicate events, missing starts, and missing intermediate parents.
- Root IDs containing slashes, invalid child relationships, and root/child ID collisions.
- Replacement by the authoritative record without duplicate rows or late-event overwrites.
- Call-count and UTF-8 argument limits, omitted arguments, short errors, incomplete empty records, and unfinished calls.
- No retained full child output.
- Correct pairing of nested records with multiple parent calls, with no additional top-level history items.
- Unchanged results for old history without `nestedCalls`.

### Browser tests

Extend `test/e2e/history-render.e2e.ts`. Replace the latest commit's assertion that children are invisible with assertions that children appear inside the parent while the number of top-level cards stays unchanged. Preserve its protection against nested events overwriting a root card.

Verify:

1. Live child rows appear, update, and retain their order without changing parent output.
2. The calls section opens during execution and collapses on clean completion. Manual toggles are respected after further events and completion.
3. A handled child failure keeps a visible failure indicator and does not change the parent's successful status.
4. Final reconciliation and reload show the same recorded hierarchy, arguments, statuses, errors, durations, counts, and omission notices. Expansion state need not survive a page reload.
5. Child output text is absent, while parent output and its copy button remain correct.
6. Missing live starts, interruption, and final records without observed child events render honestly.
7. Both newest and deferred older history chunks render nested records correctly. Expand All / Collapse All work during progressive rendering.
8. Session switches clear child state; background-session events cannot update the active parent's rows.
9. Narrow screens, keyboard toggling, and scrolled-up live updates remain usable, with no browser errors.

Use SDK-typed fixtures where possible so tests follow the installed Pi contract.

### Commands

Run from this submodule:

```sh
npm run typecheck
npm test
npm run test:e2e
```

The tests build the project. Also check production typechecking and the old-history regression against an isolated Pi 0.86.0 installation, without changing the main checkout's dependency resolution. Do not increase the minimum supported Pi version for an optional display feature.

## Completion criteria

Nested activity is visible under its owner, never as temporary top-level cards. The final saved summaries look the same before and after reload. Child failures remain visible without mislabelling a successful parent. Full child output is neither displayed nor stored, and existing tool cards, permissions, session switching, and history rendering continue to work.
