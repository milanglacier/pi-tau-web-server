## Findings

### [P2] Let one-pixel upward scrolls stop following

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/bottom-follow.ts:60-67`

A wheel or trackpad event can move the view up by exactly one CSS pixel. The handler records the new position but leaves following enabled, so the next streamed update snaps the view back down. Repeated one-pixel movements can keep getting swallowed. Detect upward movement separately from the tolerance used to recognize the bottom.

### [P2] Resume following when the reader reaches the end during streaming

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/bottom-follow.ts:61-66`

If a reader reaches the bottom just before a streamed chunk adds height, the scroll handler can measure the new bottom and conclude that the reader never got there. Following stays off, and later chunks move farther out of view. Account for the bottom the reader could actually reach before the content grew.

### [P2] Let touch scrolling settle before measuring the test position

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/test/e2e/streaming-scroll.e2e.ts:78-81`

The full Chromium suite failed because the test sampled `scrollTop` while the touch gesture still had momentum. A traced run showed the view move four more pixels upward while following remained off, but the assertion blamed the stream. Wait for the gesture to finish scrolling before measuring whether later chunks move the view.

### [P3] Apply follow-on-send to queued prompts

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/app-main.ts:1572-1575`

Submitting a prompt during a reply bypasses the new follow reset, and dispatching the queued prompt does not reset it either. A reader who scrolled up can submit another prompt and never see it or its reply without manually jumping down. Apply the same follow-on-send behavior to queued submissions without overriding a later decision to scroll up.

## Overall assessment

**Verdict:** Patch is not correct.

**Explanation:** Sharing one follow state between message and tool rendering makes sense, and the change fixes ordinary upward gestures. Reviewing `fix/streaming-scroll-up-swallowed` against `main`, typechecking and all 19 targeted browser tests passed, but the full Chromium suite failed on the new touch test, and two scroll edge cases remain.

## Decision

We fix the two findings that change what users see, and the cause of the e2e failure.

- **Fix: resume following when the reader reaches the end during streaming (P2).** This is a real bug. A traced run under CPU load showed every scroll event landing exactly on the bottom as it was one frame earlier, while new text had already made the page taller. Following never resumed, and the reader had to scroll again or press the button. Slow devices and long replies make it more likely, because each streamed piece re-renders the whole reply.
- **Fix: apply follow-on-send to queued prompts (P3).** This is a real but minor gap. A reader who scrolls up and sends a follow-up while a reply streams never sees the follow-up or its reply. The changelog promises that sending a message follows the reply again.
- **Fix: the e2e failure.** The streaming-scroll tests fail under CPU load for two reasons. First, the touch test lifts the finger while it is still moving, so Chrome keeps scrolling after the touch ends and the test blames the stream. This is a test bug. Second, both the touch and mouse wheel tests time out waiting for the view to follow again after scrolling back down. That is the P2 bug above, so the app fix resolves it.
- **No change: one-pixel upward scrolls (P2 in the review).** This is theoretical. A scroll is swallowed only if every frame of it moves one pixel or less. Any deliberate wheel, trackpad, or touch scroll moves more than that within a frame or two, and the first such frame stops following.

### Note on the P2 fix

Resuming at a bottom the page had a moment ago must count only scrolls that the reader makes. When older history is inserted above the view, the browser (or the app, where the browser cannot) moves the view down to keep the reading position. That movement can cross a recently measured bottom. Without a check for the reader's own downward input, a reader who scrolls up a little while a long session is still loading jumps to the end. The history progressive-render tests caught this under CPU load.
