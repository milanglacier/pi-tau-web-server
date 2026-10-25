# Plan: completion in the "New Tau Tab" popup

Branch: `feat/new-tab-completion`

## Goal

The "New Tau Tab" popup has two free-text fields. Both should suggest values
while the user types:

1. **Project directory** (`#new-live-session-cwd`): suggest real directories on
   the machine that runs the Tau server.
2. **Model** (`#new-live-session-model`): suggest `provider/id` values, and
   optionally a `:thinking-level` suffix.

The user can always type any value by hand. Completion only helps; it never
blocks or rewrites what the user typed.

## Current state

- The popup markup is in `public/index.html` (around line 240). The open, close
  and submit logic is in `src/public/app-main.ts` (`openNewLiveSessionModal`,
  `loadProjectChips`, the `newLiveSessionForm` submit handler).
- Project chips come from `GET /api/projects`, which lists only the direct
  children of `tau.projectsDir`.
- The main chat has a model picker in `src/public/model-picker.ts` with fuzzy
  matching and a suggestion list. Its helpers (`normalizeAvailableModel`,
  `fuzzyMatch`) are private to that file. It loads models with the
  `get_available_models` RPC, which is a backend-local command and does not
  need a live session (the server runs `pi --list-models`, cached).
- There is no endpoint that lists arbitrary directories. `GET /api/files`
  requires a live session and is limited to that session's cwd, so it cannot
  be reused.

## Decisions

- The directory endpoint may list any directory the server user can read.
- Dot-directories are hidden unless the user types a `.`. No other filtering
  and no other special cases; keep it simple.
- A path with no leading `/` or `~` is completed relative to `tau.projectsDir`, or relative to the home
  directory when `tau.projectsDir` is not set (it has no default).
- Model completion suggests only `provider/id`, with no `:level` stage.
- Model completion behaves the same as the model picker in the top status
  bar (the same fuzzy matching, result cap, list contents and keys).
- Tab accepts the highlighted suggestion and never moves focus to the next
  field while a suggestion list is showing.

## Part 1: directory completion

### Server

Add `GET /api/complete/directories?prefix=<text>`:

- Expand a leading `~` with the existing `expandHome`. Resolve a relative
  prefix against `tau.projectsDir`, or against the home directory when it is
  not set.
- Split the prefix at the last `/`. The left part is the directory to list,
  the right part is the partial name to match.
- Return only directories, as `{ items: [{ name, path }] }`, matched by
  case-insensitive prefix, sorted by name, capped at 50.
- Hide dot-directories unless the partial name starts with `.`.
- A missing or unreadable directory returns an empty list, not an error.
- The route goes through the normal auth check like the other `/api/` routes.

### Client

- Add a small reusable dropdown in `src/public/completion-list.ts`: shows
  items, ArrowUp/ArrowDown, Tab/Enter to accept, Escape to close, mouse
  click, close on blur.
- On input in the directory field, debounce ~100 ms, abort any earlier
  request, and fetch suggestions. Accepting fills in the path plus a trailing
  `/` and immediately asks for the next level.
- Tab accepts the highlighted suggestion (the first one if none is
  highlighted). Enter accepts a highlighted suggestion; with none highlighted
  it submits the form as it does today.
- The existing project chips stay.

## Part 2: model completion

Client only, no new server code.

- Move the fuzzy matcher and the model-list normalizer out of
  `model-picker.ts` into `src/public/model-match.ts`, so the status-bar
  picker and the popup share one implementation. The status-bar picker's
  behavior does not change.
- When the popup opens, fetch `get_available_models` (sessionId `null`) and
  keep the list while the popup is open. This is the same list the status-bar
  picker uses.
- Same rules as the status-bar picker: fuzzy match against `id provider`, show
  at most 50, show the `provider` next to the id, plus the context window and
  other metadata. Accepting inserts `provider/id`. If the text already
  contains a `:`, show no suggestions.
- The submitted string is whatever is in the field, in the existing
  `provider/id[:level]` format. The user can still type the level by hand.

## Tests

- `test/http-routes.test.ts`: the new route returns only directories, handles
  `~`, a trailing `/`, a missing directory, dot-directory hiding, the result
  cap, and requires auth when auth is on.
- New unit test for the shared model matcher (ids with slashes, provider
  matching, no suggestions after a `:`).
- New unit test for the completion-list component's keyboard handling if it can
  run without a browser; otherwise cover it in an e2e test.
- `test/e2e`: open the popup, type a partial path, accept with Tab, and type a
  partial model name and accept with Enter. Remember that the full e2e run takes
  more than 250000 ms.
- Run `npm run typecheck` and `npm test` before committing.

## Rollout steps

1. Extract the shared model matcher (no behavior change), run tests.
2. Add the reusable completion list component.
3. Wire model completion into the popup.
4. Add the directory endpoint with tests.
5. Wire directory completion into the popup.
6. Update README (popup section) and add e2e coverage.
