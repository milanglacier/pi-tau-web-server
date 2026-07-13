---
status: COMPLETED
---


Goal: Replace the header model text input with a click-to-open model picker popup that works the same on desktop and mobile, supports fuzzy completion by provider or model name, and only updates the session when the user explicitly saves.

## Current state from inspection
- The header currently contains `<input class="model-input" id="model-input" ...>` in `public/index.html`.
- `public/app.js` owns the current model state through `currentModelId`, `currentThinkingLevel`, `modelDisplayString()`, `updateModelDisplay()`, `parseModelSpec()`, and `applyModelInput()`.
- The current input commits on blur/Enter and cancels on Escape. This is the behavior to replace with explicit popup Save / close semantics.
- `fetchModelInfo()` already calls `get_available_models`, but the backend currently returns `{ models: [] }` from `bin/tau.js`, so model completion needs backend support before it can be useful.
- Existing CSS already has unused `.model-picker*` and `.model-item*` rules near the command palette section, which can be reused/extended.
- Mobile-specific CSS currently changes `.model-input` width/font at `public/style.css:3088`; the new display should avoid special mobile-vs-desktop behavior except responsive popup sizing.
- The linked `pi-session-model` extension fuzzy behavior matches against `${model.id} ${model.provider}`, tokenizes the query by spaces, requires each token to fuzzy-match in order, and deliberately does not complete thinking levels after `:`.

## Implementation plan

### 1. Change the header control from editable input to clickable display button
- In `public/index.html`, replace the header text input with a button-like control:
  - Keep `id="model-input"` if minimizing JS/CSS churn is preferred, but make it `type="button"` and update its accessible label/title.
  - Alternatively rename to `model-button`; if renamed, update all JS references. Keeping the ID is lower-risk.
- Display the full canonical `provider/model:thinking` string in the button text/value equivalent, with a fallback like `Model` or `default` when no model is known.
- Set the button `title` to the full display string so truncated header text remains inspectable.
- Preserve disabled behavior when there is no active live Tau tab.

### 2. Add popup markup for the model picker
- Add a modal/popup block to `public/index.html`, near the command palette/new-session modal:
  - Overlay: `model-picker-overlay hidden`.
  - Popup: `model-picker hidden`, with role/dialog metadata.
  - Header row with title such as `Model` and an `x` close button.
  - A text input for query/spec entry, e.g. `id="model-picker-input"`, placeholder `provider/model:thinking`.
  - A results list container, e.g. `id="model-picker-list"`.
  - A small help/error line, e.g. “Type provider or model name; optional :off|minimal|low|medium|high|xhigh”.
  - Action buttons: secondary Cancel/Close and primary Save.
- The `x`, overlay click, Cancel, and Escape must close without modifying model state.
- Save is the only path that calls the model update RPCs.

### 3. Rework model display/update JS around explicit popup state
- In `public/app.js`, replace direct edit/blur listeners on `modelInput` with popup functions:
  - `openModelPicker()`
    - Return early with `flashStatusError('Select a live Tau tab first.')` if no active live session.
    - Ensure model info/list is loaded, but do not block opening longer than necessary; show current display immediately.
    - Initialize popup input to `modelDisplayString()`.
    - Clear any invalid/error state.
    - Render fuzzy suggestions.
    - Show overlay/popup and focus/select the input.
  - `closeModelPicker({ reset = true } = {})`
    - Hide overlay/popup and clear transient selection/error state.
    - Never call RPC.
  - `saveModelPicker()`
    - Calls the refactored apply function with the popup input value.
    - On success, closes popup; on failure, keeps popup open and shows inline error plus status flash.
- Update `updateModelDisplay()` so it no longer respects `dataset.editing`; it should simply update the button text/title from canonical state.
- Update `updateMirrorInputState()` so it disables the model button when no live session is active.
- Update global Escape handling so it first closes the model picker without saving before aborting a stream or closing other panels.

### 4. Refactor model application to accept an explicit string
- Change `applyModelInput()` into a value-driven helper, e.g. `applyModelSpec(rawSpec, { keepPopupOpenOnError = false } = {})`.
- Preserve existing behavior and invariants:
  - No-op if `rawSpec.trim() === modelDisplayString()`.
  - Require an active live session.
  - Parse with first slash as provider separator and last `:validThinkingLevel` as optional thinking suffix.
  - Never split model IDs on later slashes; preserve OpenRouter-style IDs such as `openrouter/z-ai/glm-5.2`.
  - Send `set_model` with `{ provider, modelId }`.
  - If a valid thinking suffix was supplied, send `set_thinking_level` after successful model change.
  - Update `currentModelId`, `currentThinkingLevel`, context window, and display from the server response/fallback values exactly as today.
- Adjust failure handling so the header button is not marked invalid permanently. Validation errors should appear in the popup and status area; the button can use an `.invalid` class only as a short flash if desired.

### 5. Implement fuzzy model completion in `public/app.js`
- Add local helpers modeled on the linked extension:
  - `modelRef(model) => `${model.provider}/${model.id}``.
  - `fuzzyMatch(query, text)` with ordered character matching, word-boundary bonus, consecutive-match bonus, gap penalty, exact-match bonus, and alpha/numeric swap fallback.
  - `fuzzyFilter(items, query, getText)` that splits query into whitespace tokens and requires all tokens to match.
- Normalize available model items from backend into `{ provider, id, label, contextWindow/context, maxOutput, thinking, images }` where possible.
- Filtering behavior:
  - If the input includes `:`, do not offer fuzzy completions after the colon, matching `pi-session-model`; still allow manual Save so `provider/model:xhigh` works.
  - Otherwise filter against `${id} ${provider}` so both provider and model name can be typed, e.g. `opus anthropic`.
  - Render top N suggestions, e.g. 30–50, for performance and visual clarity.
  - Selecting/clicking a suggestion fills the popup input with `provider/model` and preserves any currently typed valid thinking suffix only if the suffix was present before selection; otherwise no suffix.
- Keyboard behavior inside popup:
  - ArrowUp/ArrowDown moves highlighted suggestion.
  - Enter selects the highlighted suggestion if suggestions are visible; otherwise saves. A second Enter after selecting can save.
  - Tab may accept the highlighted suggestion and prevent focus loss if desired.
  - Escape closes without saving.
- Save button should remain enabled for non-empty input, because manual model refs may be valid even if not in the current list.

### 6. Populate `get_available_models` from Pi instead of returning an empty list
- In `bin/tau.js`, replace the hard-coded `get_available_models` response with a helper that shells out to Pi’s model listing:
  - Use `execFile('pi', ['--list-models'], { timeout: 30000, encoding: 'utf8' })`.
  - Parse the table output; skip the header, split rows on 2+ spaces, and return objects like `{ provider, id, context, maxOutput, thinking, images }`.
  - Preserve model IDs containing single slashes because the model column is separated by whitespace columns, not by `/`.
  - On failure, return `{ models: [] }` or an error depending on UX preference; prefer success with empty list plus server log warning so manual entry still works.
- Add a small in-memory cache, e.g. 5 minutes, to avoid spawning `pi --list-models` every time the picker opens.
- Keep `get_available_models` backend-local in `rpcCommand` so the popup can refresh the list even if no command is routed through the live session, but the UI still requires an active session before saving.
- Export the parser helper for tests if it is non-trivial.

### 7. Update styling for unified desktop/mobile behavior
- Convert `.model-input` styles to button/display semantics:
  - `cursor: pointer`, text overflow ellipsis, `overflow: hidden`, `text-overflow: ellipsis`, `text-align: left`, no editable caret assumptions.
  - Keep mono font and glass styling.
  - Remove or simplify mobile-specific `.model-input` overrides so desktop and mobile use the same truncating display behavior.
- Extend existing `.model-picker*` CSS:
  - Header with close button.
  - Search/spec input.
  - Results list with active/highlighted state.
  - Footer actions and inline error/help.
  - Responsive sizing: desktop centered small popup; mobile `width: min(520px, calc(100vw - 24px))`, max-height around `70vh`, not a different model-display logic.
- Ensure z-index does not conflict with command palette/settings/new-session modals.

### 8. Tests and validation
- Backend tests:
  - Add unit tests for the `pi --list-models` parser, including model IDs with slashes like `accounts/fireworks/models/deepseek-v4-flash`.
  - Update the existing `get_available_models response shape` test so it does not require an empty array if a parser/spawn hook is introduced; assert shape and controlled parsed output.
  - Add or update tests for `parseModelSpecToModel`/`parseModelSpec` invariants with provider/model IDs that contain slashes and `:thinking` suffixes.
- Frontend validation is mostly manual because there is no browser test harness:
  - Open a live tab, click the header model button, verify popup opens and input is focused.
  - Type provider-only query, model-only query, and mixed query like `opus anthropic`; confirm fuzzy results rank sensibly.
  - Click a suggestion, save, verify `set_model` fires and the header updates.
  - Type `provider/model:xhigh`, save, verify both model and thinking update.
  - Click `x`, overlay, Cancel, and Escape after editing; verify no RPC is sent and header remains unchanged.
  - Test mobile width in devtools: header shows one truncating button and popup remains usable.
- Run `npm test` after implementation.

### 9. Important invariants to preserve
- The server remains canonical for model identity; frontend state should be updated from server/session events when available.
- Do not parse model IDs by splitting every `/`; split only the first slash into provider and model ID.
- Do not persist or change anything on popup close/cancel/Escape/overlay click.
- Manual model entry must still work even when the available-model list is empty or stale.
- Thinking level remains optional and is applied only when the user includes a valid `:off|minimal|low|medium|high|xhigh` suffix.

## Review of implementation (feat/model-ui-input-box-enable-fuzzy-match)

### Finding 1: `openModelPicker` guard check is unreachable because the button is disabled first

`openModelPicker()` at public/app.js:1539 checks `if (!viewingActiveSession || !activeLiveSessionId)` and flashes an error, but `updateMirrorInputState()` (line 2083) already sets `modelInput.disabled = !hasLiveSession` using the exact same condition. Browsers do not fire click events on disabled buttons, so this guard will never execute. The behavior is correct — the button is already disabled when there is no active session — but the guard code will never be reached and can be removed or replaced with an assertion.

### Finding 2: Thinking-level failure after a successful model change leaves partial state and a persistent popup

In `applyModelSpec()` at public/app.js:1632–1660, if `set_model` succeeds but the subsequent `set_thinking_level` call fails, `currentModelId` has already been updated to the new model while `currentThinkingLevel` remains at the old value. The popup stays open with an error message because the function returns `{ success: false }`. If the user closes the popup via Escape / Cancel / X / overlay click, `closeModelPicker()` never reverts the model change, so the server-side model update persists without the requested thinking level. The user is not told that the model *was* changed but the thinking level was not. Previously the old code treated thinking-level failure as non-fatal — it showed a flash error but still completed the model update successfully. This behavioral change should be acknowledged and, if intentional, the error message should clarify that the model was updated but thinking could not be set.

### 3. Verdict: needs revision

The implementation correctly replaces the editable input with a popup model picker, implements fuzzy completion, wires up the backend model list, and preserves all the invariants in the plan. The two issues above do not block the feature but should be addressed: the dead guard should be cleaned up, and the partial-update behavior on thinking-level failure should be either reverted to the old non-fatal treatment or given a clearer error message.

### Fix for Finding 1 — Remove unreachable guard in `openModelPicker`

Replaced the guard (`if (!viewingActiveSession || !activeLiveSessionId) …`) with a comment noting that the button is disabled externally by `updateMirrorInputState()`, so the handler is only reachable when a session exists.

### Fix for Finding 2 — Make thinking-level failure non-fatal

Changed the `set_thinking_level` failure branch in `applyModelSpec()`: instead of returning `{ success: false, error }` (which kept the popup open), the error is now flashed via `flashStatusError` and the function falls through to `return { success: true }`. The popup closes normally, the header shows the new model with the old thinking level (matching server state), and the user can retry the thinking level by reopening the picker.

## Second review of implementation (feat/model-ui-input-box-enable-fuzzy-match)

### Finding 1: Reset the highlighted suggestion when the query changes

`modelPickerInput`'s `input` handler re-renders suggestions without resetting `modelPickerActiveIndex`, and `renderModelPickerSuggestions()` only clamps the old index when it falls outside the new result count. After a user navigates down the list, edits the query, and presses Enter, the picker selects the same numeric index from the new fuzzy results instead of the top-ranked result for the new query. For example, arrowing to the sixth `claude` result, changing the query to `opus`, and pressing Enter fills the sixth `opus` result, which can lead to saving an unintended model with the normal second Enter confirmation. Reset the active index when the query text changes so each new query starts from the top result.

Location: `/Users/northyear/Desktop/personal-projects/tau/public/app.js:1676-1679`

### Verdict: needs revision

The implementation is mostly aligned with the plan, and `npm test` passes. The remaining issue is confined to keyboard selection in the fuzzy picker, but it can cause the explicit confirmation flow to choose a different model than the user expects after editing a query.

### Fix for second-review Finding 1 — Reset suggestion highlight on query edits

Updated the model picker input handler in `public/app.js` so any user edit resets `modelPickerActiveIndex` before suggestions are rendered. Each new query now highlights the top-ranked fuzzy result instead of carrying over the previous numeric selection, while arrow-key movement and async list refresh behavior continue to preserve the current selection as before.

Validation: ran `npm test`; all 121 tests passed.

## Third review of implementation (feat/model-ui-input-box-enable-fuzzy-match)

### Findings

No findings.

### Verdict: correct as-is

The current branch addresses the prior review findings, and the model picker implementation remains aligned with the plan. `npm test` passes with all 121 tests successful.
