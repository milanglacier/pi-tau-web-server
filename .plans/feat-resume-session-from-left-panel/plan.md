Goal: implement “resume from old session” so selecting a historical session in the left sidebar opens/selects an editable Tau tab backed by a new `pi --mode rpc --session <file>` child, while selecting the same session again focuses the existing tab instead of creating a duplicate.

Answer on semantics: yes — the proposed semantics are clear and fit the existing Tau model. A Tau tab already represents one active backend Pi session, so “old session click => live tab for that session; duplicate click => focus existing tab” is a clean invariant. Implementation is moderate, not hard, because the server already manages live sessions and the client already checks `liveSessions` by `sessionFile`; the main missing pieces are spawning Pi with `--session`, adding an idempotent resume API, and changing sidebar selection from read-only history loading to resume-or-focus.

Key findings from local inspection:
- `src/public/app-main.ts` currently handles sidebar selection with `handleSessionSelect()` -> `switchSession()`. In standalone mode it renders historical JSONL read-only, then only selects a live tab if `liveSessions.find(s => s.sessionFile === sessionFile)` already exists.
- `src/server/sessions.ts` owns `PiRpcSession` and `LiveSessionManager.create()`. `PiRpcSession.start()` currently spawns `pi --mode rpc` and optionally `--model`, but has no resume/session-file option.
- `src/server/server-main.ts` already has safe session-file validation through `resolveSessionFile()`, session listing/parsing, and `/api/live-sessions` create/list/delete/snapshot routes.
- `pi --help` confirms the CLI supports `--session <path|id>` for using a specific session file and `--fork` for a fork. This feature should use `--session`, not `--fork`, because the requested behavior is resume, not branch.

Implementation plan:

1. Add backend support for a resumed live session.
   - In `src/server/sessions.ts`, extend `PiRpcSession` constructor options with an optional `sessionFile` and optional initial `entries`/`sessionName`.
   - Store a normalized/resolved session file on `this.sessionFile` before startup when provided.
   - In `PiRpcSession.start()`, append `--session <sessionFile>` to the spawned `pi` args when `this.sessionFile` is set, preserving existing `--mode rpc` and `--model` behavior.
   - Keep normal new-session behavior unchanged when no session file is provided.

2. Add server-side resume/idempotency API.
   - Prefer a dedicated route: `POST /api/live-sessions/resume` with body `{ filePath: string, cwd?: string, model?: string }`.
   - In `src/server/server-main.ts`, validate `filePath` with existing `resolveSessionFile()` so only JSONL files under `SESSIONS_DIR` can be resumed.
   - Before creating anything, check `liveManager.sessions` for a session whose `sessionFile` resolves to the same file. If found, return `{ session: existing.metadata(), reused: true }`.
   - Determine the cwd from, in order: validated `body.cwd` if usable, the session header cwd from existing `readSessionHeaderCwd()`, or the sidebar project path passed by the client. If no usable existing directory is available, return a clear 400 like “Cannot resume session because its project directory no longer exists”.
   - Create a new live session with `pi --mode rpc --session <resolvedFile>` via a new `LiveSessionManager.resume({ sessionFile, cwd, model })` method or by extending `create()` with optional `sessionFile`. A named `resume()` method is clearer.
   - Seed the session metadata with `sessionFile` immediately so broadcasts and duplicate checks work before Pi reports stats.

3. Preserve historical messages in the new live tab snapshot.
   - Add a small server helper to read JSONL entries from the resolved session file, reusing the parsing style from `serveSessionFile()`.
   - When creating a resumed session, initialize `PiRpcSession.entries` with the historical entries so `/api/live-sessions/:id/snapshot` immediately renders the old thread after `selectLiveSession()` clears the temporary loading/history view.
   - Also initialize `sessionName` from the latest `session_info.name` if available.
   - Watch for duplicate replay risk: if manual testing shows Pi RPC emits prior messages on startup, add prefix/JSON structural dedupe in `trackMessage()` or avoid seeding after confirming Pi provides history. Initial assumption: Pi does not replay history in RPC startup, so server seeding is needed.

4. Change client sidebar selection semantics.
   - In `src/public/app-main.ts`, replace the standalone-mode historical read-only branch in `switchSession()` for non-null `sessionFile` with resume-or-focus behavior.
   - First check `liveSessions.find(s => same sessionFile)`; if found, `await selectLiveSession(live.id)` and return.
   - If no live tab exists, show a transient “Resuming session…” system message and call `POST /api/live-sessions/resume` with `{ filePath: sessionFile, cwd: project?.path || session.cwd || '' }`.
   - On success, `upsertLiveSession(data.session)` and `await selectLiveSession(data.session.id)`.
   - On failure, render a clear error and leave the input disabled/read-only rather than silently showing a stale read-only transcript.
   - Keep mobile sidebar close behavior and active sidebar highlighting unchanged.
   - Remove or bypass the old “historical sessions are read-only” UX for standalone session clicks. `newSession()`/launcher/manual new-tab creation should continue to create blank sessions.

5. Normalize path matching on the client as much as possible.
   - Existing client compares raw `sessionFile` strings. Server returns absolute resolved paths, and session listing also appears to use absolute paths. Keep the simple comparison client-side.
   - Enforce true duplicate prevention on the server with `path.resolve()` comparison, so even if clients race or path formatting differs, only one live session is created for a given historical file.

6. Update tests.
   - `test/live-session-manager.test.ts`:
     - Add a test that resumed session creation passes `--session <file>` to the fake spawn args, sets `session.sessionFile`, seeds entries/name, stores the session, and broadcasts `live_session_created`.
     - Add a duplicate/idempotency test if implemented at manager level.
   - `test/http-routes.test.ts`:
     - Add `POST /api/live-sessions/resume` missing `filePath` => 400.
     - Add invalid/outside session path => 400.
     - Add valid session file with header cwd => 200, creates a live session with matching `sessionFile`.
     - Add second resume of same file => 200 with `reused: true` and no additional session in `liveManager.sessions`.
     - Add missing/nonexistent cwd in header => 400 with clear error.
   - `test/pi-rpc-session.test.ts`:
     - Add a lower-level spawn-args test for `PiRpcSession.start()` with a resume file if not already covered via manager.
     - Add snapshot/metadata coverage for pre-set `sessionFile`/seeded entries.

7. Validation commands.
   - Run `npm run typecheck`.
   - Run `npm test`.
   - Manual smoke test:
     1. Start `npm run build && node bin/tau.js` (or local tau entrypoint).
     2. Click an old session in the left sidebar.
     3. Confirm a new tab appears, the old transcript is visible, and the input is enabled.
     4. Send a follow-up message and verify it appends to the resumed session.
     5. Click the same sidebar session again and confirm focus switches to the same tab without increasing tab count.
     6. Close the tab and click the old session again; confirm a new live Pi process/tab is created for that same session file.
