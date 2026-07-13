# Goal
Convert Tau from a Pi TUI extension/mirror into a standalone web app that starts and manages its own headless `pi --mode rpc` child sessions. Tau provides an in-page workspace tab UI, like JupyterLab tabs: each Tau tab represents one backend-managed Pi RPC session. Browser tabs/windows are not Pi sessions. Closing/reloading the browser page must not kill Pi sessions; reopening Tau shows the same backend-managed Tau tabs. A Pi session is killed only when the user explicitly closes its in-page Tau tab, or when the Tau backend shuts down.

# Canonical tab/session ownership decision
- “Tab” means an in-page Tau UI tab rendered inside `public/index.html`, not a browser tab/window.
- The Tau web page manages the visual tab strip, like JupyterLab:
  - one browser page can show many Tau tabs.
  - clicking a Tau tab switches the visible chat/session inside the page.
  - clicking `x` on a Tau tab closes that backend Pi session.
- The backend is the source of truth for live Pi sessions.
- The frontend tab strip is a projection of backend live-session records.
- Browser page close/reload/WebSocket disconnect:
  - does **not** terminate Pi child sessions.
  - the Tau backend keeps all `pi --mode rpc` child processes running.
- Browser reopen/reconnect:
  - frontend calls `GET /api/live-sessions` or receives initial WebSocket state.
  - frontend reconstructs the in-page Tau tab strip from backend live sessions.
  - frontend selects the previous active Tau tab from localStorage if it still exists, otherwise selects the most recently active backend session.
- In-page Tau tab close button:
  - explicitly sends `DELETE /api/live-sessions/:id`.
  - backend terminates that Pi child process.
  - all connected browser clients receive `live_session_closed` and remove that Tau tab.
- Multiple browser clients:
  - see the same backend live session list and therefore the same Tau tabs.
  - session creation/closure is global.
  - selected/active Tau tab is per browser client unless later changed; this prevents one device from unexpectedly switching another device’s visible session.
- Tau backend shutdown:
  - default plan: terminate all managed child Pi sessions on SIGINT/SIGTERM/process exit to avoid orphan processes.
  - saved JSONL session history remains on disk and can still be viewed later, but live processes do not survive Tau backend restart in this initial implementation.

# Current-state findings
- `package.json` currently registers Tau as a Pi package extension via `pi.extensions: ["./extensions/mirror-server.ts"]` and has no standalone `bin` entry.
- `extensions/mirror-server.ts` is tightly coupled to Pi Extension API hooks (`pi.on`, `pi.sendUserMessage`, `ctx.sessionManager`, `ctx.modelRegistry`, `ctx.ui`) and starts HTTP/WS from inside the active TUI Pi process.
- The browser already has most chat rendering, session history, files, settings, model/thinking/status, and launcher UI in `public/`.
- `pi --mode rpc` works as newline-delimited JSON over stdio:
  - Browser-style commands such as `{ id, type: "prompt", message }`, `abort`, `compact`, `set_model`, `cycle_model`, `set_thinking_level`, `cycle_thinking_level`, `get_session_stats` are accepted by the child process.
  - Pi emits JSON event lines like `agent_start`, `turn_start`, `message_start/update/end`, `turn_end`, `agent_end`.
  - Some extension-era convenience commands (`get_state`, `get_available_models`) are not reliable native RPC commands, so Tau should emulate them from its own tracked backend session state or use separate CLI probes where needed.

# High-level architecture
1. Add a standalone Tau server executable.
   - Add `bin/tau.js` and expose it via `package.json` `bin: { "tau": "./bin/tau.js" }`.
   - Remove `package.json.pi.extensions` so Tau no longer auto-loads into Pi TUI sessions.
   - Keep serving the existing `public/` assets and existing auth/settings behavior where applicable.
2. Replace Extension API coupling with a backend process-manager layer.
   - Create a `PiRpcSession` abstraction that owns one spawned child process:
     - command: `pi --mode rpc [--model <modelSpec>]`
     - cwd: selected project directory
     - env: inherited env plus `TAU_DISABLED=1` as a guard against recursive/old Tau extension autostart
     - stdio: JSONL stdin/stdout, stderr logged
   - Maintain the canonical live-session registry in the backend: `id`, `pid`, `cwd`, `modelSpec`, best-known model, thinking level, session file, session name, entries/history, `isStreaming`, `createdAt`, `lastActiveAt`, pending command promises.
3. Make the single Tau backend manage many child Pi sessions.
   - Every live Pi child has one backend live-session record.
   - The Tau web page renders one in-page Tau tab for each backend live-session record.
   - Active Tau tab determines which backend session receives prompt/abort/compact/model/thinking commands.
   - Events from inactive sessions update tab metadata/badges only; events from active session render into the chat stream.

# Backend implementation plan

## 1. Standalone server entrypoint
- Add `bin/tau.js` as the production executable.
- Parse minimal flags/env/settings:
  - `--host`, env `TAU_HOST`, settings `tau.host`, default `0.0.0.0`
  - `--port`, env `TAU_MIRROR_PORT`/`TAU_PORT`, settings `tau.port`, default `3001`
  - `--projects-dir`, env `TAU_PROJECTS_DIR`, settings `tau.projectsDir`
  - optional `--open` later, but not required for this change
- Reuse/adapt these existing server helpers from `extensions/mirror-server.ts`:
  - `loadTauSettings`, `findPublicDir`, MIME/static serving, auth helpers
  - `/api/health`, `/api/qr`, `/api/projects`, `/api/sessions`, `/api/search`, `/api/files`, `/api/file/preview`, `/api/open`, `/api/sessions/delete`
- Change `/api/health` to report `mode: "standalone"` and include live-session count.
- Remove all Pi Extension API imports and all `pi.registerCommand`, `pi.on`, `ctx.ui`, `ExtensionContext` usage.

## 2. Backend live-session registry
- Add a singleton `LiveSessionManager` owned by the Tau server process.
- Responsibilities:
  - allocate stable Tau session ids independent of Pi session ids.
  - store `Map<tauSessionId, PiRpcSession>`.
  - expose list/create/get/delete operations.
  - broadcast lifecycle and metadata updates to all WebSocket clients.
  - keep sessions alive regardless of browser connection count.
- Do not tie session lifetime to WebSocket lifecycle.
  - `ws.close`, browser refresh, page close, mobile sleep, and network reconnect only remove the browser client from `clients`.
  - they must not call `PiRpcSession.terminate()`.
- Only these paths terminate a live session:
  - explicit in-page Tau tab close, implemented as `DELETE /api/live-sessions/:id`
  - Tau backend shutdown cleanup
  - child Pi process exits/crashes by itself
  - optional future idle timeout if explicitly configured, but no timeout in initial implementation.

## 3. PiRpcSession process manager
- Implement a class/module with responsibilities:
  - `start({ cwd, modelSpec })`
    - validate cwd exists and is a directory.
    - spawn `pi --mode rpc` in that cwd.
    - if `modelSpec` is non-empty, pass `--model modelSpec` exactly as typed by user.
    - keep stdin open until termination.
  - `send(command)`
    - attach a generated id if absent.
    - write one JSON line to child stdin.
    - return a promise resolved by matching `response.id`; use timeout for request/response commands.
  - `terminate(reason)`
    - send SIGTERM, then SIGKILL after a short grace period if still alive.
    - reject pending promises and broadcast closure.
  - `handleStdoutLine(line)`
    - parse JSON.
    - if `type === "response"`, resolve pending request and update state for response data.
    - otherwise treat as Pi event, append relevant entries, update streaming/name/model/usage state, and emit to Tau clients.
- State tracking rules:
  - `turn_start`/`agent_start` => `isStreaming = true`.
  - `turn_end`/`agent_end` => `isStreaming = false`.
  - `message_start/message_end` with `message` => maintain an `entries` array in the same shape the current frontend history renderer expects: `{ type: "message", message }`.
  - `message_update` => broadcast directly; do not duplicate final persisted messages beyond `message_end`.
  - `thinking_level_changed` or response data from thinking commands => update `thinkingLevel`.
  - `set_model`/`cycle_model` responses and assistant message metadata => update `model`.
  - `get_session_stats` response => cache `sessionFile`, tokens, context usage.
- After spawn, send `get_session_stats` once to learn the session file and session id. This command already works even before the first prompt.

## 4. Server APIs for backend-managed Tau tabs
Add or replace endpoints:
- `GET /api/live-sessions`
  - returns all backend-running child sessions with metadata needed for in-page Tau tabs: `{ id, pid, cwd, modelSpec, model, thinkingLevel, sessionFile, sessionName, isStreaming, createdAt, lastActiveAt }`.
  - this is what restores Tau tabs after browser reopen.
- `GET /api/live-sessions/:id/snapshot`
  - returns `{ session, entries, model, thinkingLevel, isStreaming, sessionFile, sessionName, contextUsage }`.
  - used when selecting/restoring an in-page Tau tab.
- `POST /api/live-sessions`
  - body: `{ cwd, model }` where `model` is the raw `/model`-style string.
  - validates cwd.
  - starts a new backend-owned `PiRpcSession`.
  - returns the new session metadata and broadcasts `live_session_created`.
- `DELETE /api/live-sessions/:id`
  - explicit in-page Tau tab-close semantics.
  - terminates the child Pi process.
  - broadcasts `live_session_closed`.
- Keep `/api/rpc`, but require commands to include a backend session id:
  - body includes `sessionId`.
  - reject mutating commands with a clear error if `sessionId` is absent or not found.
  - emulate extension-era commands when native Pi RPC does not respond:
    - `get_state`: return cached Tau backend state for that `sessionId`.
    - `get_messages`: return cached `entries` for that `sessionId`.
    - `mirror_sync_request`: return a `mirror_sync` snapshot for that managed session.
    - `get_available_models`: either return cached/empty initially, or populate by parsing `pi --list-models`; since model creation is now a textbox, this is non-blocking.
  - proxy native-capable commands to the child: `prompt`, `steer`, `follow_up`, `abort`, `compact`, `set_model`, `cycle_model`, `set_thinking_level`, `cycle_thinking_level`, `get_session_stats`.
  - `export_html`: use the cached/session-stats `sessionFile`, then run `pi --export <sessionFile> [outputPath]` outside the child.

## 5. WebSocket protocol
- Keep `/ws` as the browser connection endpoint.
- WebSocket client connection/disconnection only manages browser clients; it never terminates backend sessions.
- On connection send:
  - `{ type: "state", mode: "standalone", liveSessions: [...] }`
- For Pi child events broadcast:
  - `{ type: "event", sessionId, event: { type: <piEventType>, ...event } }`
- For snapshots:
  - `{ type: "mirror_sync", sessionId, entries, model, thinkingLevel, isStreaming, sessionFile, sessionName, contextUsage }`
- For tab lifecycle:
  - `{ type: "live_session_created", session }`
  - `{ type: "live_session_updated", session }`
  - `{ type: "live_session_closed", sessionId, reason }`
- Maintain the current frontend event format inside `event` so existing render code needs minimal changes.

## 6. Server shutdown cleanup
- On Tau server process exit/SIGINT/SIGTERM, terminate all child Pi sessions.
- On child process exit, remove the session from the live map, reject pending commands, and broadcast tab closure.
- Replace old `tau-instances`/tmux zombie cleanup with this direct child-process registry; no tmux-specific logic is needed for standalone managed sessions.

# Frontend implementation plan

## 1. Add JupyterLab-style in-page Tau tab strip
- Add a Tau workspace tab strip inside the web page, near the top of `.main`, preferably between `.header` and `.messages`, or integrated under the header.
- This is not browser-tab management and does not use browser windows.
- The tab list is rendered from backend `liveSessions` state, not from frontend-only session objects.
- On initial page load:
  - connect WS.
  - fetch or receive `liveSessions`.
  - render all existing backend sessions as in-page Tau tabs.
  - restore `activeLiveSessionId` from localStorage if it still exists; otherwise select the most recently active session; otherwise show no-session welcome state.
- Each Tau tab shows:
  - project directory basename
  - compact model label
  - streaming dot/spinner if active
  - close button
- Clicking a Tau tab:
  - sets local/per-browser `activeLiveSessionId`.
  - stores it in localStorage.
  - clears current render state.
  - requests a backend snapshot for that session via `GET /api/live-sessions/:id/snapshot` or `/api/rpc { type: "mirror_sync_request", sessionId }`.
  - re-enables input.
- Closing a Tau tab:
  - confirm only if the session is streaming or has unsent queued messages.
  - call `DELETE /api/live-sessions/:id`.
  - backend kills the Pi child process globally.
  - all browser clients remove that Tau tab from the broadcast.
- Browser page close/reload:
  - no DELETE request is sent.
  - `beforeunload` should not terminate sessions.

## 2. Change `+` button behavior
- Replace current `newSessionBtn` behavior, which only clears the mirror view, with an in-page modal/dialog.
- The modal is part of the Tau web page, not a browser popup window.
- Modal fields:
  - Project directory selector/input:
    - show existing `/api/projects` bubbles if `tau.projectsDir` is configured.
    - include a manual path textbox for arbitrary server-side paths.
  - Model textbox:
    - placeholder: `openai/gpt-5.5:high`
    - help text: “Uses the same syntax as Pi `/model`; applies only to this session.”
    - allow blank to use Pi default model.
- Submit action:
  - `POST /api/live-sessions { cwd, model }`.
  - on success, backend broadcasts the new session; the creating browser selects it and requests initial snapshot.
- Reuse the app’s existing glass/modal styling.

## 3. Route all commands to active backend session
- Add `activeLiveSessionId` in `public/app.js` as per-browser view state.
- Update `wsClient.send(...)` and `rpcCommand(...)` call sites so commands include `sessionId: activeLiveSessionId`.
- Disable send/abort/compact/model/thinking controls if no live backend session is active.
- Keep historical session browsing in the sidebar read-only; selecting old sessions should not switch or create live child processes unless a future explicit “resume live” action is added.

## 4. Adapt WebSocket event handling
- In `websocket-client.js`, pass through `sessionId` on `rpcEvent`, `mirrorSync`, lifecycle events.
- In `app.js`:
  - render chat events only when `sessionId === activeLiveSessionId`.
  - update the relevant Tau tab metadata for inactive session events.
  - when active session receives `mirror_sync`, call existing `handleMirrorSync` with session-aware state.
  - process `live_session_created`, `live_session_updated`, and `live_session_closed` to keep the Tau tab strip synchronized with backend state.
- Replace `isMirrorMode` naming with `isStandaloneMode` or make the old variable mean “live RPC session mode” to minimize churn.

## 5. Model UI changes
- Session creation model selection is the primary model control.
- Header model label should display the active backend session’s current model/modelSpec.
- Existing model dropdown can be simplified for this migration:
  - either disable opening and show “set at session start”, or
  - keep `cycle_model`/`set_model` only for the active child if reliable.
- Thinking-level button remains session-scoped by sending RPC to active backend session.
- Ensure no model choice is persisted to global Pi settings.

## 6. File browser changes
- `/api/files` should accept `sessionId` and default to that live session’s cwd instead of Tau server cwd.
- Frontend `FileBrowser.load()` should include the active session id when available.
- If no active live session, keep manual browsing disabled or default to server cwd with a clear empty-state.

## 7. Sidebar historical sessions
- Keep current `/api/sessions` scanning for saved Pi session files.
- Remove “switch live instance by port” behavior; there is now one Tau backend and many backend-owned child sessions.
- Live indicators should be based on `GET /api/live-sessions` session files rather than old `/api/instances` ports.
- Selecting a historical session should render it read-only; selecting a live session’s saved file can offer a “Jump to live Tau tab” affordance if that session is currently running.

# Files expected to change
- `package.json`
  - remove `pi.extensions` registration.
  - add `bin` entry.
  - update description/keywords from mirror extension to standalone Pi web app.
- New `bin/tau.js`
  - standalone HTTP/WS server and backend live-session manager, or entrypoint importing server modules.
- Possibly new server modules for maintainability:
  - `server/settings.js`
  - `server/static.js`
  - `server/pi-rpc-session.js`
  - `server/live-session-manager.js`
  - `server/session-history.js`
- `extensions/mirror-server.ts`
  - either remove from package flow or reduce to a deprecation/no-op shim; do not start a server from Pi hooks.
- `public/index.html`
  - add in-page Tau tab strip and new-session modal markup.
- `public/app.js`
  - backend live-session tab state, session creation modal, session-aware RPC/WS routing, remove old mirror-port switching.
- `public/websocket-client.js`
  - pass lifecycle/session-scoped events through.
- `public/file-browser.js`
  - include active session id in requests.
- `public/session-sidebar.js`
  - remove old tmux/instances assumptions where needed; keep history list.
- `public/style.css`
  - JupyterLab-style in-page tab strip and modal styles matching current Tau design.
- `README.md` / install docs
  - update usage from “Pi mirror extension” to “run `tau` standalone”.

# Compatibility and migration notes
- During development, run local setup per repo instructions (`npm link`) if testing as the installed command.
- Because `extensions/mirror-server.ts` changes/removal affects Pi’s jiti cache only if still loaded; after this migration users should restart any existing Pi/Tau process and launch `tau` standalone.
- To avoid recursive Tau servers from older installs/settings, spawned child Pi processes should include `TAU_DISABLED=1` in their environment.
- Existing session history files under `~/.pi/agent/sessions` remain compatible because Tau still reads Pi JSONL session files.
- Browser refresh/close/reopen must be treated as a UI lifecycle event only; it is not a backend session lifecycle event.
- “Tab” in docs/UI should consistently mean an in-page Tau tab, not a browser tab.

# Test plan
1. Backend-owned lifecycle tests
   - Start Tau server, create two live sessions through API.
   - Disconnect all WebSocket/browser clients; verify both child PIDs remain alive.
   - Reconnect/open browser; verify `GET /api/live-sessions` restores both in-page Tau tabs.
   - Close one Tau tab; verify only that child PID exits and all clients receive `live_session_closed`.
   - Refresh browser while a session streams; verify the child remains alive and snapshot can be reloaded.
2. In-page tab UX tests
   - Open one browser page and create multiple Tau tabs inside the page.
   - Switch Tau tabs without opening/closing browser tabs/windows.
   - Confirm each Tau tab restores its own history and current streaming state.
   - Confirm the `+` button opens an in-page modal and creates a new Tau tab after submit.
   - Confirm closing the browser page does not close any Tau tab/session in the backend.
3. Backend RPC process tests
   - Start a `PiRpcSession` in a temp directory with model blank; verify `get_session_stats` returns a session file.
   - Send `prompt`; verify Pi events are parsed, `entries` are populated, and `isStreaming` returns false after `turn_end/agent_end`.
   - Send `abort` during a long prompt; verify command response and UI state.
   - Send `compact` on an empty and non-empty session; verify response handling.
   - Start with `--model openai/gpt-5.5:high`; verify no global settings file is modified.
4. Multi-session tests
   - Create two live sessions with different cwd/model strings.
   - Send prompts to each; verify events and histories do not cross sessions.
   - Close one Tau tab/session; verify the child PID exits and the other stays usable.
   - Terminate Tau server; verify all child Pi processes are terminated.
5. Frontend manual/browser tests
   - Launch `tau`, open browser, click `+`, choose/type project dir and model, create an in-page Tau tab.
   - Confirm the prompt UI renders the same as current Tau for user, assistant, tool cards, markdown, and usage.
   - Create a second Tau tab and switch back/forth; verify snapshots restore correctly.
   - Reload and close/reopen the webpage; verify backend sessions/Tau tabs are still visible and usable.
   - Close Tau tabs and confirm input disabled/empty state when no live session exists.
   - Browse historical sessions from sidebar; verify read-only behavior.
   - File sidebar lists files from active session cwd.
6. Regression tests
   - Static assets load from npm-installed package and local dev checkout.
   - Auth settings still gate HTTP/WS if configured.
   - QR page and health endpoint still work.
   - Mobile layout still works with in-page tab strip and modal.

# Implementation order
1. Add standalone `bin/tau.js` server skeleton serving existing public assets and health endpoint.
2. Add backend `LiveSessionManager` and `PiRpcSession` manager.
3. Add backend-owned live-session REST endpoints and ensure sessions survive browser disconnect/reconnect.
4. Bridge Pi child events to existing WebSocket event format for one active session.
5. Add in-page JupyterLab-style Tau tab strip to the frontend, reconstructed from backend sessions.
6. Update frontend command routing with `sessionId`.
7. Add explicit close-Tau-tab-to-terminate semantics.
8. Replace `+` behavior with in-page project/model modal.
9. Adapt files/sidebar/history/live indicators.
10. Remove/deprecate Pi extension registration and update docs.
11. Run the test plan and fix compatibility issues.
