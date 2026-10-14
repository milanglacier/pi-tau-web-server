# Keep streamed thinking inside the thinking block when a message has no visible text

## Context

While an assistant message streams, thinking deltas go into the streaming
thinking block and text deltas go into the message body. That part works.
The leak happens when the message finishes.

`finalizeStreamingMessage` (`src/public/message-renderer.ts:206`) rebuilds the
message from scratch: a fresh thinking block, then the main text rendered as
markdown. It does not receive the main text. It looks for it in three places:

1. the raw markdown stashed on `.streaming-text` (`dataset.rawText`);
2. the raw markdown stashed on `.message-content` (`dataset.rawText`);
3. `contentDiv.textContent`, which is every visible character in the message.

Both stashes are only written by `updateStreamingMessage`, which only runs when
text arrives. A message that thinks and then calls a tool, with no text in
between, never writes them, so the code takes option 3. At that moment the
message holds only the streaming thinking block, so its `textContent` is the
label "Thinking" plus the whole thinking text. That string is rendered as the
message body under the new thinking block.

This is common with open models that expose raw reasoning, because they often
go straight from thinking to a tool call. It looks random because a message
with any visible text is not affected, and reloading the session hides it:
saved history is rendered from the stored content blocks and never takes this
path.

Pi itself is not involved. Its OpenAI-compatible provider only emits
`thinking_delta` from the provider's reasoning fields.

## Change

### `src/public/app-main.ts` — `handleMessageEnd`

The caller already keeps the full streamed text in `currentStreamingText`, and
replaces it with the authoritative text from the `message_end` payload when
that is at least as long. Pass it to `finalizeStreamingMessage` next to
`currentStreamingThinking`.

### `src/public/message-renderer.ts`

- `finalizeStreamingMessage(messageElement, usage, thinking, text)`: render the
  final body from the `text` argument. Drop the lookup through the stashed
  `dataset.rawText` values and the `textContent` fallback. A message with no
  text finishes with an empty body and only its thinking block.
- `updateStreamingMessage`: stop writing `dataset.rawText`. Nothing reads it
  any more.

No other callers of `finalizeStreamingMessage` exist.

## Tests

`test/e2e/history-render.e2e.ts` holds two browser tests that stream thinking
in small deltas through the real server and UI, then end the message:

- **thinking followed only by a tool call**: the regression test. It checks
  that nothing outside the thinking block has text, both while streaming and
  after the message finishes. It fails on the current code with the leaked
  string `"Thinking … private reasoning …"` and must pass after the fix.
- **thinking followed by text**: the body must be exactly the streamed answer
  and the thinking block must hold the thinking. It passes before and after,
  and guards against the fix dropping real text.

Add a third case where a text delta arrives *before* the thinking. The
streaming code moves earlier text into `.streaming-text` once the thinking
block appears, so this checks that the final body is still the full text and
holds no thinking.

## Verification

1. Run the new tests on the current code and confirm the tool-call case fails.
2. Apply the fix, rerun them, and confirm all pass.
3. `npm run typecheck`, `npm test`, and the full `npm run test:e2e` (over
   250000 ms, so run it in the background).
