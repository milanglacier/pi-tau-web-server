## Findings

### [P2] Remove snapshot-rendered errors when a retry succeeds

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/history-render.ts:106-108`

When a browser connects, reloads, or switches back to a session during retry backoff, the snapshot contains the failed attempt without a later assistant reply. This code renders that temporary failure as a final error. The next retry only clears `pendingAssistantError` and the retry notice; it never removes the history-rendered error. I reproduced a successful retry leaving both “Request failed” and the recovered answer visible until reload. Preserve retry state when rendering snapshots and reconcile the failed attempt when the retry succeeds.

### [P2] Preserve final errors before starting a queued instruction

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/app-main.ts:878-880`

If Pi has a native `follow_up` queued when a non-retryable request fails, it starts the queued instruction before emitting `agent_settled`. This reset discards the first reply’s pending error, and the next assistant message also clears it. The user therefore sees an empty failed reply followed by the second answer, with the failure appearing only after reload. Pi’s installed implementation supports this event sequence. Finalize the previous instruction’s error when a new instruction begins, and discard it only when an actual retry replaces that reply.

### [P2] Keep final errors across independent extension-triggered runs

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/history-render.ts:56-64`

An extension can call `pi.sendMessage(..., { triggerTurn: true })` after a failed operation settles, starting an independent run whose input is stored as a `custom_message`, not a user message. This scan skips that entry and treats the later assistant reply as recovery from the earlier failure. Reopening the session consequently hides the previous operation’s final error, even though it was shown live. Distinguish actual retry attempts from separate runs rather than treating every assistant reply before the next user message as recovery.

## Follow-up decisions

Findings 2 and 3 are deferred. They require native queued instructions or independent extension-triggered runs, rather than Tau’s ordinary browser message queue. These edge cases do not justify expanding this change now.

Finding 1 will not be fixed in this change. We accept the stale error as a display-only issue: the successful reply and saved history remain intact, and refreshing after the retry succeeds clears it. Reconnecting or refreshing while the retry is still waiting can produce it, but another refresh after success resolves it. This limited inconvenience does not justify a fix now.

All three findings are accepted as non-blocking for this change. No fixes are planned in this branch.

## Overall assessment

**Verdict:** Patch is incorrect.

**Explanation:** The error display works for the covered scenarios, but snapshots and independent continuations can leave recovered errors visible or hide final failures. Type checking, all 270 regular tests, and all 72 browser tests pass; the cases above are not covered.
