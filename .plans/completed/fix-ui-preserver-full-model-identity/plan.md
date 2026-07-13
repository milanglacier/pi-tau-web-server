# Plan: Authoritative model/thinking identity — canonical server, no assistant-stream overwrites, no merge ternaries, extension-safe

## Goal

Ensure the UI's model identity (`provider/model:thinking-level`) is **always complete and current** and can never be downgraded or stale — across **all** browsers viewing a session, and including model changes driven by **extensions** (e.g. the `pi-session-model` extension's `/session-model` slash command). Then **simplify** by making the server canonical so the client assigns directly instead of merging. Finally, **rewrite the `AGENTS.md` note** because its current framing (inconsistent/partial payloads, "preserve known identity") describes the merge-defensive world this implementation removes, and would mislead future agents.

## Architecture facts (verified)

**tau is multi-client.** `bin/tau.js` `LiveSessionManager.broadcast` → all WS clients (`client.send`, line 432). Multiple browsers can share one live session. So the client's `live_session_updated` receiver (`applyActiveSessionMetadata`) **must stay** — it is the cross-browser sync path. The simplification is "make the server canonical so the receiver assigns directly", not "remove the receiver".

**pi does NOT emit runtime `xxx_changed` stream events for model/thinking** (verified in `/Users/northyear/.local/share/pi/docs/`). `model_change`/`thinking_level_change` in `session-format.md` are *session-file entry types*, not runtime RPC stream events. Runtime events (`rpc.md` § Events) are only agent/turn/message/tool/queue/compaction/auto_retry/extension_error. Authoritative model/thinking signals are the **RPC command responses**: `set_model`/`cycle_model`/`get_state` return a full `Model` object `{id, provider, contextWindow, ...}`; `cycle_thinking_level` returns `data.level`; **`set_thinking_level` returns NO data**. `message_end` carries `event.message.model` as a **bare id string** describing which model produced that message, not a selection change.

**tau's `get_state` is local** (`bin/tau.js:597`): returns tau's tracked `session.model`/`session.thinkingLevel`, not forwarded to pi. So tau's tracked state must be kept correct and current.

## Extension-driven model changes (the new gap)

The `pi-session-model` extension (`/session-model <ref>[:level]`) is sent as a **`prompt`** command. Its handler calls `pi.setModel(...)` and `pi.setThinkingLevel(...)` — the same internal APIs as the `set_model`/`set_thinking_level` RPC commands — then returns **without an LLM turn** (no `agent_start`/`agent_end`). Consequences today:

- pi's `prompt` response is `success:true` with **no `data.model`/`data.level`**.
- tau's `updateStateFromResponse` (324–326) only updates `this.model`/`this.thinkingLevel` when those fields are present → **they stay stale**.
- No streaming event carries the new model → tau never learns it changed.
- `broadcastUpdated` (fired by `touch(true)` in `updateStateFromResponse`) echoes the **stale** model to all browsers.
- Result: the model input box shows the old model across all clients; the invariant ("always complete") is technically preserved (object form) but the value is **wrong/stale**.

The same applies to any extension that calls `pi.setModel`/`pi.setThinkingLevel` during `prompt`/`steer`/`follow_up` (the commands that can run extension side-effects, per rpc.md: extension commands execute immediately even during streaming).

**Fix:** after a `prompt`/`steer`/`follow_up` ack, the server fires a follow-up `get_state` to pi and refreshes `session.model`/`session.thinkingLevel`, then `broadcastUpdated`. pi's `get_state` returns the post-extension current model, so tau becomes correct. This is fire-and-forget (does not block the HTTP response to the originating client); the refresh arrives at all clients via `live_session_updated`. This covers all extension-driven model/thinking changes, not just `/session-model`.

## Root causes (full inventory)

### Server `bin/tau.js`
- **Line 350** (`handleEvent`, `message_end`): `if (event.message.model) this.model = event.message.model` — overwrites the full `{provider,id}` object with a bare string on every assistant message. Root-cause downgrade; propagates to all clients via `broadcastUpdated`.
- **Extension-driven change invisibility** (above): `prompt`/`steer`/`follow_up` acks carry no model data; tau goes stale.
- **`set_thinking_level` echo gap**: `set_thinking_level` is forwarded to pi but pi's response has no `level`/`thinkingLevel`, so `updateStateFromResponse` (325–326) never updates `this.thinkingLevel`. Yet `touch(true)`→`broadcastUpdated` echoes the **stale** level to all clients, reverting a client's just-set optimistic level.
- **Lines 340–341**: handlers for `thinking_level_changed` and `model_select` — pi never emits these runtime event names. Dead code.
- **Line 155** (constructor): `this.model = this.modelSpec || null` — initial state is a raw spec string (may include `:level`), not canonical.
- `updateStateFromResponse` (324–330): `this.model = data.model` for `set_model`/`cycle_model` is fine (pi returns a full object). The `else if (data.provider && data.id) this.model = data` branch is a defensive guard — keep.

### Client `public/app.js`
- **`applyActiveSessionMetadata` (482–483)**: `currentModelId = session.model || session.modelLabel || session.modelSpec || ''`. Called from `live_session_updated`, `selectLiveSession`, `pollInstances`. **Stays** (multi-client sync); the `modelLabel`/`modelSpec` fallbacks are merge-era cruft — once the server is canonical, `session.model` is object-or-null and this collapses to `currentModelId = session.model || ''`.
- **`handleMirrorSync` (1717–1733)** and **`fetchModelInfo` (1441–1472)**: initial-load paths with defensive merge ternaries (the "merge things" the user questions). `fetchModelInfo` also has a **dead** `availableModels.find(m => m.id === currentModelId)` lookup — `get_available_models` always returns `[]` (`bin/tau.js:559`), so `contextWindowSize` is never set there (it's set in `handleMirrorSync`/`applyModelInput`).
- **`applyModelInput` (1388–1404)** and **settings `btnThinkingLevel` click (2148–2153)**: set state from the `set_model`/`set_thinking_level`/`cycle_thinking_level` RPC response (user-typing path). Authoritative — keep.
- **`openSettings` (2108)**: sets `currentThinkingLevel` from `get_state` — initial-load, keep.
- **`modelDisplayString()` (1284)**: object branch (primary) + string branch (defensive fallback). With the invariant, `currentModelId` is always object-or-`''`, so the string branch is unreachable in practice.

### Tests `test/pi-rpc-session.test.js`
- Lines 50–56 assert `thinking_level_changed` / `model_select` update state (dead-code behavior).
- Lines 70–78 assert `message_end` sets `session.model = { id: 'gpt-5.5' }` (downgrade bug).

### `AGENTS.md`
- The "Preserve full model identity in the UI" section describes the **old** world: "server RPC payloads … inconsistent", "partial payload as authoritative", "preserve … known model identity". After this implementation the server is canonical (no partial payloads, no merge), so this framing is **outdated and must be rewritten**, not appended to.

## Design: canonical server, two authoritative client paths, extension-refresh, no merge

**Server invariants:**
- `this.model` is always `null` or a full `{provider, id, ...}` object — never a bare string.
- `this.thinkingLevel` is always a known level and kept current for `set_thinking_level` (which pi doesn't echo) and for extension-driven changes (via post-prompt `get_state`).

**Client invariants:**
- `currentModelId` is always `''` or a full `{provider, id}` object — never a bare string.
- `currentThinkingLevel` is always a known level.

**Two authoritative client update paths (both write the same canonical form, so they never conflict):**
1. **User input** — `applyModelInput` / settings thinking button set state from the RPC response (optimistic, immediate).
2. **Server broadcast / snapshot** — `applyActiveSessionMetadata` (`live_session_updated`, multi-client + `pollInstances` WS-miss fallback), `handleMirrorSync` (snapshot on connect/tab switch), `fetchModelInfo`/`openSettings` (`get_state` initial load). This is the real equivalent of the nonexistent `xxx_changed` stream, and it carries multi-client + extension-driven updates.

**Forbidden path:** the assistant message stream (`message_end` etc.) never updates model identity — guaranteed by the **server** fix (delete line 350), so no client guard is needed.

**Extension-refresh path (new):** after `prompt`/`steer`/`follow_up` acks, the server refreshes `session.model`/`session.thinkingLevel` from pi's `get_state` and `broadcastUpdated`. This is how extension-driven changes (e.g. `/session-model`) propagate to tau and all clients.

Because the server is canonical, the client's object-vs-string merge ternaries and `modelLabel`/`modelSpec` string fallbacks all collapse to direct assignment (`x = data.model || ''`). The merge logic is deleted, not layered with more guards.

## Implementation steps

### 1. Server `bin/tau.js` — canonical model/thinking + extension refresh

- **Delete the `message_end` model overwrite** (line 350: remove `if (event.message.model) this.model = event.message.model`). Keep the `usage` → `contextUsage` update.
- **Delete dead event handlers** (lines 340–341: `thinking_level_changed` and `model_select`).
- **Add `normalizeModel(value)` + `parseModelSpecToModel(spec)` helpers.** `normalizeModel`: full Model object → keep; `provider/id` string → `{provider, id}`; else `null`. `parseModelSpecToModel`: parse `provider/id[:level]` into `{provider, id}` (+ level). Use `normalizeModel` at every `this.model =` site so the invariant holds even for string inputs.
- **Canonicalize the constructor** (line 155): `this.model = parseModelSpecToModel(this.modelSpec)`; set `this.thinkingLevel` from the spec's `:level` if present.
- **Fix `set_thinking_level` echo**: in `handleRpcCommand`, for `cmd === 'set_thinking_level'`, capture `const prev = session.thinkingLevel`, set `session.thinkingLevel = command.level` before `session.send(command, ...)`. If pi returns `success: false`, restore `session.thinkingLevel = prev`. The subsequent `touch(true)`→`broadcastUpdated` then echoes the correct level.
- **Add extension-refresh for `prompt`/`steer`/`follow_up`**: in `handleRpcCommand`, after `await session.send(command, ...)` succeeds for these three commands, fire a fire-and-forget `refreshSessionModel(session)` that calls `session.send({ type: 'get_state' })`, applies `session.model = normalizeModel(data.model)` and `session.thinkingLevel = data.thinkingLevel || session.thinkingLevel`, then `manager.broadcastUpdated(session.id)`. Do NOT block the HTTP response — return the original prompt response first, then refresh. This makes extension-driven changes (e.g. `/session-model`) visible to tau and all clients. (If `get_state` fails, silently skip — the next user input or snapshot will resync.)
- `modelLabel()` (line 132) stays for `metadata().modelLabel` (simplifies since input is always object-or-null).
- Keep `updateStateFromResponse`'s `set_model`/`cycle_model` object assignment + the `else if (data.provider && data.id)` guard.

### 2. Client `public/app.js` — assign directly, drop merges, fix multi-slash model parsing

- **`applyActiveSessionMetadata` (482–483)** — KEEP (multi-client sync). Simplify to `currentModelId = session.model || ''; currentThinkingLevel = session.thinkingLevel || 'off'; updateModelDisplay();`. Remove `modelLabel`/`modelSpec` fallbacks.
- **`selectLiveSession` (451)** and **`pollInstances` (1781)** — keep their `applyActiveSessionMetadata(...)` calls (sync paths). No change.
- **`handleMirrorSync` (1717–1733)** — replace merge ternary with `currentModelId = data.model || ''`; keep `contextWindowSize = data.model?.contextWindow`; `currentThinkingLevel = data.thinkingLevel || 'off'`.
- **`fetchModelInfo` (1441–1472)** — `currentModelId = stateData.data.model || ''`; `currentThinkingLevel = stateData.data.thinkingLevel || 'off'`. **Remove the dead `availableModels.find(...)` block.** For context-window, read `stateData.data.model?.contextWindow` directly (tau's `session.model` may carry it after `set_model`); otherwise rely on `handleMirrorSync`/`applyModelInput`.
- **`parseModelSpec(raw)`** — **FIXED**: The old regex `([^\/:]+)` rejected `/` in model IDs, making it impossible to input models like `openrouter/z-ai/glm-5.2:high`. Replaced with explicit string slicing: splits on the first `/` for provider, then checks the last `:` for a valid thinking level suffix. Model IDs with embedded slashes (e.g. OpenRouter `z-ai/glm-5.2`) are now accepted.
- **`modelDisplayString()`** — Added explanatory comment about first-slash-split semantics for the legacy string fallback path. The object branch (primary path) was already correct — it emits `${provider}/${modelId}:${level}` directly, which preserves multi-slash model IDs in the display.
- **`applyModelInput` (1388–1404)** and **settings `btnThinkingLevel` click (2148–2153)** — keep (user-input authoritative). Now backed by correct echoes + extension-refresh, so optimistic set and `live_session_updated` echo write the same value — no race, no revert.
- **`openSettings` (2108)** — keep (initial-load via `get_state`).

### 3. Tests `test/pi-rpc-session.test.js`

- Replace the `thinking_level_changed and model_select update state` test (50–56): assert these event types are **ignored** (state unchanged) since handlers are deleted — or remove.
- Replace the `assistant message_end tracks entry and records model + usage` test (70–78): set `session.model` to a known full object beforehand, send `message_end` with a bare `model` string, assert `session.model` is **unchanged** (only `contextUsage.usage` recorded).
- Add: `updateStateFromResponse` for `set_model`/`cycle_model` stores full `{provider,id}` and never a bare string; `parseModelSpecToModel` parses `provider/id:level`; `normalizeModel` parses a `provider/id` string into an object.
- Add: `set_thinking_level` echo fix — after a successful `set_thinking_level` (mock pi `{success:true}` no data), `session.thinkingLevel` equals the command's level (not stale).
- Add: extension-refresh — after a `prompt`/`steer`/`follow_up` ack (mock pi `get_state` returning a new model), `session.model`/`session.thinkingLevel` are refreshed from `get_state` and `broadcastUpdated` is emitted with the new values. (Requires `handleRpcCommand` to be testable; it's already exported at line 1145 with `liveManager` — wire mocks similarly to existing tests.)
- **Added**: multi-slash model name tests — `normalizeModel('openrouter/z-ai/glm-5.2')` correctly produces `{provider: 'openrouter', id: 'z-ai/glm-5.2'}` (splits on first `/` only); `parseModelSpecToModel('openrouter/z-ai/glm-5.2:high')` correctly separates provider (`openrouter`), model id (`z-ai/glm-5.2`), and level (`high`).
- No client JS test harness exists; client `parseModelSpec` behavior verified manually per the checklist.

### 4. Rewrite `AGENTS.md` "Preserve full model identity in the UI" section

**Replace the entire current section** (the "Context"/"Invariant" block about inconsistent/partial payloads and "preserve known identity") with a new note written at the outcome level, per the project's "Writing AGENTS.md notes" guidance (no granular patch instructions). The new note captures the post-implementation reality so future agents don't reintroduce merge logic or re-downgrade from the assistant stream. Proposed replacement text:

> ## Keep model identity canonical and current
>
> Context: tau is multi-client — multiple browsers can share one live Pi session, so model/thinking state must stay correct across all of them and across all the ways it can change. pi does NOT emit runtime stream events for model/thinking changes (`model_change`/`thinking_level_change` are session-file entries, not RPC stream events); the authoritative signals are RPC command responses (`set_model`/`cycle_model`/`get_state` return a full Model object; `cycle_thinking_level` returns the level; `set_thinking_level` returns no data) and tau's own tracked state. `message_end` carries a bare model id that describes which model produced that message, not a selection change — it must not overwrite the selected model. Extensions can change the model mid-session by calling `pi.setModel`/`pi.setThinkingLevel` inside a `prompt`/`steer`/`follow_up` (e.g. the `pi-session-model` `/session-model` command); those acks carry no model data and emit no stream event, so tau refreshes from `get_state` after such acks.
>
> Invariants:
> - On the server (`bin/tau.js`), `session.model` is always `null` or a full `{provider, id, ...}` object — never a bare string — and `session.thinkingLevel` is always a known level and kept current (including for `set_thinking_level`, whose pi response omits the level, and for extension-driven changes via post-ack `get_state`).
> - On the client (`public/app.js`), `currentModelId` is always `''` or a full `{provider, id}` object — never a bare string — and `currentThinkingLevel` is always a known level. The model input always renders `provider/model:thinking-level` when a model is selected.
> - Model identity is updated only from (a) user-input RPC responses (`set_model`/`cycle_model`/`set_thinking_level`/`cycle_thinking_level`) and (b) server broadcasts/snapshots (`live_session_updated`/`mirrorSync`/`get_state`). The assistant message stream never updates it. There is intentionally no "merge" of partial payloads — the server is canonical, so the client assigns directly (`currentModelId = data.model || ''`). Do not reintroduce object-vs-string merge ternaries or `modelLabel`/`modelSpec` string fallbacks; they were removed because the server is now always canonical.
> - `live_session_updated` (handled by `applyActiveSessionMetadata`) is the multi-client + extension sync path and must remain; do not remove it to "simplify".
>
> Common regression to avoid: re-adding `this.model = event.message.model` on `message_end`, or re-adding client-side merge logic to "handle partial payloads" — both recreate the old downgrade/stale bugs that this design removes.

Keep the existing "# Writing AGENTS.md notes" section unchanged (it's general guidance).

## What gets simpler (answers the user's question)

- The "merge things" (object-vs-string ternaries in `handleMirrorSync`/`fetchModelInfo`/`applyActiveSessionMetadata`, plus `modelLabel`/`modelSpec` fallbacks) are **deleted** — the server is canonical, so the client just assigns `x = data.model || ''`.
- The assistant message stream no longer touches model identity (one server-side deletion at `bin/tau.js:350`), so no client guard is needed.
- Dead code removed: `thinking_level_changed`/`model_select` handlers, the `availableModels.find` lookup in `fetchModelInfo`.
- What stays (correctly): `applyActiveSessionMetadata` as the `live_session_updated` receiver — because multiple browsers can share a session, this is how user A's model change (or an extension's change) reaches user B. The user-input optimistic sets in `applyModelInput`/settings stay as the "user typed" path, now backed by correct echoes + extension-refresh (no revert race).

## Multi-client + extension behavior

- User A changes model in browser 1 via the input box → `set_model` HTTP → server `session.model = fullObject` → `broadcastUpdated` → all browsers `applyActiveSessionMetadata` set `currentModelId = fullObject`. ✓
- User A changes thinking level via `:level` → `set_thinking_level` HTTP → server records `session.thinkingLevel = level` (echo fix) → `broadcastUpdated` echoes correct level to all browsers. ✓
- **Any user runs `/session-model openai/gpt-4o:high`** → `prompt` HTTP → server forwards to pi → extension calls `pi.setModel`/`pi.setThinkingLevel` → pi acks (no model data) → server fire-and-forget `get_state` → refreshes `session.model`/`session.thinkingLevel` → `broadcastUpdated` → all browsers show the new `provider/model:level`. ✓ (Previously: stale old model everywhere.)
- No trade-off: cross-browser + extension sync works via `live_session_updated` + post-prompt `get_state` refresh, both retained/added.

## Files touched

- `bin/tau.js` — server canonicalization (delete `message_end` overwrite + dead handlers; fix `set_thinking_level` echo; canonicalize constructor + `normalizeModel`); add post-prompt/steer/follow_up `get_state` refresh for extension-driven changes.
- `public/app.js` — drop merge ternaries + dead lookup; assign directly; keep `applyActiveSessionMetadata`/`pollInstances` sync paths.
- `test/pi-rpc-session.test.js` — update/replace tests; add canonicalization + thinking-echo + extension-refresh tests.
- `AGENTS.md` — **replace** the "Preserve full model identity in the UI" section with the new "Keep model identity canonical and current" note (full proposed text above); keep the "# Writing AGENTS.md notes" section.

## Verification

- `node test/pi-rpc-session.test.js` passes.
- Manual, single browser: change model via input box → display stays `provider/model:level` through a full assistant turn (previously downgraded to bare `model:level` after `message_end`). Change thinking level via `:level` → holds across an assistant turn (previously could revert via stale echo). Switch tabs and back → identity preserved. Open settings, cycle thinking → persists.
- Manual, extension: install `pi-session-model`, run `/session-model openai/gpt-4o:high` → model input box updates to `openai/gpt-4o:high` (previously stayed at the old model). Run a normal prompt afterward → display stays correct (no `message_end` downgrade).
- Manual, multi-browser: two browsers on the same tau server/session. In browser 1 change model → browser 2 updates to full `provider/model:level`. In browser 1 run `/session-model ...` → browser 2 updates. In browser 1 change thinking level → browser 2 updates. Confirm no bare-id downgrade in any case.
