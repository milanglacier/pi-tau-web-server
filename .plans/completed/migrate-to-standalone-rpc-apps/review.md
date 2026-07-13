---
status: COMPLETED
---

## Findings

### Finalize streaming messages from the completed payload

When a browser selects or reloads a Tau tab while the Pi child is already streaming, the snapshot has no partial assistant text and the client only accumulates deltas received after reconnect. `message_end` carries the complete assistant `message`, but `handleMessageEnd()` ignores that payload whenever `currentStreamingElement` exists and finalizes only the partial text accumulated locally, so the rendered answer can be truncated after refresh/reconnect during streaming.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/app.js:605-613`

### Use the queued session id when flushing prompts

Queued prompts are stored globally and `flushQueue()` sends the next queued command to the current `activeLiveSessionId`. If session A is streaming, the user queues a prompt, then switches to idle session B before the queue flushes, the queued prompt from A is submitted to B, mixing conversations across backend Pi sessions.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/app.js:969-974`

### Preserve string model specs in the header

For sessions created with a raw model string, the backend returns `get_state.data.model` as that string. `fetchModelInfo()` assumes the model is an object and assigns `stateData.data.model.id || ''`, which clears the header label back to `model` after selecting the tab even though `applyActiveSessionMetadata()` initially had the correct `modelLabel`/`modelSpec`.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/app.js:1109-1111`

## Overall assessment

**Verdict:** Needs revision.

**Explanation:** The standalone session architecture is largely in place, but the current frontend can lose streamed output on reconnect and route queued prompts to the wrong Pi session. The model-label issue is smaller but violates the session-scoped model display expected by the plan.

## Fix summary

- Updated `handleMessageEnd()` to refresh the streaming DOM from the authoritative final assistant `message_end` payload before finalizing, so reconnecting or selecting a tab mid-stream no longer leaves truncated assistant output.
- Made queued prompts session-scoped by storing `sessionId` on queued commands, rendering/flushing only the active tab's queue, and sending queued prompts with their original session id.
- Preserved raw string model specs in `fetchModelInfo()` so session-start model strings continue to display in the header after state refreshes.

Validation: `node --check public/app.js`.

---

## 2nd round review

## Findings

### Gate live events while viewing history

Selecting a non-live historical session sets `viewingActiveSession = false`, but leaves `activeLiveSessionId` pointing at the previously selected live Tau tab. Because the WebSocket handler renders any event whose `sessionId` matches `activeLiveSessionId`, output from that live child can still be appended into the historical read-only transcript while the user is browsing history; either clear/suspend the active live id on history selection or also require `viewingActiveSession` before calling `handleRPCEvent()`.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/app.js:218-220`

### Escalate stubborn child processes to SIGKILL

`child.killed` becomes `true` as soon as `kill('SIGTERM')` is successfully sent, not when the process has actually exited. If a Pi RPC child ignores or hangs during SIGTERM on Tau tab close or server shutdown, the `!this.child.killed` check prevents the planned SIGKILL fallback from ever running, leaving a managed child process alive after the backend considers the session closed.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/bin/tau.js:402-405`

### Disable file browsing without a validated live tab

When the file sidebar is opened before a live tab is selected, or when `localStorage` contains a stale `activeLiveSessionId`, `FileBrowser.load()` sends `/api/files` with no valid `sessionId`; the backend then falls back to the Tau server cwd. That lets the UI show and insert file paths from the wrong project even though the plan says file browsing should be scoped to the active session cwd or disabled when no live session is active.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/file-browser.js:58-61`

### Preserve sidebar rename support through the RPC shim

The sidebar still posts `{ type: 'set_session_name', name }` for renames, but the standalone `/api/rpc` whitelist omits `set_session_name`, so the backend returns `Unknown command` and the UI silently replaces the title locally without persisting it. Either emulate this command against the managed session metadata/history or remove/disable the rename action in standalone mode.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/bin/tau.js:521-522`

## Overall assessment

**Verdict:** Needs revision.

**Explanation:** The migration mostly implements the standalone session model, but live child output can leak into historical views and child cleanup can leave orphaned Pi processes. The file-browser and rename issues are smaller but still break session-scoped behavior and existing sidebar actions.

## 2nd round fix summary

- Gated session-scoped WebSocket rendering on `viewingActiveSession`, so live child events no longer render into the transcript while a historical read-only session is selected.
- Fixed `PiRpcSession.terminate()` to use `signalCode`/`exitCode` instead of `child.killed`, allowing the SIGKILL fallback to run when a child ignores SIGTERM.
- Made file browsing require a validated active live Tau tab for default loads, added an empty state when no tab is selected, and made `/api/files` reject missing/stale session ids instead of falling back to the Tau server cwd.
- Restored sidebar rename persistence by sending the target session `filePath` and emulating `set_session_name` in the standalone RPC shim by appending a `session_info` record and updating matching live-session metadata.

Validation: `node --check` on `bin/tau.js`, `public/app.js`, `public/file-browser.js`, and `public/session-sidebar.js`; manual curl checks for `/api/files` without a live session and `/api/rpc set_session_name` against a temp session file.

---

## 3rd round review

## Findings

### Pass the session into the rename handler

Right-click rename still does not persist because `startRename()` only receives `itemEl`, but its commit path posts `filePath: session.filePath`; `session` is not in scope for that method. Renaming any sidebar item therefore hits the silent `catch` and only changes the DOM until the next sidebar reload, so the standalone `set_session_name` shim added for this migration is never actually called with a file path.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/session-sidebar.js:263-282`

### Block RPC controls while a history transcript is selected

Selecting a historical session sets `viewingActiveSession = false`, but `activeLiveSessionId` is intentionally left pointing at the last live Tau tab and `rpcCommand()` blindly injects that id into commands. While the UI is showing a read-only history transcript, actions such as Compact, Session Stats, model selection, or thinking-level cycling can mutate the hidden live Pi child instead of being disabled/rejected for the historical view.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/app.js:1070-1073`

### Export the selected historical session

The sidebar context-menu export action ignores the `session` argument and posts only `{ type: 'export_html' }`, but the standalone backend now requires a live `sessionId` before reaching the `export_html` handler. Right-clicking Export HTML on a historical session therefore fails silently with “No active Tau session” instead of exporting the selected saved JSONL file.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/session-sidebar.js:327-333`

## Overall assessment

**Verdict:** Needs revision.

**Explanation:** The core standalone session flow is close, but sidebar rename/export actions are still disconnected from the selected history file, and global RPC controls can operate on a hidden live session while the user is viewing history. These are discrete regressions from the migration and should be fixed before landing.

## 3rd round fix summary

- Passed the selected sidebar session into `startRename()`, so the rename commit can send the correct `filePath` to the standalone `set_session_name` shim.
- Prevented generic RPC controls from implicitly targeting the last live Tau tab unless the browser is currently viewing that live tab, and disabled command/model/thinking controls in read-only history/no-session views.
- Made historical sidebar export send the selected session `filePath`, taught the backend `export_html` shim to export by `filePath` without requiring a live child session, and opened the exported file via the existing native-open endpoint.

Validation: `node --check bin/tau.js public/app.js public/session-sidebar.js`.

---

## 4th round review

## Findings

### Clear stale active tabs after reconnect

`restoreActiveLiveSession()` falls through to `updateMirrorInputState()` when the saved tab no longer exists, but it leaves `activeLiveSessionId` and `viewingActiveSession` unchanged. If the browser disconnects while its only Pi child exits or is closed elsewhere, the reconnect state has no live sessions but the UI can still enable input against the stale id; `sendMessage()` then renders the user's prompt locally and the backend error response is ignored by the chat view.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/app.js:340-344`

### Route dialog responses to the requesting session

Dialog responses use `this.getSessionId?.()` at click/timeout time, which returns the currently active Tau tab, not necessarily the tab that emitted the `extension_ui_request`. If a confirmation/input dialog is shown for session A and the user switches to session B before answering, the `extension_ui_response` is sent to B while A remains blocked waiting for its response.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/dialogs.js:192-198`

## Overall assessment

**Verdict:** Needs revision.

**Explanation:** The remaining issues are edge cases, but both break core standalone multi-session semantics: stale tabs can accept prompts after reconnect, and UI responses can be delivered to the wrong Pi child. The change should clear invalid active state and capture the originating session id for dialogs before landing.

## 4th round fix summary

- Cleared stale active live-session state when reconnect/initial state contains no valid saved or recent Tau tab, including removing the localStorage active id, resetting live view state, rerendering tabs/queue, and disabling input.
- Threaded the originating `sessionId` from session-scoped WebSocket events into extension UI dialogs, and captured that id for click/cancel/timeout responses so `extension_ui_response` returns to the Pi child that requested it even if the user switches tabs before answering.

Validation: `node --check public/app.js public/dialogs.js`.

---

## 5th round review

## Findings

### Handle turn events as active streaming lifecycle

The backend and plan both treat `turn_start`/`turn_end` as streaming boundaries, but the active frontend switch only updates UI state for `agent_start`/`agent_end`. If a Pi RPC child emits `turn_start` without an `agent_start`, the active tab remains in the idle UI state with the abort button hidden and `state.isStreaming` false, so a second prompt can be sent immediately instead of being queued for that session.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/app.js:472-479`

### Sync controls from streaming snapshots

Selecting or reloading a Tau tab whose backend snapshot has `isStreaming: true` only sets `state.isStreaming`; it never calls the same UI updates used when streaming starts. The selected tab can therefore show an idle send button and no typing/abort state until a later lifecycle event arrives, which is exactly the refresh-while-streaming case the plan calls out for snapshot restoration.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/app.js:1517-1519`

### Do not drop UI requests from inactive sessions

Session-scoped WebSocket events are returned before `handleRPCEvent()` whenever they are not for the currently visible Tau tab, so `extension_ui_request` events from background streaming sessions are discarded. A Pi child that asks for a confirmation/input while its tab is inactive will wait for an `extension_ui_response` that the browser never sends, and switching back later cannot recover the missed request from the snapshot.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/app.js:218-220`

### Confirm before closing tabs with queued prompts

`closeLiveSession()` only asks for confirmation when the session is currently streaming, but the plan also requires confirmation when the tab has unsent queued messages. Closing a tab with entries in `messageQueue` for that session currently terminates the Pi child and silently drops those queued prompts.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/app.js:395-400`

## Overall assessment

**Verdict:** Needs revision.

**Explanation:** The core standalone flow is in place, but streaming state is still incomplete for turn events and snapshot restores, and background UI requests can be lost. The queued-close confirmation is smaller but directly violates the planned tab-close semantics.

## 5th round fix summary

- Routed `turn_start`/`turn_end` through the same active streaming UI lifecycle as `agent_start`/`agent_end`, with duplicate end-event notification guarding.
- Applied snapshot streaming state to the visible controls and typing indicator so reconnecting/selecting an in-flight Tau tab shows the abort/working UI immediately.
- Allowed inactive-session `extension_ui_request` events to reach the dialog handler with their originating `sessionId`, instead of dropping them before a response can be sent.
- Added close confirmation for Tau tabs with queued unsent prompts, including the combined streaming-plus-queued case.

Validation: `node --check public/app.js`.

---

## 6th round review

## Findings

### Reconcile stale active tabs during live-session polling

`pollInstances()` is documented as the fallback when WebSocket updates are missed, but it only replaces `liveSessions` through `setLiveSessions()` and never checks whether `activeLiveSessionId` still exists in the backend list. If the active Pi child exits or is closed by another client and this browser misses `live_session_closed`, the tab strip loses that tab while `viewingActiveSession` and the stale active id remain enabled; the next prompt is rendered locally and sent to a non-existent session, and the WebSocket error response is not shown in the chat.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/app.js:290-294`

### Reject deletes outside the session history directory

The standalone `/api/sessions/delete` handler unlinks whatever `filePath` the request body supplies after only checking that it exists. Because Tau listens on `0.0.0.0` by default and auth is optional, any client that can reach the server can delete arbitrary files owned by the Tau process, not just Pi JSONL session files; reuse the same session-file validation used by rename/export before calling `fs.unlinkSync()`.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/bin/tau.js:645-650`

### Respond or queue before replacing an open dialog

Each new interactive `extension_ui_request` calls `clearCurrentDialog()` before showing itself, but `clearCurrentDialog()` only removes the DOM and timeout. With multiple backend Pi children, session A can display a confirm/input dialog and then session B can emit another request; B's dialog replaces A's without sending `extension_ui_response` for A's captured `id`/`sessionId`, leaving session A blocked waiting for a response that can no longer be produced.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/dialogs.js:181-189`

## Overall assessment

**Verdict:** Needs revision.

**Explanation:** The standalone model is close, but the polling path can leave the browser targeting a dead backend session, and the new standalone delete endpoint needs to enforce session-file boundaries. Multi-session dialog replacement also needs cancellation or queuing so one Pi child cannot strand another.

## 6th round fix summary

- Reused the live-session-close cleanup path for both WebSocket close events and `/api/live-sessions` polling, so a missed close/exited-child event now clears stale active tab state, drops queued prompts for that session, and selects a valid remaining Tau tab only when the user was viewing the closed live tab.
- Restricted `/api/sessions/delete` to validated Pi JSONL session files under the configured session-history directory by reusing `resolveSessionFile()` before unlinking.
- Added dialog replacement cancellation: when a new interactive extension UI request arrives while another dialog is open, Tau now sends a cancelled `extension_ui_response` to the previous request's captured session before showing the new dialog.

Validation: `node --check bin/tau.js && node --check public/app.js && node --check public/dialogs.js`.

---

## n+1th round review (7th round)

## Findings

### Reject malformed static URLs without crashing

`serveStaticFile()` decodes the request path outside any error handling, so a malformed URL such as `/%E0%A4%A` throws `URIError`. That reaches the process-level `uncaughtException` handler and shuts down Tau, which terminates all managed Pi child sessions; a bad static-asset request should return `400` and leave the standalone backend running.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/bin/tau.js:581-583`

### Queue background UI prompts instead of canceling the active dialog

Inactive sessions' `extension_ui_request` events are still passed directly to `handleExtensionUIRequest()`. Each interactive dialog method calls `cancelCurrentDialog()`, so if active session A has a confirmation open and background session B asks for input, B's prompt cancels A's request and sends a `cancelled` response to A without user intent; queue or badge background requests instead of replacing an active-session dialog.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/app.js:218-220`

### Hide abort controls when switching to history

When a user leaves a streaming live Tau tab for a historical transcript, `switchSession()` resets streaming state and marks `viewingActiveSession = false`, but only calls `updateMirrorInputState()`. That helper disables input buttons but does not hide the existing Abort button or clear the typing/status UI, so clicking the still-visible Abort control sends `abort` to the stale `activeLiveSessionId` while the user is viewing read-only history.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/app.js:1510-1511`

## Overall assessment

**Verdict:** Needs revision.

**Explanation:** The standalone architecture is close, but a malformed request can take down all managed sessions, and multi-session UI requests can cancel the wrong tab's dialog. The history-switch abort leak is a smaller UI-state bug, but it still allows controls from a hidden live session to remain active.

## n+1th round fix summary

- Wrapped static-path decoding in `serveStaticFile()` and return `400 Bad Request` for malformed percent-encoded URLs instead of letting `URIError` reach the process shutdown handler; also resolves static paths against the static root before the traversal check.
- Queued `extension_ui_request` events from inactive Tau tabs instead of immediately opening them over the active tab's dialog, added a pending-response badge on the tab, and process the queued request when that Tau tab is selected or the current dialog becomes idle.
- Cleared streaming UI state when switching to historical read-only transcripts and guarded Abort actions so stale live-session controls cannot send `abort` while history is selected.

Validation: `node --check bin/tau.js && node --check public/app.js && node --check public/dialogs.js`; malformed static URL smoke test returned HTTP 400 while the Tau server stayed alive.

---

## n+1th round review (8th round)

## Findings

### Reject malformed live-session URLs without shutting down

`/api/live-sessions/:id` still decodes the captured id outside a guard. A request such as `/api/live-sessions/%E0%A4%A` matches the route and then `decodeURIComponent()` throws `URIError`; because `handleApiRoute()` does not catch it, the process-level `uncaughtException` handler runs shutdown and terminates all managed Pi sessions. Return `400 Bad Request` for malformed ids instead of letting a bad API URL kill the standalone backend.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/bin/tau.js:623-625`

### Reset streaming handles when applying snapshots

`selectLiveSession()` marks the tab active before awaiting the snapshot, so live WebSocket deltas can create `currentStreamingElement` while the fetch is in flight. `handleMirrorSync()` then clears and re-renders the message DOM for the snapshot without clearing `currentStreamingElement`/stream buffers; subsequent deltas and the final `message_end` update a detached node, leaving the visible transcript missing the rest of the streaming answer after switching/reloading during a stream.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/app.js:1597-1605`

## Overall assessment

**Verdict:** Needs revision.

**Explanation:** The standalone session flow is close, but malformed live-session API paths can still take down the backend, and the snapshot/stream race can drop visible output during the refresh-while-streaming scenario required by the plan.

## n+1th round fix summary (8th round)

- Guarded live-session id decoding in `/api/live-sessions/:id`, returning `400` for malformed percent-encoded ids instead of letting `URIError` reach the process shutdown handler.
- Reset active streaming DOM handles and buffers when applying a live-session snapshot, so any deltas received while the snapshot request was in flight cannot continue updating a detached message element after the transcript is re-rendered.

Validation: `node --check bin/tau.js && node --check public/app.js`; malformed live-session URL smoke test returned HTTP 400 and `/api/health` remained HTTP 200.

---

## n+1th round review (9th round)

## Findings

### Clear live view state before resetting history

Selecting a historical session while the current live Tau tab is streaming can send a queued prompt unexpectedly. `switchSession()` calls `state.reset()` and `updateUI()` before it marks `viewingActiveSession = false`; `updateUI()` then sees the old live tab as active and calls `flushQueue()`, which sends that tab's queued prompt even though the user is switching into a read-only history transcript and the child may still be streaming.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/app.js:1502-1504`

### Check snapshot responses before enabling the tab

`selectLiveSession()` does not check `res.ok` before passing the JSON body to `handleMirrorSync()`. If the child exits between rendering the tab and fetching `/api/live-sessions/:id/snapshot`, the backend returns a 404 body like `{ "error": "Live session not found" }`, but the client still treats it as a snapshot, sets `viewingActiveSession = true`, and leaves input enabled for a dead `activeLiveSessionId`.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/app.js:392-395`

### Dismiss dialogs owned by closed sessions

When a live Tau tab is closed from another client, `handleLiveSessionClosed()` removes queued UI requests for that session but leaves an already displayed `dialogHandler.currentRequest` intact. The stale confirm/input dialog can then send `extension_ui_response` to a closed session and, until the user responds or the timeout fires, it blocks queued dialogs from other live sessions.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/app.js:279-284`

### Avoid passing untrusted paths through `cmd /c start`

On Windows, `/api/open` passes the request-provided `filePath` through `cmd /c start`. Because Tau binds to `0.0.0.0` by default and authentication is optional, a reachable client can supply shell metacharacters in `filePath` and have them interpreted by `cmd`; use a non-shell opener such as `explorer.exe` with an argument array or strictly validate the path before invoking the shell.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/bin/tau.js:816-817`

## Overall assessment

**Verdict:** Needs revision.

**Explanation:** The standalone session model still has a few edge cases where UI state from a live tab leaks into history or closed-session flows. The Windows open-file path also needs hardening before exposing the standalone server on the LAN.

## n+1th round fix summary (9th round)

- Prevented queued prompts from flushing during switches into historical read-only transcripts by clearing live-view state before the history reset path updates UI, and by only flushing queues when a live Tau tab is currently visible.
- Made live-session snapshot selection reject non-OK/error responses, clean up the stale tab state, and surface the backend error instead of enabling input for a dead session id.
- Cleared any open extension UI dialog owned by a just-closed live session, so stale responses are not sent to closed children and other queued dialogs are no longer blocked by the orphaned dialog.
- Hardened `/api/open` by resolving and existence-checking paths and replacing Windows `cmd /c start` with a non-shell `explorer.exe` spawn using an argument array.

Validation: `node --check bin/tau.js && node --check public/app.js && node --check public/dialogs.js`. `npm test -- --help` was attempted, but the package has no `test` script.

---

## n+1th round review (10th round)

_Reviewer: n+1th round reviewer._

## Findings

### Keep file browsing scoped to the active live session

`/api/files` only requires a live `sessionId` when `path` is absent. Any explicit `path` is accepted and passed to `serveFileList()` without checking that it belongs to the selected Tau tab's `cwd`; the frontend also drops `sessionId` after the initial load when navigating into child directories. This violates the plan's session-scoped file browser and lets a reachable client enumerate arbitrary readable server directories via `/api/files?path=...`.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/bin/tau.js:640-647`, `/home/milanglacier/Desktop/personal-projects/tau/public/file-browser.js:56-67`

### Apply the same session/cwd boundary to image previews

`/api/file/preview` serves any readable file with an image extension from a request-supplied absolute path, independent of a live session id or cwd validation. Even if the visible file list is fixed, preview URLs remain a direct arbitrary-local-image read endpoint on the standalone server, which is risky with the default LAN bind and optional auth.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/bin/tau.js:649`, `/home/milanglacier/Desktop/personal-projects/tau/bin/tau.js:802-810`

### Read appended session names when rebuilding the history sidebar

The standalone rename shim persists names by appending a trailing `session_info` record, but `parseSessionFile()` stops after the first 50 lines once it has found a first user message. For any longer session, a rename appended near EOF will not be seen on the next `/api/sessions` scan, so the sidebar title reverts after reload despite the append succeeding.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/bin/tau.js:741-764`

### Make `--open` open URLs, not only filesystem paths

The README documents `tau --open`, but startup calls `openNative(mirrorUrl)`. `openNative()` resolves its argument as a filesystem path and rejects if it does not exist, so `http://localhost:<port>` is never opened and the error is silently swallowed. Use a URL opener path for server URLs, or teach `openNative()` to distinguish URLs from local files.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/bin/tau.js:814-823`, `/home/milanglacier/Desktop/personal-projects/tau/bin/tau.js:942-947`

## Overall assessment

**Verdict:** Needs revision.

**Explanation:** The live-session migration is close, but the file APIs still escape the active-session boundary, and sidebar rename persistence is incomplete for real-world longer histories. The `--open` issue is smaller, but it is a documented standalone CLI flag that currently does nothing.

Validation: `node --check bin/tau.js && node --check public/app.js && node --check public/dialogs.js && node --check public/file-browser.js && node --check public/session-sidebar.js`.

## n+1th round fix summary (10th round)

- Scoped `/api/files` to a validated live Tau session for both root loads and explicit path navigation, including realpath-based checks that keep browsed directories inside the active session `cwd`; the frontend now sends `sessionId` for every file-browser load.
- Applied the same live-session/cwd validation to `/api/file/preview`, and included the originating `sessionId` on file attachment preview URLs so image thumbnails cannot read arbitrary local paths.
- Changed session-history parsing to scan the whole JSONL file for trailing `session_info` records, so sidebar renames appended at EOF persist after reload for longer sessions.
- Fixed `tau --open` by using a URL opener for the printed Tau server URL instead of passing `http://...` through the filesystem-only native file opener.

Validation: `node --check bin/tau.js && node --check public/app.js && node --check public/file-browser.js && node --check public/dialogs.js && node --check public/session-sidebar.js`; smoke-tested `/api/files` and `/api/file/preview` without `sessionId` returning HTTP 400, and `/api/sessions` reading a rename appended after 80+ JSONL lines.

---

## n+1th round review (11th round)

_Reviewer: n+1th round reviewer._

## Findings

### Do not allow cross-origin mutation of Tau APIs

`handleApiRoute()` adds `Access-Control-Allow-Origin: *` and allows `POST`/`DELETE` for every API route, including `/api/live-sessions`, `/api/rpc`, `/api/sessions/delete`, and `/api/open`. The Tau UI is same-origin and does not need wildcard CORS, but with the default unauthenticated `0.0.0.0` server a malicious website visited in the user's browser can pass the JSON preflight and create/close Pi children or delete session files on `localhost:3001`/the LAN server.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/bin/tau.js:636-640`

### Scope native file opens to trusted Tau paths

`/api/open` accepts any existing filesystem path and passes it to the platform opener without requiring a live `sessionId` or checking that the path came from the active session cwd/exported session history. Because Tau is a LAN-bound standalone server with optional auth, any reachable client can trigger the server machine to open arbitrary local files/apps; use the same live-session path validation as `/api/files` for file-browser opens and a narrow exported-session path allowance for HTML exports.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/bin/tau.js:696-698`, `/home/milanglacier/Desktop/personal-projects/tau/bin/tau.js:859-869`

### Refresh controls when the active session closes

When the active streaming Tau tab is closed or its child exits and there is no replacement tab, `handleLiveSessionClosed()` resets `state.isStreaming` but only calls `updateMirrorInputState()`. That disables the input, but it does not hide the previously visible Abort button, clear the typing indicator, or move the status out of `Working...`, leaving stale live-session controls in the no-session welcome state.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/app.js:289-305`

## Overall assessment

**Verdict:** Needs revision.

**Explanation:** The standalone migration is close, but the new server should not expose mutating APIs to arbitrary browser origins or let remote clients open arbitrary local paths. The active-close UI stale state is smaller, but it still violates the planned no-live-session disabled/empty state.

## n+1th round fix summary (11th round)

- Replaced wildcard API CORS with same-origin-only handling: requests without an `Origin` still work, matching same-origin preflights are allowed, and cross-origin preflights/API requests are rejected with 403.
- Scoped `/api/open` to trusted paths by requiring a live `sessionId` for active-session file/directory opens and validating that path against the session cwd; session-export opens without a live session are limited to exported HTML under the Pi sessions directory.
- Updated file-browser native-open calls to include the active live session id, including the right-sidebar “open in file manager” button.
- Cleared stale streaming UI when the active live session closes, and made `updateUI()` show Abort/Working state only while a live Tau tab is actually visible.

Validation: `node --check bin/tau.js && node --check public/app.js && node --check public/file-browser.js && node --check public/session-sidebar.js && git diff --check`; smoke-tested Tau on `127.0.0.1:3999` with cross-origin preflight rejected (403), same-origin preflight accepted (200), and `/api/open` for `/etc/hosts` without a live session rejected (403).

---

## n+1th round review (12th round)

_Reviewer: n+1th round reviewer._

## Findings

### Validate WebSocket origins before upgrade

The HTTP API now rejects cross-origin mutating requests, but the WebSocket upgrade path only checks Basic Auth and then accepts `/ws`. Browsers do not apply CORS to WebSockets, so with the default unauthenticated standalone server a malicious webpage can open `ws://localhost:3001/ws`, read `liveSessions`, and send RPC commands such as `prompt`, `abort`, or `extension_ui_response` to existing Pi children; apply the same same-origin `Origin` check before `handleUpgrade()`.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/bin/tau.js:1006-1012`

### Place the live tab strip below the absolute header

`public/index.html` renders `.live-tabs` immediately after `.header`, but `.header` is `position: absolute` at the top of `.main` with `z-index: 10`. The new `.live-tabs` block participates in normal flow at `top: 0` with no offset or z-index, so the header overlays the in-page Tau tabs and can make the tab strip partially or fully unusable; add top spacing/positioning for the tab strip or make the header part of the layout.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/style.css:3444-3452`

## Overall assessment

**Verdict:** Needs revision.

**Explanation:** The standalone server still leaves its WebSocket control channel open to cross-origin browser pages when auth is disabled. The tab strip also needs layout correction so the planned in-page Tau tabs are actually usable under the existing absolute header.

## n+1th round fix summary (12th round)

- Applied the same same-origin `Origin` validation to WebSocket upgrades before `handleUpgrade()`, so cross-origin browser pages receive `403 Forbidden` instead of a usable `/ws` control channel while same-origin Tau clients still connect.
- Moved the live Tau tab strip below the absolute header with explicit top spacing/z-index, adjusted the message padding now that the tab strip occupies layout space, and added the matching mobile header offset.

Validation: `node --check bin/tau.js && git diff --check`; smoke-tested WebSocket upgrades on `127.0.0.1:3997` with a cross-origin `Origin` returning `HTTP/1.1 403 Forbidden` and a same-origin `Origin` returning `HTTP/1.1 101 Switching Protocols`.

---

## n+1th round review (13th round)

_Reviewer: n+1th round reviewer._

## Findings

### Preserve the current view across WebSocket reconnects

Every standalone `stateUpdate` calls `restoreActiveLiveSession()`, which selects the saved or most-recent live Tau tab. If the browser is currently reading a historical transcript or the launcher when the WebSocket reconnects, that reconnect replaces the user's current view with a live session even though reconnecting should only refresh backend state; limit auto-restore to initial load or to cases where the browser was already viewing a live tab.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/app.js:233-237`

### Report immediate RPC send failures to the client

The RPC shim treats every `prompt`, `abort`, and `extension_ui_response` failure as success, but `session.send()` can reject immediately when the child stdin is closed, the session is terminating, or the write fails. In those cases the prompt/response is never delivered while the UI is told it succeeded; only ack timeouts for known fire-and-forget commands should be converted to success.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/bin/tau.js:607-609`

### Revalidate WebSocket clients after auth is enabled

`set_auth` can turn authentication on at runtime, but already-connected WebSocket clients continue to be accepted by the message handler without any new auth check. A client connected while auth was disabled can keep sending `prompt`, `abort`, or live-session commands after the user enables auth, so enabling auth should close existing unauthenticated sockets or enforce auth before processing each WebSocket command.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/bin/tau.js:1026-1030`

### Move tab-owned dialogs when switching live tabs

`selectLiveSession()` switches `activeLiveSessionId` and renders the new tab without clearing or re-queuing an open `dialogHandler.currentRequest` from the previously active session. If session A has a confirm/input dialog open and the user switches to session B, A's dialog remains over B and blocks B's queued UI requests until it is answered; make dialogs follow their owning tab or return the old request to the pending queue on tab switch.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/app.js:384-417`

## Overall assessment

**Verdict:** Needs revision.

**Explanation:** The standalone migration is close, but reconnects can still disrupt non-live views and some failed RPC writes are reported as successful. Auth toggling and tab-scoped dialogs also need tightening to preserve the intended standalone multi-session boundaries.

## n+1th round fix summary (13th round)

- Preserved historical/launcher views across WebSocket reconnects by only auto-restoring a live Tau tab on initial state load or when the browser was already viewing a live tab.
- Made ack-less RPC success handling apply only to command timeout cases, so immediate closed-stdin/not-running/write failures for prompts, aborts, and extension UI responses are reported as errors.
- Closed existing WebSocket clients shortly after auth is enabled at runtime, forcing them to reconnect through the authenticated upgrade path.
- Stored the active extension UI request on dialogs and re-queued a tab-owned dialog when switching to another Tau tab, so dialogs no longer remain over the wrong session or block the newly selected tab's queued requests.

Validation: `node --check bin/tau.js && node --check public/app.js && node --check public/dialogs.js`.

---

## n+1th round review (14th round)

_Reviewer: n+1th round reviewer._

## Findings

### Sync `liveInstances` in `handleLiveSessionClosed` before sidebar indicator update

When a live session is closed via WebSocket broadcast or another client, `handleLiveSessionClosed()` directly filters `liveSessions` but does not rebuild `liveInstances`. The sidebar live-indicator dots in `updateMirrorLiveIndicator()` read from `liveInstances`, so closed sessions retain their green live dot until the next 10-second polling interval calls `setLiveSessions()` and rebuilds the array. Every other code path that mutates `liveSessions` — `setLiveSessions()`, `upsertLiveSession()` — recomputes `liveInstances` from the current `liveSessions` before calling `updateMirrorLiveIndicator()`, but `handleLiveSessionClosed()` omits this step.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/app.js:295-301` (filter of `liveSessions` without `liveInstances` recompute) and line 327 (call to `updateMirrorLiveIndicator()` that reads stale `liveInstances`).

## Overall assessment

**Verdict:** Needs revision.

**Explanation:** The standalone session lifecycle is functionally complete after 13 rounds, but sidebar live-indicator dots lag by up to 10 seconds after WebSocket or cross-client tab closes. The fix is a one-line `liveInstances` recompute inside `handleLiveSessionClosed()` to match the pattern already used by `setLiveSessions()` and `upsertLiveSession()`.

## n+1th round fix summary

- Rebuilt `liveInstances` from `liveSessions` inside `handleLiveSessionClosed()` before calling `updateMirrorLiveIndicator()`, so sidebar live dots reflect the current backend session list immediately after a WebSocket or cross-client close.

Validation: `node --check public/app.js`.

**Applied:** `public/app.js:329` — inserted `liveInstances = liveSessions.map(s => ({ sessionFile: s.sessionFile, cwd: s.cwd, port: location.port }));` after the `liveSessions` filter and before `renderLiveTabs()` in `handleLiveSessionClosed()`. The diff:

```diff
+  liveInstances = liveSessions.map(s => ({ sessionFile: s.sessionFile, cwd: s.cwd, port: location.port }));
   renderLiveTabs();
   updateMirrorLiveIndicator();
```

---

## n+1th round review (15th round)

_Reviewer: n+1th round reviewer._

## Findings

### Reconcile active streaming state during live-session polling

`pollInstances()` is the fallback for missed WebSocket updates, but it only replaces `liveSessions` and handles disappeared sessions. If the active child starts streaming while the browser misses the `turn_start`/`agent_start` event, polling updates the tab metadata to `isStreaming: true` while `state.isStreaming` and the Abort/send controls remain idle; `sendMessage()` then sends another prompt immediately instead of queueing it for that session. After polling the active session, copy the active metadata's `isStreaming` into UI state and call the same UI refresh path used by live events/snapshots.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/public/app.js:1681-1685`

### Constrain `export_html` output paths

The standalone RPC shim validates the source session file, but passes client-supplied `command.outputPath` directly to `pi --export`. With Tau binding to the LAN by default and auth optional, any reachable client that knows a valid session file can ask the Tau process to write the export to an arbitrary server-side path; either remove `outputPath` from the public shim or restrict it to a safe export directory under the session-history tree.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/bin/tau.js:581-582`

### Do not let snapshot URLs terminate live sessions

The live-session route regex accepts both `/api/live-sessions/:id` and `/api/live-sessions/:id/snapshot`, but the DELETE branch does not exclude the snapshot form. A `DELETE /api/live-sessions/<id>/snapshot` request therefore closes the Pi child even though `/snapshot` is documented as a read-only snapshot endpoint; make DELETE match only the bare live-session resource.

**Location:** `/home/milanglacier/Desktop/personal-projects/tau/bin/tau.js:696-707`

## Overall assessment

**Verdict:** Needs revision.

**Explanation:** The migration remains close, but the polling fallback can leave the active UI accepting prompts while the backend says the child is streaming. The export path and snapshot DELETE issues are smaller API-hardening fixes, but both are discrete regressions in the standalone server surface.

## n+1th round fix summary (15th round)

- Reconciled the active tab's streaming/UI state during `/api/live-sessions` polling, so a missed `turn_start`/`agent_start` WebSocket event still flips the visible controls into the working/abort state and causes subsequent prompts to queue.
- Constrained `export_html` `outputPath` to `.html` files inside the source session file's directory before passing it to `pi --export`, preventing arbitrary server-side export writes through the standalone RPC shim.
- Split live-session DELETE handling from the `/snapshot` subroute, so only `DELETE /api/live-sessions/:id` terminates a child session while `DELETE /api/live-sessions/:id/snapshot` falls through as unsupported.

Validation: `node --check bin/tau.js && node --check public/app.js && git diff --check`.
