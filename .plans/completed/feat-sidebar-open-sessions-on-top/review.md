## Findings

### [P1] Set live-tab titles without interpolating them into HTML

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/session-sidebar.ts:545-548`

The new tab-built rows pass `tab.name` into `buildSessionItem()`, which interpolates it into a quoted `title` attribute using an escaping helper that leaves double quotes intact. A first prompt such as `Example" onmouseover="alert(1)` becomes an automatic tab name and installs an executable mouseover handler in the sidebar, without requiring a refresh or a saved session row. Browser verification confirmed handler execution. Set the title through DOM properties and `textContent`, or escape attribute quotes, before rendering these live-tab names.

### [P2] Track the active tab when its session has no file path

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/session-sidebar.ts:515-516`

While Pi has not reported a session file, the new row has a `liveSessionId` but no `filePath`. Selecting that tab calls `sidebar.setActive(null)`, and both this condition and `setActive()` require a nonempty file path, so the viewed row never receives its active highlight. With several new tabs, the sidebar cannot indicate which one is selected; the active-row scrolling also cannot find it. Track the active live-session ID alongside the file path and use it to mark these rows.

### [P2] Keep project keys stable when the first saved session appears

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/session-sidebar.ts:306-307`

A project created from a live tab has no `dirName`, so collapsing it stores `path:<cwd>`. Once its conversation appears in `/api/sessions`, a manual refresh or another tab closing replaces that entry with a project containing `dirName`; this method then returns a different key and the collapsed project unexpectedly expands. Browser verification reproduced the lost collapse state. Use a stable project-path key for both kinds of entry, or transfer the stored state when the project gains its saved-session entry.

## Overall assessment

**Verdict:** Patch is incorrect.

**Explanation:** Type checking, all 319 tests, and all 92 end-to-end tests pass. However, the new live-tab rows expose script injection through tab names and have active-row and project-collapse state bugs.

## Fix summaries

### Finding 1 — Fixed

Session titles and their tooltips are assigned through DOM properties instead of being inserted into HTML. This applies to live-tab rows, saved sessions, favourites, and search results. Browser tests confirm that a title containing quotes and a mouseover handler stays plain text and cannot execute, including after a reload.

### Finding 2 — Fixed

The sidebar tracks the selected live-session ID as well as its file path. A session with no file path receives its active highlight when selected, keeps it through reloads and row rebuilds, and loses it when another tab is selected or it closes. Selection changes also scroll the active row into view without scrolling to rows hidden by a collapsed project or a search. Browser tests cover switching between two sessions with no file paths, selecting a saved session, searching, reloading, and closing tabs.

### Finding 3 — Accepted without a change

The project-collapse behavior is left unchanged by agreement. A project can expand on a later sidebar refresh after its first saved conversation appears. This is an uncommon case, and revealing the saved conversation is an acceptable result rather than a blocker.

### Verification

- `npm run typecheck` passed.
- `npm test` passed all 319 tests.
- `npm run test:e2e` passed all 95 tests in about 33 seconds.

The findings and overall assessment above are preserved as the original review. Findings 1 and 2 are fixed, and finding 3 is accepted.

# Second-round review

## Findings

No findings.

## Overall assessment

**Verdict:** Patch is correct.

**Explanation:** Review against the merge base with `main`, including an independent review, found no further actionable bugs. The title-injection and active-highlight findings are fixed; the project-collapse behavior remains accepted. Type checking, all 319 tests, and all 95 end-to-end tests passed, with the end-to-end suite taking about 33 seconds.
