# Fast tab switching and opening for large sessions

## Problem

Switching to a tab that holds a large session, or opening a large session in
a new tab, makes the user wait a long time before the conversation appears.

Every switch throws away the current conversation and rebuilds the new one
from nothing:

1. `selectLiveSession` clears the page and downloads the session's whole
   history again (`GET /api/live-sessions/:id/snapshot`), even when this
   browser showed that tab a moment ago and nothing changed.
2. The browser parses the whole response, builds history items, paints the
   newest 30 items, then builds every older item in idle-time chunks of 50.
3. Every item builds all of its markup at once, including collapsed tool
   card bodies (highlighted code, edit diffs, full tool output) and collapsed
   thinking blocks that the user may never open.

The earlier plan (`.plans/completed/perf-fast-first-render-of-large-sessions`)
made the newest messages paint first. It did not reduce the total work, and it
did not avoid repeating that work on every switch.

## What the benchmark measured

`npm run benchmark` drives the real UI in Chromium against the in-process
server and measures four actions: opening a session from the sidebar on an
empty page (`open`), opening a second one while the first is shown
(`open-replace`), clicking back to the first tab (`switch`), and switching
while the other tab is still filling in older history (`switch-busy`). The
test sessions follow the sizes of the largest real sessions on this machine:

| preset  | entries | items | snapshot | contents                                  |
| ------- | ------: | ----: | -------: | ----------------------------------------- |
| typical |     513 |   510 |   3.3 MB | 15 turns of 16 tool steps (real max size) |
| long    |    2043 |  2040 |  13.7 MB | 60 turns of 16 tool steps                 |
| images  |      87 |    84 |   9.2 MB | short chat with 7 large screenshots       |

Baseline on this machine, median of 3 runs (`baseline-cpu1.json` and
`baseline-cpu4.json` in this folder). "tail" is when the newest message was
painted; "full" is when all history was in the page; "blocking" is main-thread
time beyond 50 ms per task, which is how long input feels stuck.

| CPU | preset  | action | tail (ms) | full (ms) | max task (ms) | blocking (ms) | elements |
| --- | ------- | ------ | --------: | --------: | ------------: | ------------: | -------: |
| 1x  | typical | open   |       174 |       479 |             0 |             0 |   16,608 |
| 1x  | typical | switch |        46 |       343 |             0 |             0 |   16,612 |
| 1x  | long    | open   |       267 |     1,654 |             0 |             0 |   67,434 |
| 1x  | long    | switch |       149 |     1,593 |             0 |             0 |   67,438 |
| 4x  | typical | open   |       336 |       862 |            85 |            35 |   16,608 |
| 4x  | typical | switch |       148 |       653 |             0 |             0 |   16,612 |
| 4x  | long    | open   |       570 |     4,013 |           124 |           493 |   67,434 |
| 4x  | long    | switch |       392 |     3,916 |           127 |           411 |   67,438 |
| 4x  | images  | open   |       644 |     1,079 |           199 |           385 |    3,752 |
| 4x  | images  | switch |       422 |       793 |           163 |           237 |    3,756 |

"4x" slows the browser CPU four times, which is closer to a laptop on battery
or a phone. These runs are on localhost, so the download is nearly free; over
a phone or remote link, the 13.7 MB long snapshot alone takes seconds before
anything can paint.

Findings:

- **Every message searches the whole conversation.** `renderUserMessage` and
  `renderAssistantMessage` call `this.container.querySelector('.welcome')` to
  remove the welcome screen. There is never a welcome screen during history
  rendering, so each call searches every element on the page. The cost grows
  with the square of the session length. In the 4x long profile,
  `querySelector`/`querySelectorAll` took 2–3.5 s of the main thread. A
  one-line experiment (only check the first child) gave, for the long session
  at 4x: script time −50%, blocking −59% to −73%, full history −23% to −30%.
  Time to the newest messages did not change.
- **The newest messages wait for the whole session.** For the long session at
  4x, 100 ms goes to the download and 230–320 ms to parsing 13.7 MB and
  building the first 30 items. Both grow with total session size, even though
  only the newest items are needed first.
- **Inline images are costly.** Base64 images make up most of an image
  session's snapshot. Building user messages with `data:` image URLs costs
  150–200 ms per switch at 4x and gives the longest single tasks (160–220 ms).
- **Collapsed content is built anyway.** About 40% of all elements (26,924 of
  67,434 in the long session) are inside collapsed tool card bodies and
  thinking blocks. Highlight.js on `write` arguments is two thirds of the
  string work (`npm run benchmark:render`).
- **Compressing the snapshot helps only over a network.** gzip makes the long
  snapshot 4x smaller (13.7 → 3.3 MB), but level 6 takes 465 ms of server CPU
  for the long session and blocks the server while it runs. Image data
  barely compresses.
- Not a cause: Pi already sends streaming text as deltas only, so tabs
  streaming in the background add little work. The sidebar and tab bar already
  skip redraws when nothing they show has changed.

## Fix plan

Steps are ordered by gain for effort. Each step is its own commit and is
measured with `npm run benchmark -- --json after.json --baseline before.json`
(at 1x and at `--cpu 4`).

### Step 1 — Stop searching the whole conversation for the welcome screen

The welcome screen is always the container's only child when present
(`renderWelcome` replaces the container's contents). Check only the first
child, or clear the welcome screen once in `clearConversation` and when the
first live message arrives.

Expected: the measured −50% script time and −25% full-history time for long
sessions. Done when no render path searches the whole container per item.

### Step 2 — Keep each open tab's conversation when switching away

Switching back to a tab this browser already showed should reuse its built
conversation instead of downloading and rebuilding it.

- On switch away, park the tab's view: move the message container's children
  into a stored fragment, together with the state that points into them (the
  tool card renderer's maps, the expansion state, the unfinished history-fill
  position, and the scroll position). On switch back, restore them and resume
  any unfinished fill. Parking is less invasive than one renderer per tab,
  because the rest of `app-main.ts` keeps talking to one active renderer.
  `ToolCardRenderer` and `MessageRenderer` need small export/import methods for
  their state.
- A parked view can go stale, because events for background tabs are ignored
  today. Mark the view stale when any event arrives for its session. On switch
  back to a stale view, ask the server only for what changed:
  `GET /snapshot?after=<entry count>&epoch=<history epoch>`.
- The server adds a history epoch to each session. It changes whenever the
  entries are replaced instead of appended (today only `navigate_tree` in
  `src/server/tree.ts`). When the epoch matches, the server returns only the
  entries after the given count, and the client appends them. When it does
  not match, the client rebuilds the whole view as it does today.
- Keep views for the few most recently shown tabs only (for example 4, or a
  total element budget) and drop the rest, so memory stays bounded.
- A turn that is still streaming is not in the entries yet. This matches
  today's snapshot behavior: the next live delta creates the streaming
  message.

Expected: switching back to an unchanged tab costs about the same for every
session size (reattach plus one layout), instead of 0.4–4 s at 4x. Add a
benchmark action that switches back after the background tab received a new
turn, by writing Pi events to the fake child's stdout, to measure the
catch-up path.

### Step 3 — Send the newest history first

Opening a session (and rebuilding a stale or evicted view) should not wait for
the whole history to download and parse.

- `GET /snapshot?tail=<n>` returns only the newest entries, cut at the start
  of a user or assistant message entry so that every tool result stays with
  its tool call, plus the total entry count and the session totals the
  context pill needs (total cost, last usage). Today the browser computes
  those totals from the full history.
- The browser paints that tail, then downloads the older entries and fills
  them in above, using the existing chunked fill and scroll anchoring.
- The older request must be cancelled or ignored if the user switches away
  (the existing history render token covers the fill part).

Expected: time to the newest messages no longer grows with session size. This
is the largest gain over a phone or remote connection.

### Step 4 — Load images by URL instead of inside the snapshot

- The snapshot replaces each image's base64 data with a small reference. A
  new route serves the image bytes for a session, entry, and block index.
- History images use `loading="lazy"` and `decoding="async"`, so off-screen
  images do not load or decode during the switch.
- Tool results that contain images currently show the image's JSON, base64
  included, as text in the output (`formatResult`). Show the image, or a short
  placeholder, instead.

Expected: image session snapshots shrink from about 9 MB to under 100 KB, and
the 150–200 ms tasks spent building image messages go away.

### Step 5 — Build collapsed tool bodies and thinking blocks on first open

- History tool cards build only the header. The body (arguments, highlighted
  code, diff, output) is built the first time the card is expanded, from the
  data the card already holds.
- Expand All builds bodies for every card. With hundreds of cards it builds
  them in chunks, so it does not freeze the page.
- The copy-output button reads the stored result, not the body text.
- Thinking blocks store their text and fill in their content when opened.
  Replace the inline `onclick` with one delegated handler on the container.
- Live tool cards keep building eagerly; this change is only for history.

Expected: about 40% fewer elements, most of the highlight work removed, and
lighter teardown when a view is dropped. Check that the end-to-end tests that
read body text still pass, expanding cards first where needed.

### Step 6 — Compress large snapshot responses for remote clients

Compress snapshot responses over a size threshold when the request accepts
gzip. Use a fast level and Node's asynchronous zlib API, so compression never
blocks the server the way the measured synchronous level-6 run did. Skip it
for loopback clients if measurements show no gain there. Steps 3 and 4 already
shrink what is sent, so do this step last and only if it still pays off.

### Not planned now

- **Build only the history near the viewport** (load older items when the
  user scrolls up, instead of filling all of it in idle time). This would cap
  the work for very long sessions, but find-in-page would miss older messages
  and Expand All would need new rules. Reconsider only if steps 1–5 are not
  enough.
- **The 100 ms wait in `PiRpcSession.start()`** delays every `open` by about
  115 ms before the snapshot request starts. Rendering history from the
  session file while Pi starts would hide it. Small gain; separate change.
- **Safari's manual scroll-anchoring fallback** reads `scrollHeight` after
  every chunk, which forces a layout of the whole page. Chromium cannot
  measure this. Check on an iPhone or iPad if the user sees lag there.

## Benchmark code

- `benchmark/fixtures.ts` builds deterministic session files that match real
  sessions: thinking and tool steps per turn, a tool mix weighted toward bash
  and read, long-tail tool output sizes, Markdown with code, tables and math,
  and real PNG screenshots.
- `benchmark/tab-switch.ts` (`npm run benchmark`) measures the four actions in
  Chromium. Options: `--preset typical,long,images`, `--runs N`, `--cpu N`
  (CPU slowdown), `--json file` (save results), `--baseline file` (show the
  change against saved results), `--profile dir` (an extra, unrecorded run
  that saves `.cpuprofile` files and prints the functions with the most self
  time), `--headed`.
- `benchmark/render-cost.ts` (`npm run benchmark:render`) measures the string
  work without a browser: JSON parsing, history items, Markdown, highlighting,
  and diffs.
- `scripts/playwright-env.sh` holds the Nix browser setup shared by
  `scripts/e2e.sh` and `scripts/benchmark.sh`.

The benchmark is not part of `npm test` or `npm run test:e2e`; a full run of
all presets takes a few minutes.

## Verification for each step

- `npm run typecheck`, `npm test`, `npm run test:e2e` (keep it near 35 s).
- `npm run benchmark -- --baseline .plans/active/perf-fast-tab-switch-large-sessions/baseline-cpu1.json`
  and the same with `--cpu 4` against `baseline-cpu4.json`. Record the
  result table in the commit message. The baselines are from this machine;
  on another machine, record a fresh baseline from `main` first.
- New end-to-end coverage where the behavior changes: a switch back reuses
  the parked view and keeps the scroll position; a stale view catches up with
  entries that arrived while away; a tree navigation while away forces a full
  rebuild; history images load by URL; a lazily built body appears on expand
  and with Expand All.
