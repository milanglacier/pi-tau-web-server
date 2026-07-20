# Show the real model in the tab bar as soon as a session opens

## Context

When a new tab (live session) is created without an explicit model spec, or an old session is resumed, the model widget shows placeholders — `default` in the tab label (`compactModelLabel()`, `src/public/app-main.ts:486-489`) and `Model` in the model input widget (`updateModelDisplay()`, `src/public/model-picker.ts:81-86`) — until the user sends the first message.

Root cause: `PiRpcSession.model` starts null when no model spec was given (`src/server/sessions.ts:90-91`), and the server only learns pi's actual model from RPC responses. The only startup probe today is `get_session_stats` (`sessions.ts:194-196`), which does **not** return the model. Pi's `get_state` RPC (`~/.local/share/pi/docs/rpc.md:162-193`) returns `{model, thinkingLevel, sessionFile, sessionName, ...}` — for fresh sessions it reports pi's default model, and for resumed sessions the model restored from the session file.

The entire propagation pipeline already exists and needs no changes: every pi response flows through `handleResponse()` → `updateStateFromResponse()` (`sessions.ts:263-278`, extracts `data.model`/`thinkingLevel`/`sessionFile`/`sessionName`) → `touch(true)` → `broadcastUpdated()` → `live_session_updated`; the client's `liveSessionUpdated` listener (`app-main.ts:382-386`) re-renders the tab (via `liveTabSignature`) and updates the model picker (`applyActiveSessionMetadata` → `setModelState`). The missing piece is simply asking pi for its state at startup.

Decision (confirmed with user): fire-and-forget, not blocking — the tab appears instantly as today and the label self-corrects as soon as pi answers (~0.5–2s of pi startup), consistent with the codebase's explicit non-blocking philosophy (`server-main.ts:321-329`).

## Change

### `src/server/sessions.ts` — `PiRpcSession.start()` (lines 192-196)

Extend the existing 250 ms startup setTimeout to also send a `get_state` probe before the stats probe:

```ts
setTimeout(() => {
  this.send({ type: 'get_state' }, { timeoutMs: 5000 }).catch(() => {});
  this.send({ type: 'get_session_stats' }, { timeoutMs: 5000 }).catch(() => {});
}, 250);
```

Update the comment above to say the `get_state` probe populates model/thinking level (and session file/name) so the tab shows the real model without waiting for the first message, and that a response arriving after the 5 s ack timeout is still processed (`handleResponse` calls `updateStateFromResponse` unconditionally).

Notes on details already validated:
- Keep it inside the 250 ms setTimeout (not immediately after the 100 ms settle): functionally equivalent (stdin is pipe-buffered), and it keeps http-routes tests — whose fake children end stdin right away under real timers — rejecting the probe instantly instead of parking pending timers.
- The `if (data.model)` guard in `updateStateFromResponse` is correct here: `model: null` from get_state keeps the parsed-spec model (or the null placeholder).
- Unsolicited response broadcast to websocket clients is safe: client `handleRPCEvent` has no `'response'` case and the existing startup `get_session_stats` already exercises this exact path.
- No client-side changes.

### Tests

`test/pi-rpc-session.test.ts` — add one test: **startup get_state response populates model and broadcasts live_session_updated**.
- Mock timers; fake spawn whose stdin stub records writes (`{writable: true, write(d, cb){writes.push(d); cb?.()}}`) and whose stdout is a PassThrough.
- `create(...)`, tick 100 ms, await start, tick 250 ms; assert writes contain both a `get_state` and a `get_session_stats` command; capture the `get_state` id.
- Feed a `{"type":"response","id":<id>,"command":"get_state","success":true,"data":{"model":{"provider":"anthropic","id":"claude-opus"},"thinkingLevel":"medium"}}` line into stdout; flush with `await new Promise(setImmediate)` (stream events are nextTick-driven, not covered by mocked timers).
- Assert `session.model` is the normalized `{provider, id}` object, `session.thinkingLevel === 'medium'`, and a `live_session_updated` broadcast carried the model and a non-empty `modelLabel`.

Optionally extend the existing `updateStateFromResponse stores a full {provider,id} object` test (around line 306) with a `data: {model: null}` response asserting the prior model is retained.

No existing tests break (verified: the mock-timer tests only tick to 100 ms; http-routes fake children treat the extra probe like the existing one). Tweak the comment at `test/http-routes.test.ts:479-480` that mentions only the "250ms get_session_stats probe".

## Verification

1. Build and run `node --test test/` — all green, including the new test.
2. Manual: start tau, open a new tab **without** typing a model → tab label and model picker show pi's default model within ~1–2 s, before any message is sent. Resume an old session that used a non-default model → that model shows immediately.
3. Regression: send a prompt and change the model via the picker — the label still updates correctly (existing `refreshSessionModel` path untouched).
