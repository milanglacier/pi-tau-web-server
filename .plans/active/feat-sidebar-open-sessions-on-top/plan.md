# Plan: list every open session at the top of its project, and projects with open sessions at the top of the sidebar

Branch: `feat/sidebar-open-sessions-on-top`

## Goal

Every session that is open as a live tab is easy to find in the left sidebar,
and every one of them shows a green dot. Today only some of them do.

## Current state and problems

- Each project lists its sessions newest first (by file time) and cuts the
  list at 10 (`src/public/session-limit.ts`). Only the session being viewed
  is added back as an extra row when it is older than the 10 newest. Any
  other open tab older than the 10 newest stays hidden. With several old
  sessions open, only one shows up, which is confusing.
- Open sessions are not moved anywhere. An open session sits at its normal
  place by file time, and a project with open sessions sits at its normal
  place among the projects.
- The green dot is added by `updateLiveSessionIndicators()` in
  `src/public/app-main.ts`. It only marks rows that are already on screen, so
  a hidden open session gets no dot at all.
- The sidebar fetches `/api/sessions` only on page load and when the refresh
  button is pressed. A tab opened after that, or a brand new tab whose file
  Pi has not written yet, is not in the sidebar list.
- Rows also carry a `live` text tag that the server sets when the list is
  fetched. It duplicates the green dot and goes stale, because the list is
  not fetched again when tabs open or close.

## Decisions

- Open sessions are pinned inside their own project. There is no separate
  "Open" section. The Favourites group stays where it is and keeps working as
  today: a favourite open session appears there and in its project, both with
  a green dot.
- Projects that have at least one open session move to the top of the
  project list. Among them, the project whose most recently opened tab was
  opened last comes first. Projects without open sessions keep the current
  order (newest session file first) below them.
- Inside a project, open sessions come first, the most recently opened tab
  first. Then come the remaining sessions, newest file first.
- "Opened" means the time the tab was created (`createdAt` of the live
  session). The order changes only when a tab is opened or closed, not while
  the user chats, so rows do not jump under the cursor during normal work.
  Resuming an old session from the sidebar creates a new tab, so it counts as
  just opened.
- The 10-session limit applies only to the sessions that are not open. A
  project shows all of its open sessions, then the 10 newest of the rest.
  "Show all N" and "Show fewer" keep working on the rest. The count badge
  keeps showing the total number of sessions.
- Every open session row has a green dot. The row being viewed also keeps its
  `.active` highlight.
- The server `live` text tag on rows is removed. The green dot is the one
  sign that a session is open.
- While searching, the same order is used and the limit is lifted, as today.
- The project collapse state and the "Show all" state are kept when the order
  changes.

### Side effect to accept

Clicking an old session row opens it as a tab. The row then moves to the top
of its project, and the project moves to the top of the sidebar. This is the
intended result, but it means the row the user just clicked moves. The
sidebar should scroll the newly active row into view if it moved out of
sight.

## Open tabs that are not in the sidebar list yet

The sidebar's list of sessions comes from the files on disk, read once when
the page loads (or when refresh is pressed). The live tabs come from a
different source: the server tells the browser about each tab as it opens,
changes and closes. Two kinds of open tab are in the second source but not in
the first:

1. A tab opened after the page loaded, from the tab bar `+` or a project `+`.
   The sidebar never read its file.
2. A brand new tab where nothing has been sent yet. Pi writes the session
   file only after the conversation starts, so there is no file to read even
   after a refresh.

Without extra work, these tabs have no row in the sidebar at all, even after
this change. Two ways to handle them (the user chose the first):

- **Build their rows from the tab info (recommended).** The browser already
  knows each tab's session file path, directory, name and creation time. If a
  tab has no matching row in the file list, the sidebar draws a row from that
  info: the tab's name, or "New session" if it has none, with a green dot,
  pinned in the project for the tab's directory. If no project exists for
  that directory yet, a project group is created for it. When a tab closes,
  the sidebar fetches the file list again, so a session that got its file
  while open stays in the list at its normal place by file time.
- **Fetch the file list again whenever a tab opens or closes.** This is
  simpler, but a brand new tab still has no row until its file exists, and
  the list is fetched more often.

The rest of this plan assumes the first option.

## Changes

### 1. A pure function that orders projects and sessions

Replace `src/public/session-limit.ts` with `src/public/session-order.ts`,
which holds one pure function that takes the projects from `/api/sessions`, the open tabs (file
path, directory, name, creation time), the expanded projects, and whether a
search is active. It returns the projects in display order, and for each
project the open rows, the limited rest, and the hidden count.

- An open tab matches a session row by file path. An open tab with no
  matching row matches a project by directory, or makes a new project entry.
- The rule that adds the viewed session as an extra row goes away. The viewed
  session is always an open tab, so pinning already covers it.

### 2. The sidebar knows which sessions are open

- `SessionSidebar` gets a method such as `setOpenSessions(tabs)`. It stores
  the tabs and re-renders only when the computed order or the set of rows
  changes. Live session updates arrive often during streaming (each event
  bumps `lastActiveAt`), so a change that does not affect the sidebar must
  not rebuild it.
- `buildSessionItem` adds the green dot class itself, from the stored tabs.
  `updateLiveSessionIndicators()` and the `onRendered` hook that calls it are
  no longer needed for the dots.
- `setActive` and `clearActive` keep toggling `.active` without a rebuild,
  because the viewed session no longer changes which rows are shown.
- `app-main.ts` calls `setOpenSessions` from the places that change
  `liveSessions` today (`setLiveSessions`, `upsertLiveSession`,
  `handleLiveSessionClosed`, and the poll in `pollInstances`).

### 3. Rows built from tab info

- A row for an open tab with no file row uses the tab's name or
  "New session", and the time the tab was opened. Clicking it selects that
  tab. It has no context menu: favourite, export and delete need a file, and
  renaming would make the server append to a file Pi has not created yet.
- When the tab's name changes, the row updates.
- Rows that come from the file list keep the title from the file. The server
  gives open tabs an automatic title that is not saved, so using the tab's
  name for them would change the title when the tab opens and change it back
  when it closes.
- When a tab closes, the sidebar fetches `/api/sessions` again so a session
  that got its file while open is listed at its normal place.

### 4. Remove the server `live` tag from rows

Drop the `live` tag from `buildSessionItem`. The server can keep sending the
`live` field, or it can be removed from `serveSessionsList` in
`src/server/server-main.ts` if nothing else reads it.

## Tests

- Unit tests for the pure function:
  - projects with open tabs come first, ordered by their most recently
    opened tab, and the rest keep their order;
  - inside a project, open sessions come first, most recently opened first,
    then the rest newest first;
  - several open sessions older than the 10 newest are all shown, and the
    rest is still cut at 10, with the right hidden count;
  - an expanded project and an active search show every session in the same
    order;
  - an open tab with no file row is placed in the project for its directory,
    or in a new project entry when none exists.
- Update `test/e2e/sidebar-projects.e2e.ts`. The test
  `live-tab selection, reload, and closing tabs keep the open session listed`
  expects the old extra-row behavior, so rewrite it: open two tabs on sessions
  older than the 10 newest; both show at the top of the project with green
  dots, the newer tab first; the project moves to the top of the sidebar;
  after reload the order is the same; closing a tab puts its session back at
  its normal place, and closing both restores the original order.
- An end-to-end test that a new tab from a project `+` shows a "New session"
  row with a green dot in that project right away.
- Run `npm run typecheck`, `npm test`, and `npm run test:e2e` (about 35
  seconds; give it a long enough timeout or run it in the background).

## Out of scope

- A separate "Open" section at the top of the sidebar.
- Ordering by last activity instead of tab creation time.
- Showing streaming or pending-approval state in the sidebar rows. The live
  tabs already show it.
- Saving the collapse or "Show all" state across reloads.
