## Findings

### [P1] Validate the tail count before passing it to the history splitter

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/server/server-main.ts:531-532`

A request such as `/api/live-sessions/:id/snapshot?tail=1.5` accepts the fractional count and passes a fractional array index to `historySplitAt()`. With five entries, it reads `entries[3.5]` and throws an uncaught `TypeError`. The normal CLI's exception handler then shuts down the server and terminates every live Pi session. Reject non-integer counts with a client error, or normalize them to a valid integer before calling `snapshot()`.

### [P2] Check whether Pi is still busy before sending a waiting message

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/app-main.ts:2792-2795`

On a laptop, queue a message in busy session A, then switch to B. If A finishes and you start another task in A from your phone, returning the laptop to A makes it process the earlier task's completion before the later task's start. It sends the waiting message during that gap, even though Pi is already working on the phone's task. Pi rejects the message, requiring a retry. Finish catching up on the conversation and check whether Pi is currently busy before sending any waiting messages.

### [P2] Reload missed messages after switching tabs during a lost connection

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/app-main.ts:2718-2721`

If A is answering when the browser loses its connection and the user switches to B before it reconnects, the browser saves A's incomplete conversation. Reconnecting updates only B. Returning to A then shows that saved conversation without asking the server for missed messages, so part of the answer can remain missing until the user reloads A. Do not reuse a saved conversation if it may have missed messages while disconnected; get an up-to-date copy from the server first.

### [P2] Settle saved nested calls when an abort acknowledgement ends a reply

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/app-main.ts:2795-2796`

A native abort acknowledgement can establish idle without an `agent_settled` event. The existing metadata handler settles nested calls for a visible tab, but not for a hidden one. If A is hidden with a running nested call when another client aborts it, restoration sets streaming to false while leaving the saved child marked “running” indefinitely. Reconcile the saved tool state with the final idle metadata after replay, including settling unfinished nested calls.

### [P2] Save outgoing usage before the sidebar resets its counters

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/app-main.ts:2195-2196`

Opening an unopened historical session calls `handleSessionSelect()`, which clears cost, token counts, and usage before this new `parkActiveView()` call saves the outgoing tab. Returning to that tab restores zeros rather than its history totals. If `get_session_stats` is unavailable, the context pill disappears and the stats card shows no usage; this was reproduced with a session containing 12,000 input tokens and $3.75 of cost. Park the outgoing view before resetting its counters so the history fallback remains available.

### [P2] Continue opening tool details when the user returns to the tab

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/tool-card.ts:1014-1015`

In a large conversation, Expand All Tools opens the tool details a few at a time to keep the page responsive. If the user switches to B before it finishes and then returns to A, the opening process never continues. Some tool details stay closed until the user chooses Expand All Tools again. This matters for histories large enough that opening everything takes noticeable time. Continue the unfinished work when the user returns to the tab.

### [P2] Respect manual collapses while expansion batches are pending

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/tool-card.ts:982-986`

Each pending Expand All batch unconditionally opens its cards. If an already-open card belongs to a later batch and the user closes it before that batch runs, the batch reopens it despite its saved `body` choice being false. This was reproduced in Chromium with 120 cards. Check the latest per-card choice before applying each deferred expansion so an action taken after Expand All is not overwritten.

### [P3] Preserve the start time of compaction that begins in a hidden tab

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/app-main.ts:2793-2793`

When compaction starts while a tab is hidden, replaying its buffered `compaction_start` calls `handleCompactionStart()`, which uses the current time as the start. Returning five minutes later therefore shows an elapsed time near zero, although `session.compaction.startedAt` still contains the real start time. Preserve the event's arrival time or reconcile the running row with that authoritative timestamp after replay.

## Overall assessment

**Verdict:** Patch is incorrect.

**Explanation:** Type checking, all 322 unit tests, and all 102 end-to-end tests passed, with the browser suite taking about 33 seconds. However, malformed snapshot input can shut down the server, and the new caching, replay, and deferred expansion paths introduce correctness gaps not covered by those tests.

## How unusual each case is, and the user decision

The numbers below follow the order of the original findings. The original review above records the first assessment; it does not mean the user accepted every finding as a blocker.

| Finding | Assessment of how unusual it is | User decision |
| --- | --- | --- |
| 1. Fractional history count | No normal app action triggers this. The browser always sends an integer count; the crash requires a hand-written malformed API request. The direct-request crash is real, but it is outside the requests generated by the app. | Do not fix. The user considers it outside actual app behavior. |
| 2. Sending a waiting message too soon | Requires two browsers using the same session: one has a waiting message, while the other starts a new task after an earlier reply finishes. This is supported multi-browser use, though not ordinary single-browser use. It does not require split-second clicking. | Fix. |
| 3. Missing messages after a connection interruption | A plausible phone or remote-use problem: Pi continues working while the browser loses its connection, and the user switches tabs before reconnecting. | Fix. |
| 4. Nested calls still shown as running after abort | Not established with real Pi. The controlled reproduction supplied an abort acknowledgement without completion events. Installed Pi 1.5.0 waits for idle on abort and normally emits `agent_settled` for an active run. The original review did not prove that the required combination occurs in real use. | Do not fix. Withdraw this as a confirmed bug unless a real Pi trace supports it. |
| 5. Missing usage totals | Opening another historical session saves incorrect totals, but a successful stats request repairs the display. A lasting visible problem requires that request to fail. | Do not fix. Considered a niche fallback failure, rather than a normal healthy-path problem. |
| 6. Expand All Tools interrupted by a tab switch | Requires leaving before all tool details have opened. The small controlled reproduction used programmatic timing; larger histories give a person more time to interrupt it. | Do not fix. The user explicitly considers this case niche, including for this change's large-session scope. |
| 7. A tool detail reopens after being closed | Requires closing an already-open detail before a later Expand All Tools step reaches it. The reproduction used controlled timing, and the effect is limited to that detail reopening. | Do not fix. Considered niche and minor. |
| 8. Compaction elapsed time restarts | Compaction starting while another tab is shown is plausible, but the defect affects only the displayed elapsed time, not the compaction itself. | Do not fix. Considered minor and outside the selected fixes. |

Only findings **2 and 3** are approved for implementation. Findings **1 and 4–8**, including **6**, are intentionally left unchanged. The initial P2 severity for findings 5 and 7 overstated their practical impact; both are better treated as P3 follow-up issues. Finding 4 is unconfirmed, rather than an established normal-use failure.

## Fix summaries

### Finding 2 — Wait until the conversation is up to date before sending

Queued messages wait while the browser applies the events received when another tab was shown. The browser restores Pi's current busy status before allowing any waiting message to be sent. This prevents an earlier task's completion from sending a message into a later task that another browser has started.

The new browser test uses two separate browser sessions connected to the same Tau server. It queues a message on the laptop, switches tabs, and starts a new task from the phone after the earlier task finishes. Returning on the laptop keeps its message waiting. After the phone's task finishes while another tab is shown, returning sends the waiting message exactly once.

Before the fix, this test failed because the laptop's message was sent while the phone's task was still running. It passes with the fix.

### Finding 3 — Reload conversations that may have missed messages

Losing the connection clears saved conversations and marks the displayed conversation as needing a fresh copy from the server before it can be reused. The browser also refuses to save conversations for reuse while live updates are disconnected, even if history requests over HTTP still work.

The new browser test closes the live connection while an answer is arriving, switches to another tab, and lets Pi finish the answer during the interruption. After reconnecting and returning to the first tab, the browser requests its history and shows the completed answer instead of the unfinished copy.

Before the fix, this test timed out waiting for the completed answer because the browser reused the incomplete conversation. It passes with the fix.

### Verification

- `npm run typecheck`: passed.
- `npm test`: all 322 tests passed.
- `npm run test:e2e`: all 104 tests passed in about 35 seconds, including both new regression tests.
- The first full browser run hit a timeout in the existing model-completion test. That file passed on its own, and the next full browser run passed all 104 tests. No changes were made to model completion.
- A separate read-only review of the selected fixes found no additional issues.

**Result:** Findings 2 and 3 are fixed. No fixes were made for the other findings, in accordance with the user decision.
