# Review: feat/single-model-input-box

Branch: `feat/single-model-input-box` (1 commit: `caa897e`)
Base: `ffafbb2` (merge-base with `main`)
Files changed: `public/index.html`, `public/style.css`, `public/app.js`

## Findings

### 1. Sync points drop the provider, so the input shows a provider-less string that fails its own validation

`applyActiveSessionMetadata`, `handleMirrorSync`, and `fetchModelInfo` all reduce an
object-shaped model to its bare `.id`, discarding `provider`:

```js
// applyActiveSessionMetadata (line 439)
currentModelId = session.model?.id || session.modelLabel || session.modelSpec || '';
// handleMirrorSync (line 1639)
currentModelId = (typeof data.model === 'string' ? data.model : data.model?.id) || ...;
// fetchModelInfo (line 1380)
currentModelId = typeof stateModel === 'string' ? stateModel : (stateModel.id || stateModel.name || '');
```

`bin/tau.js` stores `session.model` as `{ provider, id }` once a `set_model` /
`model_select` / `message_end` event arrives (lines 324, 330, 341, 350), and
`metadata()` (line 174) passes that object straight to the client. So after any
model change, `currentModelId` becomes e.g. `"claude-sonnet-4-20250514"` with no
provider.

`modelDisplayString()` (line 1246) then has no provider to emit, so it returns
`claude-sonnet-4-20250514:off` — no `/`. That string violates the very format the
placeholder advertises (`provider/model:thinking`). Worse, `parseModelSpec`
(line 1283) requires a `/` via `^([^\/:]+)\/([^\/:]+)...`, so the next time the
user focuses the box and blurs (or presses Enter/Escape — see finding 2),
`applyModelInput` parses the current display value, fails with "Use format
provider/model[:thinking]", slaps on `.invalid`, and reverts to the same bad
string — leaving a persistent red border for a session the user never tried to
edit.

Note `modelDisplayString` already has a correct object branch
(`typeof currentModelId === 'object'`); the sync points just never feed it an
object. Either keep the object (`currentModelId = data.model || ...`) or fall
back to `modelLabel` (which `modelLabel()` in `bin/tau.js` already formats as
`provider/id`) before extracting `.id`.

**Location:**
- `public/app.js:439` (`applyActiveSessionMetadata`)
- `public/app.js:1378` (`fetchModelInfo`)
- `public/app.js:1639` (`handleMirrorSync`)

### 2. `blur` always commits, sending RPCs even when the value is unchanged (and on Escape)

The `blur` listener unconditionally calls `applyModelInput()`:

```js
modelInput.addEventListener('blur', () => {
  delete modelInput.dataset.editing;
  applyModelInput();
});
```

`applyModelInput` (line 1296) never checks whether the input's value differs
from the current display; it parses and fires `set_model` (and, when a `:level`
suffix is present, `set_thinking_level`) regardless. So merely clicking into the
box and clicking away — no edit at all — triggers a server round trip and a
"Switching to …" / "Setting thinking…" status flash.

Escape is worse: the `keydown` handler reverts the value to `modelDisplayString()`
and then calls `modelInput.blur()`, which fires `applyModelInput` on the reverted
value. The plan explicitly specifies "Escape while editing → revert + blur" with
no apply; the implementation instead re-commits the current model + thinking
level over the network on every Escape.

Fix: bail early in `applyModelInput` when `modelInput.value.trim() ===
modelDisplayString()` (and skip the blur-driven apply on Escape, e.g. by setting
a transient flag before `.blur()`).

**Location:** `public/app.js:1359-1367` (blur handler), `public/app.js:1296`
(`applyModelInput`), `public/app.js:1351-1357` (Escape branch).

### 3. `.invalid` border stays on the reverted (valid) value

On a parse or RPC error, `applyModelInput` adds `.invalid` and then immediately
reverts `modelInput.value` to the last-good display string:

```js
modelInput.classList.add('invalid');
statusText.textContent = parsed.error;
...
modelInput.value = modelDisplayString();
```

The status text error auto-clears after 3s, but the red border remains on an
otherwise-correct-looking value until the next focus. The error signal and the
field it's attached to are now inconsistent (red border on a valid value with no
status text). Either clear `.invalid` after the revert, or drop the class once
the status message clears.

**Location:** `public/app.js:1304-1309` and `public/app.js:1335-1341`.

## Overall

**Verdict: needs revision.**

**Explanation:** The UI swap itself is clean and the CSS/HTML changes are fine,
but the new display+validation contract assumes `provider/model:thinking` while
the three model-sync sites strip the provider, so any session whose model is
object-shaped ends up with a provider-less input that trips its own validator on
the first interaction. Combined with the blur-always-commits behavior, routine
focus/blur and Escape produce spurious errors and unnecessary RPCs. Fixing
findings 1 and 2 is required; finding 3 is a small polish.

---

## Fix summaries (applied post-review)

All three findings addressed in `public/app.js`; `node --check` passes and the
full `npm test` suite is green (115/115).

### Fix 1 — Preserve the `{provider,id}` object at model sync points

The three sync sites no longer flatten object models to a bare `.id`:

- `applyActiveSessionMetadata` (`public/app.js:438`):
  `currentModelId = session.model || session.modelLabel || session.modelSpec || ''`
  — keeps the full object; `modelLabel` (already `provider/id` shaped) and
  `modelSpec` remain as string fallbacks.
- `fetchModelInfo` (`public/app.js:1378`):
  `currentModelId = (typeof stateModel === 'object' && stateModel) ? stateModel : (typeof stateModel === 'string' ? stateModel : '')`
  — preserves the object form, only flattening when the server sent a string.
- `handleMirrorSync` (`public/app.js:1638`):
  same object-preserving ternary, with `modelLabel`/`modelSpec` as fallbacks.

`modelDisplayString()` already had a correct object branch, so it now renders
`provider/model:level` instead of a provider-less `model:level` that would fail
`parseModelSpec` on the next interaction.

### Fix 2 — Skip apply when unchanged; Escape cancels without committing

- `applyModelInput` (`public/app.js:1300`) now bails early when
  `modelInput.value.trim() === modelDisplayString()` — a focus/blur with no edit
  no longer fires `set_model` / `set_thinking_level` RPCs or a status flash.
- A module-level `suppressBlurApply` flag is set in the Escape `keydown` handler
  before `modelInput.blur()` and consumed/cleared in the blur listener
  (`public/app.js:1369-1389`), so Escape reverts the value and blurs without
  re-committing the current model/thinking over the network — matching the
  plan's "Escape → revert + blur (no apply)".

### Fix 3 — Clear `.invalid` once the status error clears

Both error branches in `applyModelInput` (parse error at `public/app.js:1313`,
RPC failure at `public/app.js:1355`) now schedule
`setTimeout(() => modelInput.classList.remove('invalid'), 3000)` alongside the
existing status-clear timeout, so the red border is removed at the same time
the status message reverts — no lingering `.invalid` on a valid reverted value.

---

# Round 2 Review

Branch: `feat/single-model-input-box` (now 2 commits vs `main`: `caa897e`, `a06faa4`)
Scope: re-review of the fix commit `a06faa4` ("fix: resolve review findings for
single model input box") plus a full re-scan of the final state of
`public/index.html`, `public/style.css`, `public/app.js`.
Verification: `node --check public/app.js` passes; `npm test` is green
(115/115); `rg` for the removed identifiers (`modelDropdown`, `thinkingBtn`,
`updateModelLabel`, `updateThinkingBtn`, `model-dropdown`, `thinking-tag`)
returns zero matches in `public/`.

## Verification of Round-1 fixes

### Fix 1 — verified

All three sync sites now preserve the `{provider,id}` object form instead of
flattening to `.id`:

- `applyActiveSessionMetadata` (`public/app.js:442`):
  `currentModelId = session.model || session.modelLabel || session.modelSpec || ''`
  — the `modelLabel`/`modelSpec` string fallbacks are still `provider/id`-shaped
  (per `modelLabel()` in `bin/tau.js:132-138`), so `modelDisplayString()`'s
  string branch handles them correctly.
- `fetchModelInfo` (`public/app.js:1400`) and `handleMirrorSync`
  (`public/app.js:1663`) use the object-preserving ternary and correctly
  reject `null` (`typeof null === 'object'` but `null` is falsy, so they fall
  through to the string/modelLabel branch).

Confirmed against `bin/tau.js`: `session.model` starts as `modelSpec` (string)
or `null` and becomes the full object once `set_model` / `model_select` /
`message_end` arrives (`bin/tau.js:155, 323-324, 340-341`). End-to-end the
input now renders `provider/model:level` for object-shaped models, which
`parseModelSpec` accepts on the next interaction.

### Fix 2 — verified

- `applyModelInput` (`public/app.js:1300`) bails early when
  `modelInput.value.trim() === modelDisplayString()`, so a plain focus→blur
  with no edit no longer fires `set_model`/`set_thinking_level` or a status
  flash. Combined with Fix 1, this also eliminates the residual red-border
  scenario from Round-1 finding 1: even if a display string ever lacked a
  `/`, an unchanged focus→blur is now a no-op rather than a parse attempt.
- The `suppressBlurApply` flag is set in the Escape handler immediately before
  `modelInput.blur()` and consumed in the blur listener
  (`public/app.js:1378-1392`). Escape reverts the value, clears `.invalid`,
  and blurs without re-committing — matching the plan.

Enter still works because `keydown` Enter calls `modelInput.blur()`, which
fires the blur listener and thus `applyModelInput` on the (edited) value.

### Fix 3 — verified

Both error branches schedule `setTimeout(() => modelInput.classList.remove('invalid'), 3000)`
(`public/app.js:1320` and `public/app.js:1361`), so the red border clears in
lockstep with the status text. The `focus` handler
(`public/app.js:1390`) also clears `.invalid`, giving an additional manual
escape hatch.

## New findings introduced by the fix commit

None.

I looked specifically for:
- Regressions from `currentModelId` now being an object: the only other
  consumer is `availableModels.find(m => m.id === currentModelId)`
  (`public/app.js:1402`), which can no longer match — but `get_available_models`
  is intercepted to return `models: []` (`bin/tau.js:557`), so `availableModels`
  is always empty and that `.find` was already a no-op. Not a regression.
- Async races in `applyModelInput` (fire-and-forget from the blur listener):
  the pattern matches the existing `rpcCommand` usage elsewhere in the file,
  and a mid-`await` mirror sync only causes a brief revert-flicker before the
  success path re-renders the new model. No correctness impact.
- The no-live-session branch (`public/app.js:1307-1312`) not clearing
  `.invalid`: unreachable in practice because `modelInput.disabled =
  !hasLiveSession` (`public/app.js:1748`) prevents focus/blur when no session
  is active.
- `handleRPCEvent` (`public/app.js:533`) still does not handle
  `thinking_level_changed` / `model_select` events. This is pre-existing (the
  old `updateThinkingBtn` had the same gap) and out of scope for this change.

## Overall

**Verdict: correct as-is.**

**Explanation:** All three Round-1 findings are resolved correctly, no new
bugs are introduced, the removed-widget identifiers leave no dangling
references, and the full test suite passes. The branch is ready to merge.

---

# Round 2 — Appendix: deferred-regression analysis

The Round-2 summary dismissed four items in a single sentence. Per request,
this appendix expands each with the evidence used to dismiss it (file paths,
line numbers, control-flow reasoning) so the dismissal is auditable rather
than asserted. None change the verdict; one is recorded as a non-blocking
nit (A4) because it is more relevant now that the input is the single source
of truth.

## A1. Dead `availableModels.find(...)` after `currentModelId` becomes an object

**Claim.** `fetchModelInfo` still runs `availableModels.find(m => m.id === currentModelId)`
(`public/app.js:1402`), but `currentModelId` is now frequently an object
(`{provider,id}`), so a strict `===` against the string `m.id` can never match,
and the `model?.contextWindow` update on the next line is dead.

**Why it is not a regression.**
- `get_available_models` is intercepted by the Tau server and always returns
  `models: []` (`bin/tau.js:557`), so `availableModels` is always empty
  (`public/app.js:1394`). The `.find` was already a no-op before this branch;
  the object-vs-string change does not make a working lookup stop working.
- Context window is still populated via two other live paths:
  `applyModelInput` success (`public/app.js:1342`, `data.contextWindow`) and
  `handleMirrorSync` (`public/app.js:1667`, `data.model?.contextWindow`).
- The plan explicitly scoped this as harmless to leave
  ("`fetchModelInfo`'s use of `availableModels` can stay (harmless)").

**Disposition.** Not a finding. Optional cleanup: drop `availableModels`, the
`get_available_models` fetch, and the `.find` block — they are vestigial now
that the UI no longer renders a model list.

## A2. Async races in `applyModelInput` (fire-and-forget from `blur`)

**Claim.** The `blur` listener calls `applyModelInput()` without `await`
(`public/app.js:1392`), and `applyModelInput` awaits two RPCs
(`set_model`, then `set_thinking_level`) sequentially
(`public/app.js:1322`, `1336`). Concurrent edits could race.

**Two scenarios examined.**

*Double Enter / Enter-then-blur with two edits.* Two `set_model` RPCs go in
flight with distinct ids. `rpcCommand` resolves each by its own `id`
(`bin/tau.js:306-313`), and Pi processes stdin commands in arrival order, so
responses return in the same order the client sent them. Each success branch
reassigns `currentModelId` and calls `updateModelDisplay()`
(`public/app.js:1329-1349`), so the final `currentModelId` matches the last
RPC the server applied. Converges correctly; worst case a one-frame flicker.

*Server push during the await.* While `applyModelInput` is awaiting
`set_model`, a `mirrorSync` / `liveSessionUpdated` can fire
`handleMirrorSync` / `applyActiveSessionMetadata`, which reassign
`currentModelId` to the (old) server value and call `updateModelDisplay()`.
The `editing` guard does not block this — the `blur` handler deleted
`dataset.editing` before calling `applyModelInput` (`public/app.js:1390-1392`),
so `updateModelDisplay`'s early return (`public/app.js:1273`) does not fire.
The input briefly reverts, then `applyModelInput`'s success path overwrites
it with the new model. Converges to the user's choice.

**Why it is not a finding.** The old dropdown's item-click handler was the
same async fire-and-forget shape (deleted in this diff: the old
`el.addEventListener('click', async () => { ... await rpcCommand(...) ...})`
inside `openModelDropdown`). The new code matches the existing concurrency
discipline in the file; tightening it (e.g. an in-flight token) would exceed
the surrounding standard (guideline 3).

**Disposition.** Not a finding.

## A3. No-live-session branch does not clear `.invalid`

**Claim.** The `!viewingActiveSession || !activeLiveSessionId` branch
(`public/app.js:1307-1312`) reverts the value and shows a status message but,
unlike the two error branches, does not schedule a
`setTimeout(... .remove('invalid'), 3000)`. If `.invalid` were already set,
it would linger.

**Why it is unreachable in practice.**
- `updateMirrorInputState` sets `modelInput.disabled = !hasLiveSession` where
  `hasLiveSession = viewingActiveSession && !!activeLiveSessionId`
  (`public/app.js:1735-1748`). A disabled input cannot receive `focus`,
`blur`, or `keydown` events from user interaction, so neither `applyModelInput`
call site (Enter/blur) can fire when no session is active.
- No code calls `modelInput.focus()` / `.blur()` programmatically
  (`rg -n "modelInput\.(focus|blur)" public/app.js` returns only the
  `keydown`-driven `.blur()` calls, which themselves require a focused, i.e.
  enabled, input).
- Even if it were reached, the first guard
  `if (modelInput.value.trim() === modelDisplayString()) return`
  (`public/app.js:1300`) fires first: with no session, `currentModelId === ''`,
  `modelDisplayString()` returns `''`, and a disabled input's value is `''`,
  so it returns before the no-live-session branch.

**Disposition.** Not a finding. Double-guarded (disabled state + early-bail).

## A4. `handleRPCEvent` ignores `model_select` / `thinking_level_changed` / `message_end.model` — display can go stale on server-initiated changes (non-blocking nit)

**Claim.** When the model or thinking level changes *server-side* (e.g. the
user runs `/model opencode-go/...` as a slash command in the prompt, or Pi
emits `model_select` / `thinking_level_changed`), the input box does not
update. This gap predates this branch but is more consequential now that the
single input is the source of truth.

**Evidence — the gap is real.**
- Backend: `PiRpcSession.handleEvent` updates `session.model` from
  `model_select` (`bin/tau.js:341`), `session.thinkingLevel` from
  `thinking_level_changed` (`bin/tau.js:340`), and `session.model` from
  `message_end.message.model` (`bin/tau.js:349`). It then broadcasts the raw
event (`bin/tau.js:354`) but calls `touch(false)`, so **no
`live_session_updated`** is sent (`touch` only broadcasts when passed `true`,
  `bin/tau.js:390-393`). Therefore `applyActiveSessionMetadata` — the client's
  object-preserving sync site (`public/app.js:442`) — is **not** invoked for
  these events.
- Client: `handleRPCEvent` (`public/app.js:533`) has cases for
  `agent_start/end`, `message_*`, `tool_execution_*`, `auto_compaction_*`,
  `extension_*`, `session_name` — and **no** case for `model_select`,
  `thinking_level_changed`, or any model extraction from `message_end`
  (`handleMessageEnd`, `public/app.js:692`, does not touch
  `currentModelId`/`currentThinkingLevel`). So the broadcast event is dropped
  on arrival.
- Client-initiated `set_model` (this branch's path) is consistent:
  `handleResponse` → `updateStateFromResponse` → `touch(true)` →
  `live_session_updated` → `applyActiveSessionMetadata` (`bin/tau.js:314-315`,
  `public/app.js:267-269`). So the input updates correctly when the change
  originates from the input box itself; staleness is limited to
  server/`/model`-initiated changes.

**Why the staleness now "sticks" silently.** The Round-2 Fix-2 early-bail
`if (modelInput.value.trim() === modelDisplayString()) return`
(`public/app.js:1300`) compares against the stale `currentModelId`. After a
`/model` slash command, the input shows the old `provider/model:level`, and a
focus→blur with no edit bails out (no RPC, no revert) — so the stale value
persists across interactions instead of being refreshed. With the old
dropdown the same staleness existed but was cosmetic (a label + a separate
thinking tag); now the editable input treats the stale string as ground
truth. A tab switch or reload refreshes it via `fetchModelInfo` /
`handleMirrorSync`.

**Why it is still non-blocking.**
- Pre-existing: the old `updateModelLabel()` / `updateThinkingBtn()` were
  wired to the same sync points and also ignored these events, so this branch
  introduces no new gap — it only inherits one (guideline 4).
- Not severe: the server's model/thinking state is correct; only the display
  is stale, and it self-heals on the next tab switch / reconnect / page load.
- Out of the change's scope: the plan scoped this branch to the header widget
  swap and explicitly left `handleRPCEvent` alone.

**Suggested follow-up (not required for merge).** Add two cases to
`handleRPCEvent` for the active session:
```js
case 'model_select':
  if (event.model) { currentModelId = event.model; updateModelDisplay(); }
  break;
case 'thinking_level_changed':
  currentThinkingLevel = event.level || event.thinkingLevel || currentThinkingLevel;
  updateModelDisplay();
  break;
```
This closes the inherited gap and makes the input reflect `/model` and
`/thinking` slash commands live. (Optional: also read `event.message.model`
in the `message_end` branch.)

**Disposition.** Non-blocking nit, recorded for a follow-up issue. Does not
block merge of `feat/single-model-input-box`.

## Appendix summary

| Item | Disposition | Reason |
|------|-------------|--------|
| A1 dead `availableModels.find` | not a finding | `availableModels` always `[]`; context window set via other paths; plan scoped as harmless |
| A2 async races in `applyModelInput` | not a finding | converges by RPC-id ordering; matches old dropdown's async pattern |
| A3 no-live-session branch missing `.invalid` clear | not a finding | unreachable — input disabled + early-bail on empty value |
| A4 `handleRPCEvent` ignores server model/thinking events | non-blocking nit | pre-existing gap, self-heals on tab switch; more relevant now; suggested follow-up provided |

**Verdict unchanged: correct as-is, ready to merge.** The appendix documents
why the four dismissed items do not require revision; A4 is the only one
worth tracking, as a separate follow-up rather than a blocker for this
branch.
