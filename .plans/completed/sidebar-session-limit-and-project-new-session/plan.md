# Plan: show 10 sessions per project, and a "+" on each project row

Branch: `feat/sidebar-session-limit-and-project-new-session`

## Goal

Two improvements to the left sidebar's project list:

1. Each project shows only its 10 most recent sessions by default. A control
   on the project lets the user expand to all sessions, and collapse back.
2. Each project's header row has a `+` button. It opens the same "New Tau Tab"
   popup as the `+` in the upper-right of the sidebar, with the project
   directory already filled in.

## Current state

- The sidebar is `src/public/session-sidebar.ts` (`SessionSidebar.render`). It
  builds one `.project-group` per project: a `.project-header` (chevron, short
  project name, session count) and a `.project-sessions` list with every
  session.
- `/api/sessions` already returns each project's sessions sorted newest first,
  so "the first 10" means "the 10 most recent". No server change is needed.
- Clicking a header collapses or expands the whole project. The collapsed
  state lives in memory (`collapsedProjects`) and resets on page reload.
- Title search (`applySearch`) hides rows by toggling a class on the existing
  DOM rows, so it only sees rows that were rendered.
- The "New Tau Tab" popup is opened by `openNewLiveSessionModal` in
  `src/public/app-main.ts`. It only fills the directory field when the field
  is empty, so it keeps whatever was typed last time.
- The `SessionSidebar` is created in `app-main.ts` with only the
  `onSessionSelect` callback. It has no way to ask the app to open the popup.

## Decisions

- The limit is a constant, 10. It is not configurable.
- The expanded state is kept in memory only, the same as the project collapse
  state. It resets on page reload. (Saving it in `localStorage` is a small
  change later if wanted.)
- The active session is always shown, even when it is older than the 10 shown.
  It appears as an extra row after the 10, so selecting an old session never
  makes it vanish from the list.
- The count badge on the header keeps showing the total number of sessions,
  not the number shown.
- While the user is searching, the limit is ignored so title search covers
  every session of every project.
- The `+` opens the popup with the directory set to the project's path. The
  user can still pick a model and edit the directory before creating the tab.
- The Favourites group and the "Message matches" group are not limited.

## Part 1: limit to 10 sessions with expand

### Behavior

- For a project with 10 or fewer sessions, nothing changes and no control is
  shown.
- For a project with more than 10, render the 10 most recent, plus the active
  session if it is not among them. Below the list, show a row such as
  "Show all 23" with an expand icon. Clicking it shows all sessions and
  changes the row to "Show fewer" with a collapse icon.
- Expanding or collapsing one project does not touch the others and does not
  reload sessions from the server.
- Collapsing the project (header click) and expanding it later keeps its
  expanded or limited state.
- When the sidebar re-renders (refresh button, favourite toggle, a new session
  appearing), the expanded state is kept.
- When the search box is cleared, projects go back to their limited or
  expanded state from before the search.

### Implementation notes

- Keep the choice of which sessions to show in one small pure function, in its
  own file under `src/public/`, so it can be unit tested without a DOM. It
  takes the session list, the limit, whether the project is expanded, whether
  a search is active, and the active session file, and returns the sessions to
  render and how many are hidden.
- The sidebar keeps an `expandedProjects` set next to `collapsedProjects`,
  keyed the same way (`dirName`).
- Search must keep working on titles of sessions that are currently hidden.
  The simplest approach is to re-render with the limit lifted when a search
  starts and re-render with the limit applied when it ends, instead of
  rendering every row and hiding the extra ones.
- Deleting a session removes its row today without a re-render. After a delete
  in a limited project, the list should show the next older session so the
  project still shows up to 10. A re-render after delete is the easy way.
- `setActive` toggles `.active` on existing rows. When a session that is not
  currently rendered becomes active (for example a new live session resumed
  from another place), the sidebar re-renders so the active-session rule above
  holds.

## Part 2: "+" on the project header

### Behavior

- Each `.project-header` for a real project gets a small `+` icon button with
  the title "New session in this project". It is not added to the Favourites
  or "Message matches" headers.
- Clicking the `+` does not collapse or expand the project. It stops the click
  from reaching the header's own handler.
- Clicking it opens the "New Tau Tab" popup with the project directory field
  set to that project's `path`, overwriting any value left from before. The
  model field is left as it is today.
- The directory field gets focus, as it does now.
- On desktop the button can be dimmed until the header is hovered, but it must
  always be visible and tappable on mobile, where there is no hover. The
  mobile header styles (`@media` block near the end of `public/style.css`)
  need a large enough tap target.
- The `+` sits next to the session count on the right side of the header and
  must not push the count out or truncate the project name worse than today.

### Implementation notes

- Add an optional second callback to `SessionSidebar`'s constructor, for
  example `onNewSessionInProject(project)`. `app-main.ts` passes a function
  that sets the directory field and then calls the existing popup opener.
- `openNewLiveSessionModal` currently fills the directory only when it is
  empty. Give it an optional directory argument that always wins when given,
  so the existing `+` button keeps its current behavior.
- Closing the popup and reopening it from the upper-right `+` afterwards keeps
  the old behavior: the field keeps the last value, whether it was typed or
  came from a project `+`. The field is not cleared on close.
- Use the same inline SVG plus icon style as `#new-session-btn` in
  `public/index.html`. Escape the project path when it is put into any HTML
  attribute, as the existing header code does.

## Tests

- Unit tests for the pure function: 10 or fewer sessions; more than 10
  collapsed; more than 10 expanded; active session beyond 10 is included;
  active session already in the first 10 is not duplicated; search active
  ignores the limit; the hidden count is correct.
- An end-to-end test (see `test/e2e/`) with a project that has more than 10
  sessions: only 10 rows show, the badge shows the total, the expand control
  shows all and collapses back, and a project with few sessions has no
  control.
- An end-to-end test that clicking a project's `+` opens the popup with that
  project's directory filled in, does not collapse the project, and creates a
  tab in that directory.
- Run `npm run typecheck` and `npm test`. The full `npm run test:e2e` takes
  over 250000 ms, so run it in the background and wait for it.

## Out of scope

- A configurable limit or a setting for it.
- Remembering expanded projects across reloads.
- Paging ("show 10 more") instead of a single expand to all.
- Changes to the server or to `/api/sessions`.
