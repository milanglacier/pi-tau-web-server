# Goal
Refactor Tau’s outdated “mirror” and “standalone mode” vocabulary so the code describes the current architecture: a Tau web server that owns a pool of live Pi RPC subprocess sessions and sends live-session snapshots to browser clients. Eliminate the misleading `isStandaloneMode` concept because there is no non-standalone runtime mode in the current app.

## Naming decisions

Use these concepts consistently:

| Old name | New name | Reason |
| --- | --- | --- |
| `mirror_sync_request` | `live_session_snapshot_request` | The payload is a full snapshot of a server-owned live Pi RPC session, not a mirror sync from a TUI. |
| `mirror_sync` | `live_session_snapshot` | Same protocol concept as above. |
| `mirrorSync` browser custom event | `liveSessionSnapshot` | DOM event should match the protocol concept. |
| `MirrorSyncData` | `LiveSessionSnapshotData` | Type describes hydrated live-session state. |
| `handleMirrorSync` | `applyLiveSessionSnapshot` | The client applies a snapshot into UI state. |
| `mirrorActiveSessionFile` | `activeLiveSessionFile` | This is the JSONL file for the selected live session. |
| `updateMirrorLiveIndicator` | `updateLiveSessionIndicators` | Sidebar dots mark sessions with live backend tabs. |
| `updateMirrorInputState` | `updateLiveSessionInputState` | Input availability depends on whether a live session tab is selected. |
| CSS `.mirror-live` | `.has-live-session` | Historical session row has a live backend session. |
| CSS `.mirror-readonly` | `.no-active-live-session` | Input is disabled because no live backend tab is selected. |
| Server `mirrorUrl` | `lanUrl` | The value is the LAN URL printed/opened/QR-encoded for the Tau server. |
| `TAU_MIRROR_PORT` | remove | Use `TAU_PORT`; mirror-specific env alias is stale. |
| `tau-mirror` package fallback | `pi-tau-web-server` | Current package name. |
| `isStandaloneMode` | remove; use `hasReceivedInitialServerState` only where a loading/handshake flag is needed | “Standalone” is not a mode. The remaining boolean should mean exactly what it guards: whether the browser has received initial server state yet. |

`standalone` remains valid only as plain English for the product being a standalone web server, or as the PWA manifest `display: "standalone"`. Do not use “standalone mode” as an internal branch or protocol mode.

## Implementation plan

### 1. Replace protocol snapshot terminology

Files:
- `src/server/server-main.ts`
- `src/public/websocket-client.ts`
- `src/public/app-main.ts`
- `test/rpc-command.test.ts`

Steps:
1. In `handleRpcCommand`, rename the command handler from `mirror_sync_request` to `live_session_snapshot_request` and return `{ type: 'live_session_snapshot', ...session.snapshot() }`.
2. Update `WebSocketClient.handleMessage` so it dispatches `liveSessionSnapshot` for `message.type === 'live_session_snapshot'`.
3. Update `app-main.ts` listener from `mirrorSync` to `liveSessionSnapshot`.
4. Rename `MirrorSyncData` to `LiveSessionSnapshotData` and `handleMirrorSync` to `applyLiveSessionSnapshot`.
5. Update the live-session selection path that currently calls `handleMirrorSync({ ...data, sessionId: id })` to call `applyLiveSessionSnapshot`.
6. Update `test/rpc-command.test.ts` to assert the new command and response type.
7. Do not keep a mirror-named compatibility alias unless explicitly required later; keeping the alias would preserve the outdated term in the codebase.

### 2. Remove the fake “standalone mode” branch from the browser client

Files:
- `src/public/app-main.ts`
- `src/public/websocket-client.ts` only if tests reveal assumptions about `mode`
- `test/websocket.test.ts`
- `test/auth-websocket.test.ts`

Steps:
1. Replace `let isStandaloneMode = false` with `let hasReceivedInitialServerState = false`.
2. In the WebSocket `stateUpdate` handler, stop checking `detail.mode === 'standalone'`. Treat any `state` message from this server as the initial live-session state, set `hasReceivedInitialServerState = true`, and process `liveSessions`.
3. In `applyLiveSessionSnapshot`, set `hasReceivedInitialServerState = true` because a snapshot also proves the server contract is available.
4. In `updateLiveSessionInputState`, use `hasReceivedInitialServerState ? 'Create or select a Tau tab to chat' : 'Connecting...'` for the placeholder.
5. Remove conditional calls like `if (isStandaloneMode) updateMirrorLiveIndicator()` and just call `updateLiveSessionIndicators()` where needed; the function is safe with empty state.
6. In `switchSession`, remove the old non-standalone fallback branch. A selected historical session should always resume through `/api/live-sessions/resume` when `sessionFile` exists. There is no current client path that should POST `/api/sessions/switch`.
7. Update websocket tests that currently describe/expect an “initial standalone state” so they describe/expect an “initial live-session state”.

### 3. Remove the obsolete `/api/sessions/switch` compatibility route

Files:
- `src/server/server-main.ts`
- `test/http-routes.test.ts`

Steps:
1. Delete the `/api/sessions/switch` route returning `{ standalone: true }` because the browser no longer needs a non-live-session switch API.
2. Remove or replace the test `POST /api/sessions/switch returns success in standalone mode`. If coverage is still desired, assert the route is no longer part of the supported API and returns 404.
3. Ensure historical sessions are covered through the existing `/api/live-sessions/resume` tests or add a focused test if resume behavior is not already covered.

### 4. Rename server URL variables and health fields

Files:
- `src/server/server-main.ts`
- `test/http-routes.test.ts`
- `README.md` if it documents health payloads later

Steps:
1. Rename `mirrorUrl` to `lanUrl` throughout `server-main.ts`.
2. Update `/api/health` to return `lanUrl` instead of `mirrorUrl`.
3. Consider removing `mode: 'standalone'` from `/api/health` because it is not a true mode. If a descriptive field is useful, use something like `role: 'rpc-session-manager'`; otherwise omit it.
4. Update QR page generation, startup logging, and `--open` behavior to use `lanUrl`.
5. Update tests and comments that refer to `mirrorUrl` or health “standalone mode”.

### 5. Rename CSS classes and related comments

Files:
- `src/public/app-main.ts`
- `src/public/model-picker.ts`
- `public/style.css`

Steps:
1. Replace `mirror-live` with `has-live-session` in `app-main.ts` and `public/style.css`.
2. Replace `mirror-readonly` with `no-active-live-session` in `app-main.ts` and `public/style.css`.
3. Update style comments from “Mirror mode” to “Live session”.
4. Update `src/public/model-picker.ts` comment so it references `updateLiveSessionInputState`.

### 6. Remove mirror-specific configuration names

Files:
- `src/server/config.ts`
- `README.md`
- tests if any environment setup references the old name

Steps:
1. Remove `process.env.TAU_MIRROR_PORT` from port resolution; keep `--port`, `TAU_PORT`, and `settings.tau.port`.
2. Replace `require.resolve('tau-mirror/package.json')` and `node_modules/tau-mirror/public` fallback with `pi-tau-web-server` equivalents.
3. Remove `TAU_MIRROR_PORT` from README CLI/environment tables.
4. Do not keep a migration note in README for the removed `TAU_MIRROR_PORT` alias; the goal is to eliminate the stale term from current docs.

### 7. Remove the deprecated extension files

Files:
- `extensions/`
- `tsconfig.extensions.json`
- `package.json`
- `README.md`

Steps:
1. Delete the deprecated Pi extension entrypoint instead of keeping a compatibility shim.
2. Remove the `extensions` package file entry and remove `tsconfig.extensions.json` from package metadata and build/typecheck scripts.
3. Delete `tsconfig.extensions.json` once there are no extension sources to compile.
4. Remove README references to deprecated extension files and remove the project-structure `extensions/` entry.

### 8. Update documentation wording

Files:
- `README.md`
- possibly `package.json` only if keywords/descriptions need adjustment

Steps:
1. Remove mirror terminology from current-behavior documentation.
2. In the historical comparison table, rephrase without “mirror”: e.g. “browser displayed a single running TUI session” and “close the TUI and the browser view died”.
3. Keep “standalone web server” wording where it describes deployment, but avoid “standalone mode”.
4. Keep `public/manifest.json` `display: "standalone"`; that is a PWA standard term and unrelated to this refactor.

### 9. Rebuild and validate

Commands:
1. `npm run build`
2. `npm run typecheck`
3. `npm test`
4. `rg -n "mirror|Mirror|MIRROR|mirrorSync|isStandaloneMode|standalone mode|TAU_MIRROR|tau-mirror" src test public README.md package.json`

Expected validation result:
- No mirror terms remain in source/tests/docs.
- No `isStandaloneMode` remains.
- No internal branch depends on a nonexistent alternate “standalone mode”.
- Browser state and tests refer to live sessions, snapshots, and initial server state.
- Generated JS in `public/` and `bin/` is refreshed by the build but remains untracked if `.gitignore` excludes it.

## Risk notes

- Renaming WebSocket/RPC message types is a protocol-breaking change for any old browser bundle or external caller using `mirror_sync_request`. Since the current goal is to remove the stale concept, the plan intentionally does not preserve the old names.
- Removing `TAU_MIRROR_PORT` is a config-breaking change for users still relying on the old environment variable.
- Removing the deprecated extension entrypoint may affect users with an old Pi extension reference. This is acceptable because the repo no longer supports extension-mode startup.

---

## Review — 2026-06-24

### Findings

1. **Remove deleted extension entries from README**

   **Body:** This branch deletes `extensions/` and `tsconfig.extensions.json` and removes the extensions build from `package.json`, but the README still lists `tsconfig.extensions.json` as a valid config and still shows `extensions/` in the project structure. A developer following the README guidance around `tsc -p <config>` will hit a missing config file and will be directed to a directory that no longer exists.

   **Location:** `/home/milanglacier/Desktop/personal-projects/tau/README.md:199` (also `/home/milanglacier/Desktop/personal-projects/tau/README.md:231`)

2. **Remove the remaining mirror wording from the README**

   **Body:** The refactor removes the internal mirror vocabulary and the plan’s validation expects no `mirror` terms in source, tests, docs, or package metadata, but the README comparison table still uses “mirrors”, “mirror”, and “mirror died”. That leaves the retired term in user-facing docs and makes the requested validation command fail even though the code identifiers were renamed.

   **Location:** `/home/milanglacier/Desktop/personal-projects/tau/README.md:16-18`

### Overall assessment

- **Verdict:** Needs revision.
- **Explanation:** The runtime changes build, typecheck, and pass the test suite, but the documentation is left inconsistent with the deleted extension files and with the stated mirror-term cleanup goal.
