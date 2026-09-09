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
