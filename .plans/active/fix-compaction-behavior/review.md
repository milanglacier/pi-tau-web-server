# Review: compaction behavior

## Scope

Reviewed `fix/compaction-behavior` against its merge base with `main`,
`c1619a96353924e90f001b4745fc967e5008c336`. The working tree was clean.

## User decisions

- **Summary HTML safety:** Pass for this step. Defer this finding to the next
  step. This is an accepted deferral, not a claim that the escaping is safe or
  that the issue is fixed.
- **Project-specific auto-compaction settings:** Treat this as a niche corner
  case because users rarely configure this setting per project. No decision to
  fix or defer it has been made.
- **Messages queued during automatic compaction before a reply starts:** The
  user approved fixing this finding. The fix and its validation are recorded
  below.

## Findings

### 1. [P1] Sanitize the HTML generated from compaction summaries

**Location:** `src/public/markdown.ts:353-357`

**Status:** Fixed. The user also chose to show HTML as text in assistant
replies, since they had the same problem with raw HTML.

Escaping raw HTML does not prevent JavaScript from entering through markdown
image attributes. For example, `![x](x" onerror="document.body.hidden=true)`
produces an actual image with an executable `onerror` handler. Model-generated
or saved summaries can therefore run JavaScript in Tau's origin. Sanitize the
generated HTML or safely escape and validate markdown attributes. The existing
safety test covers raw HTML tags, but not this case.

### 2. [P2] Wait for the original reply before sending queued messages

**Location:** `src/public/app-main.ts:1079-1081`

**Status:** Fixed. The regression tests cover normal viewing and reloading
while the automatic compaction is running.

Sometimes Pi compacts the conversation before starting a reply. If the user
sends another message during that compaction, Tau queues it. When compaction
finishes, Tau can mistake the tab for idle and send the queued message while
Pi is starting the original reply. Pi rejects the queued message as busy.
Keep the message queued until the original reply finishes, and test automatic
compaction before the original reply starts.

#### Why compaction can happen before a reply starts

The user's expectation is correct for an ordinary successful reply: if the
context crosses the threshold and automatic compaction succeeds, Pi normally
handles it before the operation settles. The extra check before the next reply
covers cases where that earlier compaction did not happen or did not succeed:

- A reply was stopped. Pi's check after a run skips aborted assistant messages,
  but its check before the next prompt includes them. Compaction is still
  conditional on the context reaching the threshold.
- The earlier automatic compaction failed or was cancelled. The context can
  remain large, so Pi checks it again before the next prompt.
- Automatic compaction was off while the context grew, then was turned on.
  The next prompt is a chance to compact that existing context.

This is explicit in the installed Pi implementation:
`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`.
`_prepareRun()` calls `_checkCompaction(lastAssistant, false)` at lines
1449-1454. The aborted-message check at lines 2362-2368 explains the difference
between the checks before a prompt and after a run. A failed automatic
compaction returns without a successful result at lines 2587-2613.

#### Reproduction

Using a real Pi RPC process and the compaction fixture provider:

1. Leave automatic compaction off and generate a reply reporting 90,000 input
   tokens against a 100,000-token context window.
2. Enable automatic compaction and submit the original question.
3. Hold the summary request open. Pi emits `compaction_start` while Tau still
   reports `isStreaming: false` because `agent_start` has not arrived.
4. Release the summary. At `compaction_end`, `willRetry` is false and Tau has
   neither streaming nor compaction state. Its queue can therefore drain.
5. Submit the queued question at that point. Pi rejects it with
   "Agent is already processing. Specify streamingBehavior ('steer' or
   'followUp') to queue the message."

Here, `willRetry: false` means Pi is not retrying a completed response. It does
not mean the newly submitted original question has finished.

### 3. [P2] Show the auto-compaction setting Pi actually uses

**Location:** `src/server/server-main.ts:348-350`

**Status:** Niche corner case, as requested by the user. No fix or deferral has
been approved.

A trusted project's `.pi/settings.json` can give auto-compaction a value that
takes priority over the global setting. Turning the toggle off changes the
global setting, but the project setting may keep auto-compaction on. Tau caches
and shows the requested value anyway. Read back Pi's effective value and show
that value after changing the setting. A test should cover a project override.
The mismatch was confirmed with Pi's settings manager: the global value became
false while the effective value remained true.

## Validation during the initial review

- Type checking passed.
- All 306 unit and integration tests passed.
- All eight new compaction end-to-end tests passed.
- The full end-to-end run passed 87 of 88 tests in about 34 seconds. An existing
  model-completion test timed out. All six tests in that file passed on rerun.
- Rendering the image payload in finding 1 confirmed that the generated HTML
  contains an executable event-handler attribute.
- No application code or tests were changed during the review.

## Fix summary for finding 2

Automatic compaction now counts as part of the original reply from
`compaction_start` through `agent_settled`, even when `agent_start` has not
arrived yet. Finishing the summary does not release queued messages while
that reply is still pending.

- `src/server/sessions.ts` keeps the reply busy for automatic threshold and
  overflow compaction. Live metadata and snapshots carry that state, so
  reloading during compaction preserves it.
- `src/public/app-main.ts` keeps both the viewed conversation and its tab busy
  during the same period. Queued messages wait for the original reply to
  finish. Manual compaction still releases the queue when compaction ends.
- Server tests cover threshold and overflow compaction before `agent_start`,
  the state after the summary finishes, and settlement. They also check that
  manual compaction does not create a pending reply.
- Two real-Pi browser tests cover queueing before a reply starts, with and
  without reloading during compaction. The fixture holds the summary and the
  original reply separately, so the test checks that the message stays queued
  until the original reply can finish. It then checks that the queued message
  gets one reply without errors or duplicate user messages.

The first regression test failed before the fix because the queued question
never received a reply. It passed after the fix.

### Validation after the fix

- `npm run typecheck` passed.
- `npm test` passed all 308 unit and integration tests.
- `npm run test:e2e`, with matching installed browser binaries, passed all 90
  tests with none skipped. The suite took about 33 seconds.
- `git diff --check` passed.

The niche project-setting issue is unchanged.

## Fix summary for finding 1

The summary was not the only way in. Assistant replies rendered any raw HTML
the model wrote, so an `<img onerror>` in a reply ran directly. Markdown links
and images also let a `"` close the attribute early, and `javascript:` links
were allowed. A bare URL could break out of its `href` the same way.

- `src/public/markdown.ts` now shows HTML as text in assistant replies and
  compaction summaries. The only exception is `<br>`, which models use for
  line breaks inside table cells. Escaping happens after code and math are
  taken out, so LaTeX like `a & b` reaches KaTeX unchanged.
- Link and image URLs must be http(s), mailto, or have no scheme. Their
  attribute values are escaped, and a bare URL stops at a quote. This also
  applies to user messages, which still keep any HTML the user typed.
- `renderMarkdownText` is removed. The compaction row uses `renderMarkdown`,
  which now escapes HTML for every caller.
- Unit tests cover raw HTML, `<br>` in tables, each attack from the review,
  safe links with `&` in the query string, and math and code with `&` or `<`.
  The new tests fail on the old code.

### Validation after the fix

- `npm run typecheck` passed.
- `npm test` passed all 312 unit and integration tests.
- `npm run test:e2e`, with matching installed browser binaries, passed all 90
  tests with none skipped. The suite took about 33 seconds.

# Second-round review

Reviewed the full branch against its merge base with `main`,
`c1619a96353924e90f001b4745fc967e5008c336`. The working tree was clean before
this review. Only this review file was changed.

## Findings

### [P1] Prevent later Markdown replacements from rewriting generated image tags

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/markdown.ts:337-338`

The link replacement runs over image tags generated earlier, and `attr` does not escape the quotes those tags contain when rendering assistant text. A summary containing `![x](x[a]( y onerror=window.summaryExecuted=1 a=))` therefore creates an image with a real `onerror` handler. Chromium executed the handler even with the summary's details section collapsed, so model-generated or saved summaries can still run JavaScript in Tau's origin without a click. Protect generated tags from later replacements or sanitize the final HTML, and add a regression test for nested Markdown syntax.

### [P2] Read back the effective auto-compaction setting

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/server/server-main.ts:348-350`

The first round's niche project-setting issue remains open: when a trusted project's `.pi/settings.json` sets `compaction.enabled` to true, turning the toggle off writes false globally but Pi still uses the project's true value. This code caches and returns the requested false value, so Tau reports that automatic compaction is disabled while it remains enabled. The installed settings manager reproduced that mismatch; read Pi's effective setting after the change and use it for both the cache and the toggle.

## Overall assessment

**Verdict:** Patch is incorrect.

**Explanation:** The earlier queueing fix is covered by passing regression tests, but summary rendering still allows JavaScript execution, and the project-setting mismatch remains unresolved. Type checking, all 312 unit and integration tests, all 90 end-to-end tests with none skipped, and `git diff --check` passed; the end-to-end suite took about 34 seconds.

## Decision after the second round

The user rejected the project-specific auto-compaction finding as won't fix.
It is not an actionable finding and should not be reported again.

## Fix summary for the second-round P1

The nested Markdown payload could turn part of an image's URL into a new link
and add an executable image error handler. The fix keeps generated code, math,
images and links out of later Markdown replacements. Attribute values use the
original text, escaped for HTML, while link labels keep their rendered
formatting. This uses the existing renderer and adds no dependency.

- `src/public/markdown.ts` stores generated inline HTML separately and inserts
  it after Markdown replacements finish. Nested link syntax inside an image
  URL stays inside the image attribute instead of creating another tag.
- `test/markdown.test.ts` covers the exact payload in both message renderers.
  It also checks that image attributes keep code, math and punctuation as text,
  that quotes stay escaped, and that link labels keep formatting and images.
- `test/e2e/compaction.e2e.ts` uses the real Pi process and fixture provider to
  put the payload in an assistant reply and a compaction summary. It waits for
  the images to finish loading, checks that no error handler or script effect
  exists, and repeats the summary checks after reload with its details closed.

The payload regression test failed before the fix and passed after it. The
project-specific auto-compaction setting was not changed.

### Validation after the fix

- `npm run typecheck` passed.
- `npm test` passed all 315 unit and integration tests.
- `npm run test:e2e`, with matching installed browser binaries, passed all 91
  tests with none skipped. The suite took about 34 seconds.
- `git diff --check` passed.
- The review text that existed before this summary was preserved exactly.
