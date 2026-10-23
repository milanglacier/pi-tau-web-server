## Findings

### [P2] Synchronize sidebar selection when a live tab becomes active

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/session-sidebar.ts:268-270`

The exemption uses `activeSessionFile`, but the app only calls `setActive` from `handleSessionSelect`; live-tab selection and restoration never update it. With 13 sessions, selecting the oldest live tab therefore still shows only the 10 newest sessions, hiding the session being viewed or retaining a different old session. Update sidebar selection when the actual live tab changes, including restoration, and test that application path rather than calling `setActive` directly on a separate sidebar.

### [P2] Preserve message matches when rebuilding after deletion

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/session-sidebar.ts:431-434`

After a full-text search finishes, deleting a visible project session now calls `render()`. That clears the container without rebuilding the stored full-text results or scheduling another search, so every unrelated “Message matches” result disappears until the query changes. In a browser reproduction, deleting one of 13 matching sessions left 12 project rows but no message matches. Rebuild the remaining full-text results after deletion, and cover deletion after the full-text results arrive.

## Overall assessment

**Verdict:** Patch is incorrect.

**Explanation:** The plan and core limiting logic make sense, but the application integration has the two user-visible defects above. `npm run typecheck`, all 278 tests from `npm test`, and all 79 end-to-end tests passed. The new tests miss real live-tab switching, deletion during full-text search, and the planned project-tab creation check.

## Fix summaries

### Keep sidebar selection in sync with live tabs

Live-tab selection, page restoration, live metadata updates, and snapshots set the sidebar's active session file. Closing the active tab clears its selection before selecting another tab, and closing the final tab removes the extra older session row. The browser regression test uses the app's real tabs and covers selection, reload, switching to a recent session, and closing tabs.

### Keep full-text results when deleting a session

Sidebar rebuilds restore the stored message matches while a search is active. Deleting a session removes it from both the project list and the stored search results, and an empty result list removes the message-matches section. The browser regression test waits for full-text results, deletes one matching session, and checks that the remaining match and count stay visible; deleting the final match removes the section.

### Additional test coverage

The project `+` browser test submits the popup and checks that the server creates an active tab in the selected project's directory. Pi is replaced only at its process boundary; the browser, server, session files, and HTTP/WebSocket paths are real.

### Validation

Both regression tests failed before their respective fixes and passed afterward. All validation passed:

- `npm run typecheck`.
- `npm test`: 278 tests passed.
- `npm run test:e2e`: 80 tests passed, with none skipped.
- `git diff --check`.
