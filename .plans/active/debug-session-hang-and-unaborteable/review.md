# Review: fix/abort-permission-waits (Tau side of the joint change)

Reviewed on 2026-09-07 together with the matching `fix/abort-permission-waits` branch in
`pi-minimal-permission-system`. The extension-side review lives in that repository's
`.plans/active/debug-session-hang-and-unaborteable/review.md`.

## Verdict

The plan is correct, the implementation matches it, and the tests prove the bug and the fix.
Ready to merge from a correctness standpoint. One medium-severity gap in the new browser
queue logic is worth fixing before or shortly after merge; the rest are minor.

## Does the plan solve the bug?

Yes. I re-traced the mechanism against the Pi 0.85.1 sources in `node_modules` rather than
taking the plan's word for it:

- `dist/modes/rpc/rpc-mode.js` `createDialogPromise` only resolves a dialog on an
  `extension_ui_response`, an explicit `timeout`, or an `opts.signal` abort. Without a signal
  the confirm promise is unbounded.
- `ctx.signal` resolves to `this.agent.signal` (`agent-session.js:2063` via
  `extensions/runner.js`), so it is the correct per-run cancellation signal for a `tool_call`
  hook.
- RPC `abort` calls `session.abort()`, which aborts the agent and then `await waitForIdle()`.
  It never touches `pendingExtensionRequests`, so a signal-less confirm keeps the turn from
  going idle and the abort acknowledgement never comes. This is exactly the observed symptom.
- `agent_settled` is emitted from a `finally` in `_runAgentPrompt` and fires before the idle
  wait resolves, so the abort acknowledgement always arrives after `agent_settled`. Tau's
  ordering assumptions (settle first, then ack) hold.

The split of responsibilities is the right one. The extension fix alone makes native Abort
work. Tau's changes are needed independently because Pi never emits any event when it drops
an aborted dialog, so without a server-side registry the browser would keep showing a dead
dialog, and because the old server converted an Abort timeout into a fake success.

## Does the implementation make sense?

Server (`src/server/sessions.ts`, `server-main.ts`, `types.ts`): yes.

- Response-bearing dialogs are retained per session, included in snapshots with their
  original `expiresAt`, and broadcast as a revisioned `interaction_state`. Notify and
  setStatus requests still flow as ordinary events. Correct separation.
- `respondToDialog` validates method-specific fields, rejects foreign sessions and expired
  requests, claims the entry synchronously before the first `await`, and resolves on stdin
  delivery without a 60-second pending-command timer. The "first reply wins" behaviour is
  real, not just documented.
- `abort()` writes the native abort first, then cancels dialogs, then coalesces. The
  `abortOperationRevision` guard is what keeps a delayed acknowledgement from marking a newer
  turn idle. `completeAbort` is guarded by the command id so being called from both
  `handleResponse` and the promise chain is safe.
- Removing the ack-timeout-to-success conversion is correct for Abort. Note that it was also
  removed for `prompt`, which the plan did not call out. That is still right on Pi 0.85.1,
  because `prompt` is acknowledged after preflight rather than after completion, and there is
  a test for it. It is a small scope extension worth being aware of.

Browser (`src/public/app-main.ts`, `dialogs.ts`): yes, with one gap noted below.

- Dialogs are rendered only from the server registry, resolution never sends a second reply,
  tab switches and refreshes recover the request with the original deadline, and the dialog
  container no longer blocks the Abort button.
- Button and keyboard Abort share `abortActiveSession`, show "Stopping…", and only report
  idle on a real acknowledgement whose operation revision still matches.
- The stale-snapshot guards (`interactionRevision`, `sessionStateRevisions`) are sound.

## Do the tests make sense?

Yes, and they are the strongest part of the change.

- `test/permission-rpc.test.ts` drives a real Pi 0.85.1 child with a fake streaming
  provider, loads the extension from the sibling source checkout, and uses a file sentinel
  rather than `tool_execution_start` as the proof of execution. It sends only native RPC:
  no `extension_ui_response` at all in the abort scenarios.
- I independently confirmed it catches the bug. Running it with
  `TAU_PERMISSION_EXTENSION_DIR` pointed at a throwaway worktree of the extension's `master`
  fails the two abort-related scenarios with "Timed out after 5000ms waiting for abort
  acknowledgement" while the sentinel file stays absent. The four behaviour-preservation
  scenarios pass on both revisions, as they should.
- The unit tests in `test/pi-rpc-session.test.ts` cover write ordering, coalescing, the late
  acknowledgement race, expiry without restart, per-method validation, recoverable stdin
  failure, and diagnostics redaction. `test/rpc-command.test.ts` replaces the test that
  enforced the wrong "timeout means success" behaviour.
- `test/e2e/permission-dialog.e2e.ts` covers the multi-browser, refresh, reconnect,
  tab-switch and stale-snapshot cases the plan listed.

Results I ran locally: `npm run typecheck` passes, `npm test` passes 223/223 including the
six real Pi scenarios, `npm run test:e2e` passes 28/28.

## Findings

1. Medium: a queued instruction can lock the session queue forever.
   `flushQueue` records a `queuedPrompts` entry and then calls `wsClient.send`, which silently
   drops the command when the socket is not open. The entry is only cleared by a prompt
   response with that id, by `agent_settled`, or by closing the tab. If the send is dropped,
   or the response is lost across a WebSocket reconnect, `sessionHasPendingWork` stays true and
   every later message shows "Queued" with no error and no Retry button. Suggested fix: send
   queued prompts through the HTTP `/api/rpc` path the way Abort and dialog replies already do,
   so a failure surfaces as `cmd.error` and Retry; and reconcile `queuedPrompts` on reconnect
   with the `get_state` refresh probe that already exists.

2. Low: a timed-out or failed Abort keeps cancelling new dialogs until Pi settles.
   `retainDialog` calls `cancelPendingDialogs` whenever `abortState !== 'idle'`, and
   `respondToDialog` converts any reply to `cancelled` in that state. After a 60-second
   timeout the state stays `timed_out` until `agent_settled` or a late acknowledgement, so the
   user cannot answer any dialog in that window while the status line only says "completion
   not confirmed". This is defensible, since the abort is genuinely still outstanding, but it
   should be a documented behaviour rather than an accident.

3. Low: a dialog stays disabled after a successful reply until the WebSocket delivers the
   registry update. If HTTP works but the socket is down, the dialog looks frozen until the
   reconnect snapshot clears it. Acceptable, but worth knowing when triaging reports.

4. Nit: `test/permission-rpc.test.ts` writes the policy `{ bash: { '*': 'ask' } }`. Bash
   rules are regular expressions, so `*` is an invalid pattern that never matches. The test
   works only because the extension's default is "ask". Use `.*`, as the extension's own tests
   do, so the intent is explicit.

5. Nit: the retained `PendingDialog` spreads the whole Pi event, so snapshots carry a stray
   `type: 'extension_ui_request'` field. Harmless, but it could be dropped in `retainDialog`.

## What I did not verify

- No live Pi process was restarted and no symlink was changed, as the plan requires. The
  extension symlink target was checked but adoption by already-running sessions still needs
  an approved reload.

---

# Fix summary (appended after the review above, same day)

Every finding above was addressed. The original review text is unchanged. All changes are in
the working tree and uncommitted.

## Finding 1 (medium): queued dispatch could lock the session queue forever

Fixed in `src/public/app-main.ts`.

- Queued instructions are now dispatched with an HTTP POST to `/api/rpc`, the same path Abort
  and dialog replies already use, instead of `wsClient.send`, which silently drops a command
  when the socket is closed. A failed dispatch (network failure or a Pi rejection) returns the
  instruction to the head of the queue as "Not sent" with the existing Retry button. The
  WebSocket `rpcResponse` listener that previously matched queued prompt responses was
  removed, since the HTTP response now carries that acknowledgement directly.
- On WebSocket reconnect, every session that still holds a queued dispatch runs the existing
  `get_state` refresh probe. If Pi reports idle, the lock is released. This path deliberately
  ignores the `started` flag, because the `agent_settled` that would normally clear the lock
  may have been lost with the socket and Pi's fresh idle answer is the only completion signal
  the browser will get. The accepted-prompt path keeps the `started` guard as before.
- Two e2e regressions were added to `test/e2e/permission-dialog.e2e.ts`. The reconnect one
  fails with "No prompt command reached Pi" when the reconnect probe is disabled, and passes
  with it. The dropped-dispatch one aborts the prompt request at the browser and asserts the
  "Not sent" label, the Retry button, that nothing reached Pi, and that Retry then delivers it.

## Finding 2 (low): sticky non-idle abort state keeps cancelling new dialogs

Documented rather than changed, since the behaviour is correct: approving anything while a
stop is outstanding is never right.

- A comment in `retainDialog` in `src/server/sessions.ts` states that `timed_out` and
  `failed` persist until a late acknowledgement or `agent_settled`, and that new dialogs are
  cancelled and replies converted to cancellations for that whole window.
- The README architecture section now has a paragraph describing that window from the user's
  point of view, together with the new queued-dispatch behaviour from finding 1.

## Finding 3 (low): a delivered reply looked frozen until the WebSocket confirmed it

Fixed in `src/public/dialogs.ts` and `public/style.css`.

- After a successful delivery the dialog now shows "Response sent. Waiting for the server to
  confirm…" in a `role="status"` notice, so a sheet that stays open while the socket is down
  reads as waiting rather than hung. The registry update still owns dismissal, exactly as the
  existing e2e test requires. Delivery failures reuse the same notice element with
  `role="alert"` and the existing `.dialog-response-error` class, which the existing retry
  test still selects on.
- The notice classes had no styles before; both now have minimal CSS.
- The existing "delivery acknowledgement cannot resolve a dialog" e2e test additionally
  asserts the status notice appears and that no error class is present.

## Finding 4 (nit): invalid `*` bash regex in the real-Pi test policy

Fixed in `test/permission-rpc.test.ts`. The policy is now `{ bash: { '.*': 'ask' } }` with a
comment, so the test asks explicitly rather than relying on the default-ask fallback.

## Finding 5 (nit): retained dialogs carried a stray `type` field

Fixed in `retainDialog` in `src/server/sessions.ts`, which now strips the transport `type` tag
before storing the request. The snapshot unit test in `test/pi-rpc-session.test.ts` asserts
the field is absent and that real dialog fields such as `title` survive.

## Note: `prompt` acknowledgement timeout scope

Recorded in this plan's implementation results: the timeout-to-success conversion was removed
for `prompt` as well as Abort and UI replies, which is correct on current Pi because `prompt`
is acknowledged after preflight, and `test/rpc-command.test.ts` already covers it.

## Verification after the fixes

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm test` | 223/223 pass, including the six real-Pi scenarios |
| `npm run test:e2e` | 30/30 pass (28 previous plus the two new queue regressions) |
| `git diff --check` | clean |

The real-Pi scenarios now run against the extension checkout with its Pi dev dependency at
0.85.1 (see the extension review's fix summary). No live Pi process, symlink, or session file
was touched.


---

# Second round of joint review — independent verification (2026-09-10)

## Scope and verdict

Reviewed Tau `main..fix/abort-permission-waits` at `1ed7a75` and the extension's
`6fd96a4..fix/abort-permission-waits` at `a579238`. The extension working directory
is currently on `master`, so I exported the requested branch into a disposable
`/tmp/pi-permission-round2` directory rather than switching the user's checkout.
The extension's plan and review have moved to `.plans/completed/` on that branch;
its existing review already includes an earlier second-round section. Nothing in
that review or in the Tau review above was replaced.

The joint plan makes sense and addresses the confirmed cancellation mechanism.
The extension implementation is correct and can stand alone. Tau's server-owned
dialog registry, write-only response transport, and honest native Abort handling
are appropriate. However, the first review's queue-recovery fix introduces an
ordering race and leaves one permanent-lock path open. I would fix the two P2
findings below before approving the Tau branch. The joint patch is therefore not
yet correct as a whole.

## Does the plan solve the bug?

Yes. Pi 0.85.1's native Abort signals the agent and waits for idle. Passing the
captured turn signal to the permission confirmation releases the suspended hook,
while the post-await signal check prevents a racing approval from allowing an
aborted tool. No deadline or YOLO change is needed. Tau independently needs to
retain dialogs and distribute their resolution across browsers because Pi does
not send an equivalent dialog-resolution event. The historical trace remains
consistent with this mechanism, rather than conclusive proof of it.

## Findings

### [P2] Do not reconcile an in-flight dispatch as an accepted prompt

Location: `src/public/app-main.ts:328–331`, with the premature release at
`1418–1421`.

The reconnect handler probes every `queuedPrompts` entry, including entries whose
HTTP POST has not reached Tau or whose prompt has not been acknowledged. Pi can
truthfully report idle at that point. The probe deletes the dispatch lock and
`updateUI()` sends the next queued instruction while the first request is still
in flight. This reverses instruction order and can cause the delayed first
instruction to be rejected as already processing; its response is then ignored
because its dispatch entry was replaced. A fresh idle answer is not evidence
that an unacknowledged request has completed. Track acceptance separately and do
not release an unresolved dispatch based solely on this probe.

Reproduced with the existing browser harness: queue two instructions, hold the
first POST before delivery, disconnect and reconnect the WebSocket, and let the
fresh Pi state probe report idle. The second instruction reaches the fake Pi
while the first POST is still held. The assertion that the first instruction
must reach Pi first fails.

### [P2] Recover from a failed queued-prompt state probe

Location: `src/public/app-main.ts:1423–1425` (also covers an unsuccessful response
that simply fails the `idle` condition).

After a handled slash command succeeds without starting an agent operation, its
fresh `get_state` probe is the only normal path that releases `queuedPrompts`.
If that one HTTP request fails, the catch silently leaves the lock indefinitely.
There will be no `agent_settled`; ordinary ten-second metadata polling does not
retry this probe or clear the entry; subsequent messages remain queued without
a Retry button. Recovery currently requires another WebSocket reconnect or a
reload. Retry the non-mutating state probe, or expose a reconciliation retry,
without resending the already accepted command.

Reproduced with the existing browser harness: acknowledge a queued slash command,
fail only its first fresh state probe, restore healthy HTTP, and advance the
browser clock through sixty seconds of normal polling. The next instruction is
still queued and no Retry control is available. The assertion that delivery or
explicit recovery becomes available fails.

These findings are separate: the first needs an acceptance/delivery distinction;
the second needs recovery when an authoritative probe cannot be obtained.
Neither derives from a repository-specific rule in the applicable AGENTS.md.

## Does the extension implementation make sense?

Yes. The branch changes only the shared ask path, captures `ctx.signal` before
awaiting, blocks an already-aborted request, passes the signal into confirmation,
and checks that same signal again afterward. Explicit denial, absent UI, policy
precedence, supported-tool scope, and YOLO behavior are preserved. No actionable
extension-side defect was found. The existing review's suggestions to pin exact
reason wording or test an unavailable signal are not demonstrated runtime bugs
and are not promoted to findings here.

## Do the tests make sense?

Yes. The extension's deferred-confirm tests exercise cancellation and approval
races for the actual handler. Tau's six real-Pi scenarios validate the independent
extension/native-RPC contract, including the no-execution sentinel, instead of
letting Tau's cancellation fallback conceal an extension regression. The generic
fake-Pi browser tests appropriately cover Tau's own dialog transport and recovery.
The current queue regressions are useful but cover successful reconnect probing
and outright POST failure, not the two boundary cases above.

## Verification performed this round

| Check | Result |
|---|---|
| Tau `npm run typecheck` | Pass |
| Tau `npm test` | 223/223 pass; no skips |
| Tau `npm run test:e2e` with the installed Nix browser bundle explicitly selected | 30/30 pass; no skips |
| Extension branch export `npm run check`, using existing Pi 0.85.1 development dependencies | Typecheck and 25/25 tests pass |
| Tau real-Pi regression with `TAU_PERMISSION_EXTENSION_DIR=/tmp/pi-permission-round2` | 6/6 pass against the requested extension branch |
| Two additional disposable browser probes | Both fail on the expected queue-invariant assertions described above |
| `git diff --check` | Clean before this review append |

The additional probes are in `/tmp/tau-review-probes/probes.test.ts`; their output
is `/tmp/tau-round2-probes.log`. They reuse the existing browser/fake-child harness
and do not modify production code or committed tests. The normal e2e runner first
hit a sandbox restriction on Nix's home-directory cache; selecting the already
installed `/nix/store/...-playwright-browsers` bundle allowed all tests to run.

## Review-file delivery limitation

This session can write only inside Tau and `/tmp`, not the sibling extension
checkout. The extension-specific appendix is prepared at
`/tmp/pi-permission-round2/review-appendix.md` for appending to its existing
`.plans/completed/debug-session-hang-and-unaborteable/review.md`. It has not been
appended to that repository. No live session, loading symlink, configuration,
branch checkout, or installed dependency was changed or restarted.

## Fixes for the two queue reconciliation findings

### Reconnect now waits for prompt acceptance

`src/public/app-main.ts` now tracks HTTP prompt acceptance separately from
`agent_start`. Reconnecting remembers that completion must be reconciled, but
does not send a completion probe until the prompt receives a successful
acknowledgement. The acceptance handler then performs the deferred probe. This
preserves instruction order when the first POST is delayed across reconnect,
while retaining recovery for an operation whose settlement event was missed.

The browser regression holds the first POST before delivery, reconnects, and
verifies that no fresh completion probe or second prompt is sent. After releasing
and acknowledging the first POST, it verifies that Pi receives both instructions
exactly once and in their original order.

### Failed completion probes now recover automatically

Unresolved slash-command and reconnect reconciliation now retry the read-only
fresh state request after one second. HTTP errors, unsuccessful RPC responses,
and network failures all retain the lock until a successful idle answer arrives.
Only one probe per dispatch can be in flight. Retries retain the reconnect
context and check dispatch identity, so settlement, session closure, or a newer
dispatch makes an old retry harmless. The accepted command is never resent.

Three browser regressions each fail two consecutive probes, covering network,
HTTP, and RPC failures. They verify automatic queue progress after recovery,
exactly one delivery of each instruction, and no further retries after release.

Validation: `npm run typecheck` passed; `npm test` passed all 223 tests with no
skips; the full `npm run test:e2e` suite passed all 34 browser tests with no skips,
including the four new regressions, using the installed Nix browser bundle.
`git diff --check` was clean.

---

# Third round of joint review — independent verification (2026-09-10)

## Scope and verdict

Reviewed Tau `main...fix/abort-permission-waits` at `ab1cdaa`, including the latest
queue reconciliation fixes, and the permission extension's implementation branch
at `a579238` against its pre-fix revision `6fd96a4`. The extension checkout remains
on `master` at `762706a`; its subsequent changes are release versions and the Pi
development dependency range, not changes to the cancellation implementation or
behavior tests. I used a disposable branch export rather than switching it.

The coordinated plan makes sense and the extension implementation is correct.
The two actionable findings from the previous Tau review are addressed. One
remaining P2 delivery-recovery defect prevents approving the joint patch as a
whole. No production code or committed tests were changed during this review.

## Does the plan solve the bug?

Yes. An execution timeout cannot bound a tool's preflight approval wait. Capturing
the active turn signal, passing it to confirmation, and checking it again after
approval releases native Abort without allowing an unapproved tool to execute.
Tau's separate server-owned registry, deadline-preserving recovery, write-only
dialog replies, and native Abort ordering address the browser/transport half of
the problem. The plan appropriately distinguishes a confirmed failure mechanism
from an unproven explanation of the historical session trace.

The queue-recovery plan needs one additional distinction: failure to receive an
acknowledgement does not establish that an instruction was not sent. Retrying a
read-only completion probe is safe; presenting an already running instruction as
an unsent command for replay is not.

## Finding

### [P2] Reconcile uncertain prompt delivery before offering an unsent retry

Location: `src/public/app-main.ts:1404–1408`.

If Pi accepts and starts a queued instruction but its HTTP acknowledgement is
lost, this catch deletes the dispatch and puts the instruction back as “Not sent”
with Retry, even when `queued.started` is already true. Subsequent settlement
cannot remove that requeued copy, so Retry after completion executes the same
instruction again and later queued instructions remain blocked until the user
retries or cancels it. Preserve/reconcile the dispatch when execution is already
known, and distinguish uncertain delivery from an explicit rejection before
offering a replay. A failed response transport alone is not proof of non-delivery.

Reproduced using the existing real-browser/fake-Pi harness: allow the queued POST
to reach Tau, emit its successful native prompt response and `agent_start`, then
drop only the HTTP response. The browser shows “Not sent” for the running prompt.
After `agent_settled`, clicking Retry sends that same prompt a second time. The
assertion that it was delivered exactly once fails with `2 !== 1`.

This is separate from the two previous findings: acceptance gating and probe
retries now work, but this error path discards the state before reconciliation can
help. No repository-specific AGENTS.md rule materially supplies this finding; it
is a demonstrated delivery/state correctness defect.

## Does the implementation make sense?

Yes, apart from the finding above. The latest `accepted` flag prevents a reconnect
idle probe from releasing an unresolved POST. Remembering reconnect context until
acceptance preserves instruction order. The single-flight, identity-guarded
completion probes recover from network, HTTP, and RPC failures without resending
the accepted command. The server's dialog claiming and Abort handling remain
consistent with their separate transport and operation-completion responsibilities.

The extension remains a small change to the shared ask path. Its captured signal
and post-await cancellation check preserve fail-closed behavior and leave policy
precedence, supported tools, explicit denial, no-UI behavior, and YOLO semantics
unchanged. No actionable extension defect was found.

## Do the tests make sense?

Yes. The new delayed-POST browser test exercises acceptance gating across a real
reconnect. The three failed-probe tests cover network, HTTP, and RPC failures and
verify that only the read is retried. The existing suite covers dialog recovery,
multiple clients, Abort ordering and acknowledgements, and queue completion.
Extension behavior tests exercise the actual handler, including approval/abort
races, and the six real-Pi scenarios validate native cancellation independently
of Tau's fallback replies.

The missing regression is loss of the HTTP response after delivery, rather than
loss of the POST before delivery. The disposable probe adds that distinction and
fails on the duplicate-delivery assertion, not on setup or browser availability.

## Verification performed this round

| Check | Result |
|---|---|
| Tau `npm run typecheck` | Pass |
| Tau `npm test` | 223/223 pass; no skips |
| Tau `npm run test:e2e`, selecting the installed Nix browser bundle | 34/34 pass; no skips |
| Extension branch export `npm run check`, using existing dependencies | Strict typecheck and 25/25 behavior tests pass |
| `TAU_PERMISSION_EXTENSION_DIR=/tmp/pi-permission-round3 node --test test/permission-rpc.test.ts` | 6/6 pass against the implementation branch; no skips |
| Additional lost-acknowledgement browser probe | Fails as expected: Retry delivers the already-started instruction twice |
| `git diff --check` before the review append | Clean |

The additional probe and its output are `/tmp/tau-round3-probe.test.ts` and
`/tmp/tau-round3-probe.log`. Other logs are `/tmp/tau-round3-typecheck.log`,
`/tmp/tau-round3-test.log`, `/tmp/tau-round3-e2e.log`,
`/tmp/pi-permission-round3-check.log`, and `/tmp/tau-round3-extension-rpc.log`.
All earlier review text is preserved. No live Pi process, loading symlink,
configuration, session transcript, installed dependency, or branch was changed.

## Companion review delivery limitation

The extension plan/review has moved to
`.plans/completed/debug-session-hang-and-unaborteable/`. This session may write
only inside Tau and `/tmp`, so I could not append to the sibling repository.
Its next-round appendix is prepared at
`/tmp/pi-permission-round3/review-appendix.md`; it is not yet appended there.

---

## Fix summary for the round-three uncertain-delivery finding

Queued prompts now remain tracked when their HTTP acknowledgement is lost,
including when Tau has already observed `agent_start`. They are shown as
“Delivery uncertain” without a Retry button, rather than being put back in the
unsent queue. Settlement removes the tracked dispatch, so it cannot leave a
second copy behind for accidental replay.

Tau now distinguishes explicit prompt rejection from a server-side timeout or
transport exception. Only an explicit rejection, with no observed execution,
returns an instruction to “Not sent” with Retry. Network failures, malformed or
unsuccessful HTTP responses, and server acknowledgement timeouts remain uncertain.

Observed execution permits read-only completion reconciliation even without the
HTTP acknowledgement. This also works when `agent_start` arrives after the
delivery failure. The existing reconnect recovery and repeated state probes can
release the dispatch without resending it.

When neither acceptance nor execution is known, an idle state response still
cannot prove that a delayed instruction will never arrive. Tau deliberately
keeps that dispatch and subsequent instructions queued, with a visible uncertain
status. This fix does not provide durable delivery receipts or automatic replay
for that unresolved case.

Regression coverage now drops the HTTP response after Pi receives the prompt,
with execution observed both before and after the failure, and with completion
lost during a socket disconnect. It verifies exactly one delivery and subsequent
queue progress. Additional cases keep network failures and acknowledgement
timeouts locked across reconnects without execution evidence, and preserve Retry
for explicit rejection. Server tests verify the rejection/uncertainty distinction.

### Verification of the round-three fix

- `npm run typecheck` and `npm run build` passed.
- `npm test` passed all 224 tests with no skips.
- The full browser suite passed all 39 tests with no skips, using the installed
  Nix browser bundle. After the final reconciliation cleanup and rebuild, the
  complete dialog/queue browser file passed all 31 tests again with no skips.
- `git diff --check` passed. A byte-for-byte prefix comparison against the review
  captured before this appendix confirmed that all existing review text,
  including the previously uncommitted round-three review, is unchanged.

Logs: `/tmp/tau-fix-round3-typecheck.log`, `/tmp/tau-fix-round3-build.log`,
`/tmp/tau-fix-round3-test.log`, `/tmp/tau-fix-round3-e2e.log`, and
`/tmp/tau-fix-round3-final-queue.log`. This fix changes Tau only; no sibling
repository or existing companion review was edited.
