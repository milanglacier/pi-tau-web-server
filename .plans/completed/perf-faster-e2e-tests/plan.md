# Plan: make the end-to-end tests finish in well under a minute

Branch: `perf/faster-e2e-tests`

## Goal

`npm run test:e2e` takes about 6 minutes. Bring it under a minute without
weakening what any test checks. Every existing test keeps its assertions.

## Measurements

Measured on a 12-core Linux machine with `node --test --test-reporter=spec`.

- Node already runs the five `*.e2e.ts` files in parallel, one process per
  file, so the total time equals the slowest file.
- `history-render.e2e.ts` took about 356 seconds. The other four files took
  about 25 seconds together and finish long before it.
- Inside `history-render.e2e.ts`, tests get slower the later they run. Early
  tests take 1 to 5 seconds. Late tests take 15 to 42 seconds, including
  `pending bottom scrolls respect a reader scroll and conversation clearing`,
  which only builds a small element inside the page.
- The build step takes under half a second, so it is not worth changing.

## Cause

`openPage()` in `history-render.e2e.ts` adds every browser context to a list,
and that list is closed only in `after()`. By the last test, one Chromium
process holds about 33 open pages. Many of them hold the 700-round session,
all of them run with 4x CPU throttling, and all of them stay connected to the
server's WebSocket, so they keep receiving and rendering live broadcasts meant
for later tests. Each new test competes with every earlier page.

A quick check confirmed this. Closing each test's context after the test
ended brought the file from 357 seconds to 70 seconds, and all 33 tests still
passed.

## Changes

### 1. Close each test's browser context when the test ends

`openPage` and `openNestedPage` take the test context and register
`t.after(() => context.close())`, the same pattern `sidebar-projects.e2e.ts`,
`new-tab-completion.e2e.ts`, and `permission-dialog.e2e.ts` already use.
`error-display.e2e.ts` keeps a shared list in the same way, so it gets the
same change for consistency, even though it has only two tests.

### 2. Split `history-render.e2e.ts` into files that run in parallel

Move the shared setup into `test/e2e/history-harness.ts`. The name does not
end in `.e2e.ts`, so the runner's glob does not run it as a test file. The
harness owns the isolated Pi directories, the in-process server with a fake
Pi child, the large and small session fixtures, `openPage`,
`openNestedPage`, and the small helpers the tests share. Each test file runs
in its own process, so each gets its own server and browser.

The tests move unchanged, except for passing `t` to the page helpers, into
these files:

| File | Tests |
|---|---|
| `history-progressive-render.e2e.ts` | Opening a large session, older history filling in, both reading-position tests, Expand All and Collapse All during the fill, switching sessions mid-fill |
| `history-large-session.e2e.ts` | Scroll to bottom with a large live card, pairing tool results across chunks, an unrelated live root leaving history alone, nested updates not moving a reader |
| `tool-cards.e2e.ts` | Codemode argument rendering (three tests), built-in bash/edit/read/write cards, narrow-screen file targets, long write labels |
| `nested-tool-calls.e2e.ts` | The remaining nested-call and live tool-card tests |
| `streamed-thinking.e2e.ts` | The three streamed-thinking cases |

### 3. Throttle the CPU only in tests that need a slow fill

`openPage` throttles the CPU 4x for every page today. Only tests that must
observe the history while it is still filling need that: opening a large
session, both reading-position tests, Expand All and Collapse All during the
fill, and switching sessions mid-fill. Make throttling an option of
`openPage` and turn it on for those tests only. Every other test runs at
full speed.

## Out of scope

- The fixed 1.5 second wait in `switching sessions mid-fill cancels the old
  render completely` stays. It gives a stale chunk callback time to fire, and
  there is no event that proves a callback will never run. After the split
  it overlaps with the other files, so it costs little.
- The 700-round fixture stays the same size. The tests that use it check
  chunked rendering and need several chunks.

## Validation

- `npm run typecheck`.
- `npm test`.
- `npm run test:e2e`, run several times to look for new flaky failures.
  Record the total time and the slowest file.
- Check that every test from `history-render.e2e.ts` exists in exactly one
  of the new files, with the same name.

## Results

- `npm run typecheck` passed, and `npm test` passed all 285 tests.
- The 31 test definitions and 204 assertions from `history-render.e2e.ts`
  all appear exactly once in the new files, with the same names.
- `npm run test:e2e` passed all 80 tests in three runs, taking 32, 35, and
  35 seconds. It took about 357 seconds before these changes.
- The slowest test is now `built-in bash, edit, read, and write tool calls
  render cleanly ...` in `tool-cards.e2e.ts`, at 13 to 17 seconds, so that
  file sets the total time. The test takes about 10 seconds even when it
  runs alone. If the suite needs to be faster still, find out why this
  test is slow.
