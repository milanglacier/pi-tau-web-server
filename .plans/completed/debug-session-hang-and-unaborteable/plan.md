# Goal
Explain why session `01a07988-d77b-77cc-8a45-9ba30407d024` stopped after its Docker/Nix bash call, and prevent unanswered permission dialogs from making Tau sessions impossible to interrupt. Implementation and validation are complete in both source repositories. Live session state remains untouched; adoption by existing processes still requires a user-approved safe reload/restart.

## Implementation repositories and local loading
- Apply the permission-extension fix in `/home/milanglacier/Desktop/personal-projects/pi-minimal-permission-system`, the extension's source working directory, not in Tau or a downloaded npm copy.
- The standalone extension fix plan is `/home/milanglacier/Desktop/personal-projects/pi-minimal-permission-system/.plans/active/debug-session-hang-and-unaborteable/plan.md`. That plan owns the extension implementation and its regression coverage; this plan owns the coordinated Tau changes.
- This machine loads the extension via `~/.pi/agent/extensions/pi-minimal-permission-system`, a symlink to the source repository (verified during implementation). Publishing or installing an npm release is not required for local use.
- Target the latest Pi behavior only, as requested during implementation. npm's latest version and the installed dependency are both `0.85.1`. Use `agent_settled` for operation completion and native acknowledgements for RPC success; do not add legacy protocol fallbacks.
- Existing Pi processes may still have the old code loaded. After implementation, verify the resolved extension source in a disposable process and arrange a safe reload/restart only with the user's approval. Do not modify the symlink/configuration or restart live sessions as part of this planning work.

## Findings and confidence

### Evidence from the supplied trace
- File: `~/.pi/agent/sessions/--home-milanglacier-Desktop-personal-projects-tau--/2026-09-07T01-43-26-331Z_01a07988-d77b-77cc-8a45-9ba30407d024.jsonl`.
- There are 80 entries. The final entry, at `2026-09-07T07:33:48.426Z`, records the assistant's bash tool call with `timeout: 180`. There is no matching tool result or subsequent entry.
- This is a conversation/session log, not a complete RPC event log. It cannot show whether the final shell actually started, whether a dialog was delivered, or whether Abort reached Pi.
- Under the current global permission policy (`~/.pi/agent/permissions.jsonc`), the final command matches the `rm -rf` ask rule. None of the preceding main-session bash calls matches the policy's ask patterns. This makes the permission hypothesis particularly plausible, but does not prove the historical runtime state.

### Confirmed failure mechanism in the code inspected during the investigation
- At the original investigation, installed Pi and Tau's local Pi dependency both reported version `0.85.1`; the permission extension was `1.1.1`. The npm path below is historical evidence, not the current deployment target.
- `~/.pi/agent/npm/node_modules/pi-minimal-permission-system/index.ts:205` awaited `ctx.ui.confirm(...)` without a timeout or cancellation signal. The source checkout's `index.ts` also contains this uncancelled confirmation, as verified during this plan update.
- The extension checks the whole bash command before execution. It does not wait until the shell reaches `rm -rf`. If permission was pending, neither Docker nor bash's 180-second execution timer had started.
- Pi's `dist/modes/rpc/rpc-mode.js:47–85` waits for a matching `extension_ui_response`, or an explicitly supplied dialog timeout/signal. RPC mode has `ctx.hasUI === true`; lack of a connected browser does not make it automatically deny.
- Pi's RPC Abort handler (`rpc-mode.js:329`) calls `session.abort()`. `dist/core/agent-session.js:1222` aborts the agent and then awaits idle, but RPC Abort does not resolve pending UI requests. The tool preflight hook is still awaiting the confirmation, so the turn cannot reach idle.
- Pi already exposes `ctx.signal` to extensions, and its confirm options accept `signal`. The permission extension is not using this existing cancellation support.

### Confirmed Tau problems that amplify this mechanism
- `src/server/sessions.ts`, `handleEvent()` and `snapshot()`: UI requests are broadcast but are not retained as pending server state or included in snapshots. A request emitted while the browser is disconnected, or lost on a full refresh, cannot be recovered by reconnecting. Whether a disconnect occurred in this incident is unknown.
- `src/public/app-main.ts:944–971`: background-tab dialog requests are retained only in browser memory.
- `src/public/app-main.ts:1300`: Abort sends only the abort command, immediately displays “Aborted by user,” and does not dismiss outstanding permission requests.
- `src/server/server-main.ts:336`: an Abort acknowledgement timeout is converted to success. The current test in `test/rpc-command.test.ts:241` explicitly enforces this incorrect behavior.
- `src/public/app-main.ts:1242`: new instructions are queued locally while the session is streaming, which explains why they cannot break a stuck permission wait.

### What cannot be established retrospectively
- `/yolo` toggles only an in-memory boolean and emits a transient notification. The extension does not persist the state or toggle to the session trace. Absence of `/yolo` text is not evidence it was off, because Pi handles extension slash commands outside ordinary conversation messages.
- Tau does not add `--yolo` when spawning Pi, and the extension defaults to false on session start. A user toggle in the original process remains possible.
- The currently attached Pi process (PID 3095477 at inspection time) started at `2026-09-07T14:42:24-04:00`, after the final trace entry. It is not the original blocked process; current process state cannot prove what happened then.
- If YOLO was enabled when the tool call entered its permission hook, this extension would have bypassed the confirmation. In that case, actual shell/process cancellation or another hook needs separate runtime evidence. Do not claim Docker itself hung based solely on the dangling tool call.

## Recommended implementation

### 1. Add deterministic regression coverage before fixing the behavior
Use a disposable session with isolated settings and a fake model/tool; do not replay the Docker command or touch the supplied session file.
- Reproduce a bash preflight confirmation left unanswered. Show that no tool execution begins and that a short bash timeout does not bound the approval wait.
- Show that Abort remains pending with the current extension, then that a cancelled confirmation releases it without executing the tool.
- Cover YOLO enabled before tool preflight: it skips the confirmation. Toggling YOLO after the hook is already waiting must not be mistaken for resolving that existing request.
- Prefer a fake streaming provider plus the real Pi session/RPC path for the cancellation regression, rather than only mocking an abort success response. Use bounded test deadlines.

### 2. Fix the permission extension at its source, as a separate package change
Source repository and implementation working directory: `/home/milanglacier/Desktop/personal-projects/pi-minimal-permission-system`; do not patch any installed `node_modules` copy. Follow the standalone plan at `/home/milanglacier/Desktop/personal-projects/pi-minimal-permission-system/.plans/active/debug-session-hang-and-unaborteable/plan.md` for this work.
- In `index.ts`, pass the active `ctx.signal` into the permission confirmation options.
- Preserve fail-closed behavior: cancellation must never approve or execute the command. Distinguish cancellation from an explicit user denial where practical.
- Add tests in that repository's `tests/` for unanswered confirmation + abort, already-aborted signal, approve, deny, absent UI, and YOLO bypass.
- Keep waiting for explicit approval valid when the user has not aborted. Do not add an arbitrary approval deadline or automatically enable YOLO.
- Run `npm run check` from the extension repository. Validate the fixed source through this machine's existing symlink-based extension loading in a disposable Pi process; no npm publication or installation is needed for local use. Avoid loading both the symlinked extension and an npm copy during validation. Existing running processes need a safe reload/restart before they use the fix; do not restart them automatically. A published release, if desired, is separate follow-up work.

### 3. Make pending dialogs server-owned and recoverable in Tau
Files: `src/server/sessions.ts`, `src/server/types.ts`, and `src/server/server-main.ts`.
- Maintain a per-live-session registry keyed by UI request ID for response-bearing methods only: confirm, select, input, editor. Keep it separate from pending RPC command acknowledgements.
- Include pending dialogs and their original timing information in live-session snapshots; expose a pending-interaction count in session metadata for tab indicators.
- Retain requests while all browsers are disconnected. Do not persist live request IDs into the conversation transcript or replay them after a Pi process restart.
- Route dialog replies through the registry. Accept only a pending request in the specified session; serialize concurrent replies so the first accepted reply wins. Broadcast resolution so other browsers dismiss the same dialog without sending extra cancellation replies.
- Introduce an explicit write-only RPC path for `extension_ui_response`. Pi does not acknowledge these messages; resolve Tau's delivery acknowledgement after a successful stdin write rather than creating a 60-second pending command. Never describe this transport acknowledgement as proof that a tool completed.
- Expire requests with explicit deadlines without restarting their timeout after reconnect. Clear outstanding requests on process exit/termination and confirmed operation completion where applicable. Do not clear unrelated idle slash-command dialogs merely because an unrelated tool ends.

### 4. Make Abort release pending dialogs and report its real result
Files: `src/server/sessions.ts`, `src/server/server-main.ts`.
- Add a session-scoped abort operation that sends native Abort first and then sends cancellation responses for all outstanding dialogs without waiting for the Abort acknowledgement. Sending Abort first ensures the agent's cancellation signal is set before the permission hook resumes.
- During the pending abort, cancel new dialogs for that session as well. Coalesce repeated Abort requests and handle approval/abort races without approving anything on the user's behalf.
- Cancel all pending dialogs through the current Pi UI response protocol, including hooks that omit cancellation signals. This is not a legacy Pi compatibility layer and does not require a Pi fork.
- Remove the conversion of Abort timeouts into success. Preserve an honest “still stopping/stop timed out” outcome and leave the actual running state authoritative. Do not automatically kill or restart the process on timeout.
- Keep existing queued user instructions intact and session-scoped; allow normal delivery only after actual operation completion.

### 5. Reconcile browser dialogs and stop status with server state
Files: `src/public/app-main.ts`, `src/public/app-types.ts`, `src/public/dialogs.ts`, `src/public/websocket-client.ts`.
- Hydrate/reconcile dialogs from snapshots and resolution events. Deduplicate event/snapshot races and ensure a delayed snapshot cannot resurrect a resolved dialog, using a monotonic interaction revision or an equivalent ordering mechanism.
- Preserve tab switching without cancelling another session's dialog. A new browser or a reconnect must recover the pending request and its remaining deadline.
- Route both the Abort button and keyboard abort through one implementation. Display “Stopping…” on request; display completion only after Pi confirms it, and surface failure/timeout instead of immediately claiming the operation was aborted.
- Clear resolved/cancelled dialogs locally without producing another response. Make “Waiting for approval” visible independently of a generic tool spinner.

### 6. Validate the full workflow and add minimal diagnostic evidence
Tests: extend `test/pi-rpc-session.test.ts`, `test/rpc-command.test.ts`, and `test/websocket.test.ts`; add `test/e2e/permission-dialog.e2e.ts` following the existing fake-child/browser test setup.
- Unanswered confirm → Abort → no shell execution → session becomes idle → a new instruction runs.
- Missing browser at request time; refresh; reconnect; background tab; multiple browser clients; first-response wins; stale/duplicate replies; explicit dialog timeout; child exit; repeated Abort; dialog arriving during Abort; stdin failure; genuine Abort timeout; all four dialog methods; ordinary running bash still aborts.
- Replace the test asserting that Abort timeout means success. Verify that write-only UI replies create no pending acknowledgement timer.
- Run `npm run typecheck`, `npm test`, and `npm run test:e2e` from the Tau repository, plus `npm run check` from `/home/milanglacier/Desktop/personal-projects/pi-minimal-permission-system`. Ensure cross-repository cancellation tests load the source checkout's extension, not a stale npm copy.
- Add concise opt-in lifecycle diagnostics recording session/request IDs, request creation/resolution reason, abort sent/acknowledged/timed out, and timestamps. Avoid logging full command arguments, dialog text, credentials, or conversation contents by default.
- For future YOLO diagnosis, a separate extension observability improvement may record mode transitions as custom session entries without changing the existing nonpersistent permission-mode semantics. Do not silently persist or restore YOLO as part of this fix.

## Implementation and validation results
- The extension captures `ctx.signal`, passes it to confirmation, blocks already-aborted requests, and checks cancellation again before accepting approval. Its standalone plan records the extension-specific results.
- Tau retains response-bearing dialogs in live server state, snapshots their original deadlines, and publishes revisioned full interaction state. Replies are validated and claimed once per session/request, then acknowledged on stdin delivery without an RPC response timer. Failed delivery remains recoverable.
- The acknowledgement-timeout-to-success conversion was removed for `prompt` as well as for Abort and UI replies. Current Pi acknowledges `prompt` after preflight rather than after completion, so a 10-second timeout there is a genuine failure and is now reported as one; `test/rpc-command.test.ts` covers it.
- Abort writes native cancellation first, cancels existing and newly arriving dialogs, coalesces concurrent requests, and exposes stopping/timeout/failure honestly. A delayed acknowledgement cannot mark a newer operation idle. Neither `turn_end` nor `agent_end` is treated as completion; only current Pi's `agent_settled` or a matching native Abort acknowledgement establishes idle.
- The browser reconciles dialogs without duplicate cancellation replies, recovers on refresh/reconnect/tab switches, preserves deadlines, and shows pending counts/approval status. Button and keyboard Abort share the same handling. Queued instructions remain session-scoped, await real operation completion, and can be explicitly retried after rejection. A fresh native `get_state` probe distinguishes a handled extension command from cached idle after prompt acceptance.
- `TAU_INTERACTION_DIAGNOSTICS=1` enables minimal lifecycle records; README documents their fields/privacy limits and the current-Pi-only protocol requirement.
- Regression tests failed before the relevant fixes: absent snapshot registry, duplicate/ack-waiting replies, Abort timeout falsely reported as success, early turn completion, stale Abort acknowledgements, and the missing browser transport dispatch. The real-Pi cancellation test also reproduced a five-second unanswered Abort against a disposable pre-fix extension source copy, without executing its sentinel.
- Final Tau checks: `npm run typecheck` passes; `npm test` passes all **223 tests**, including **six real Pi RPC scenarios**; `npm run test:e2e` passes all **28 browser tests** (20 permission/Abort regressions plus eight existing history regressions), with no skipped tests.
- Final extension check: `npm run check` passes strict TypeScript checking and all **25 behavior tests**. `git diff --check` passes in both repositories.
- No Pi configuration, symlink, original session JSONL, or live process was modified/restarted. No npm package was published or installed, and no commit was created. The source symlink was verified; existing Pi sessions need an approved safe reload/restart. Tau's server and browser must be updated together because no older-protocol compatibility path is retained.

## Recovery guidance for the existing incident
- No recovery action was performed during this investigation.
- If the original process is still waiting and the dialog is visible, denying/cancelling that request will release the wait; Abort should precede cancellation when the intent is to stop the entire turn rather than let the model continue after denial.
- Refresh alone is not a reliable recovery in the current Tau version because the server cannot replay its pending dialog.
- If the request has been lost, explicitly close only the affected live Tau session and resume its saved history after confirming any background-work consequences. Never delete or hand-edit the JSONL, kill unrelated sessions, approve the command merely to unblock it, or enable YOLO as a recovery shortcut.
- Since this session already has a newer Pi process, distinguish an old dangling historical tool card from a genuinely active blocked turn before taking further recovery action.

## Acceptance criteria
An unanswered permission request may wait for the user, but remains visible/recoverable and cancellable. Abort must stop the turn without executing the unapproved tool, must not falsely report success, and must leave the session able to accept further instructions. Missing historical YOLO evidence must remain explicitly unknown rather than being inferred from silence in the trace.
