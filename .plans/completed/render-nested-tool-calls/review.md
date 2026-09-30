# Review of nested tool-call rendering

**Commit:** `b26ca42bff3b0017748b9055a1f368600cffe511`

## Findings

### [P2] Keep following live child rows when the reader is at the bottom

**Location:** `src/public/tool-card.ts:312-315`

Nested events enlarge the parent card without updating the scroll position. A reader following execution at the bottom therefore loses sight of new calls; adding 30 children left the viewport 797 pixels above the bottom in a browser check. Capture whether the reader is near the bottom before updating the card, then preserve that position afterward without moving readers who have scrolled up.

### [P2] Treat unfinished snapshot cards as live when child events arrive

**Location:** `src/public/tool-card.ts:499-508`

When a browser reconnects or switches tabs during execution, the snapshot's assistant tool call is rendered through `createHistoryCard()`. Its permanent `history` class prevents subsequent live child events from opening either the body or calls section, even when children are running or fail. Distinguish unfinished snapshot calls from completed history and apply live expansion behavior to them while preserving manual choices.

### [P2] Restrict new-root updates to summaries that can change

**Location:** `src/public/tool-card.ts:306-308`

Every new root synchronously scans saved child collections during registration and rerenders every existing calls section, including unrelated completed history. With 500 historical parents containing ten children each, remembering one unrelated root rerendered all 500 sections and took approximately 108 milliseconds in a desktop browser. This cost grows throughout a session and delays live interaction. Limit ownership checks and rendering to collections affected by the new root's ID.

## Overall assessment

**Verdict:** Patch is incorrect.

**Explanation:** The bounded summaries, final-record reconciliation, and parent/child separation make sense, but the live display has the issues above. The tests are meaningful, not toy tests: they exercise limits, hierarchy, reconciliation, and real-browser behavior with mocked Pi events. Typechecking, all 244 unit tests, and all 50 browser tests passed, but they miss these reconnect, bottom-following, and long-history cases.

## Proposed fix summaries

The following proposals are implemented. The implementation summaries and checks are recorded below.

### 1. Preserve bottom-following during nested updates

In `src/public/tool-card.ts`, capture whether the reader is near the bottom before changing nested rows or automatic expansion. After the update, schedule a scroll to the current bottom only for a reader who was following execution. Do not rely on a proximity check taken after insertion: one large update can already have moved the bottom beyond the threshold. Cancel pending work when the conversation is cleared, and avoid overriding a user scroll made before the scheduled callback runs.

Add a browser regression test that starts at the bottom and delivers enough child events across separate frames to make the card taller than the viewport. Assert that the latest row remains reachable at the bottom throughout execution. Keep the existing scrolled-up reader test, and cover clearing the conversation before a scheduled scroll runs.

### 2. Apply live behavior to unfinished snapshot calls

Use the presence of a parent result, rather than the card's creation path alone, to distinguish completed history from an unfinished snapshot call. Mark saved parent results as finished even when they have no `nestedCalls` record, so late child events cannot promote completed history. When a valid child event updates an unfinished snapshot root, promote that existing card to live presentation without creating another card or rebuilding its rows. Do not infer parent success from child success; only the parent's completion event or final result establishes its completed status.

Preserve the existing body, calls-section, and row expansion choices. Automatic opening should apply only where the user has not made a choice, and completed historical cards should remain collapsed by default.

Add a browser regression test that seeds an assistant tool-call definition without its result, opens the session snapshot, and then delivers child events without replaying the root start. Check automatic opening, handled child failure visibility, final reconciliation, and the absence of duplicate cards. Also check manual collapse and late events for completed history with and without nested records.

### 3. Update only summaries affected by root registration

In `src/public/nested-tool-calls.ts`, check whether a call ID equals the new root ID or is one of its numeric descendants before calling `owner()`. Unrelated IDs cannot change ownership. Recount argument bytes only in collections whose calls were removed or moved, and return the affected root IDs from `registerRoot()`.

In `src/public/tool-card.ts`, have `rememberRoot()` render only those affected roots instead of every existing calls view. Preserve root/child collision handling, the longest registered ancestor rule, omission notices, and bounded pending summaries.

Add a model regression test with many completed parents and retained children, then register an unrelated root. Verify that existing summaries remain unchanged and that registration reports no changed existing roots. Add a browser check that counts calls-section updates during the same operation; unrelated history should receive none. Prefer operation-count assertions over a machine-dependent timing threshold, and retain the existing collision and ownership tests.

### Validation after implementation

Run `npm run typecheck`, `npm test`, and `npm run test:e2e` from this submodule. Keep the old-history and Pi 0.86.0 compatibility checks described in `plan.md`. The passing results recorded above apply to the reviewed commit. The checks below cover the implemented fixes.

## Implemented fixes

### Bottom-following

`src/public/tool-card.ts` captures the reader's scroll position before nested rows or final reconciliation change the card. Updates share a queued scroll to the current bottom. A reader scroll before that callback prevents the jump, and clearing the conversation cancels the callback. Readers above the live parent keep their reading position.

### Unfinished snapshots

`src/public/app-main.ts` distinguishes tool calls with a parent result from pending snapshot calls during both root registration and progressive rendering. Completed roots reject late child events even when the saved result has no nested record. Valid child activity promotes an unfinished card to live presentation and preserves manual expansion choices. Live activity is also remembered when the parent card has not reached the DOM yet, so deferred cards open correctly without duplication.

### Root registration

`src/public/nested-tool-calls.ts` filters unrelated call IDs before checking ownership, recounts only modified collections, and reports the affected root IDs. `src/public/tool-card.ts` uses those IDs to update only the affected calls sections. Root collisions, moved descendants, buffered omissions, and argument limits retain their existing behavior.

### Regression tests and validation

Two model tests cover affected-root reporting with 500 completed parents and descendant ownership changes. The buffered-omission test also checks that registration reports the root whose omission notice needs rendering. Five browser tests cover unfinished snapshots, deferred cards, bottom-following across small and large updates, cancelled scroll callbacks, and the absence of DOM updates to unrelated completed history. The existing manual expansion, session isolation, and scrolled-up reader tests remain in place.

The following checks passed:

- `npm run typecheck` passed production and test typechecking.
- `npm test` passed all 246 tests without skips or failures.
- `npm run test:e2e` passed all 55 browser tests without skips or failures.
- An isolated Pi 0.86.0 checkout passed production typechecking, the build, and all 36 history and nested-call model tests. The main checkout's dependency resolution was not changed.
- `git diff --check` reported no whitespace errors.

