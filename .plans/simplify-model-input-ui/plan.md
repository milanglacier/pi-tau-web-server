# Plan: Replace header model dropdown + thinking tag with a single model input box

## Goal
In the Tau web UI header, replace the model `<select>`-style dropdown widget **and** the adjacent thinking-level tag button with **one single text input box**. Typing `provider/model:thinking` (e.g. `opencode-go/deepseek-v4-pro:xhigh`) sets both the model and thinking level on the fly for the current live session. Strong input validation enforces the `provider/model[:thinking]` format; thinking is optional (if omitted, the current thinking level is kept and no thinking update is sent).

## Key findings (current state)
- `public/index.html` lines 44–51: `.model-dropdown` (button `#model-dropdown-btn`, label `#model-dropdown-label`, menu `#model-dropdown-menu`) + `.thinking-tag` button `#thinking-btn` in `.header-left`.
- `public/app.js`:
  - Lines 1241–1245: element refs (`modelDropdown`, `modelDropdownBtn`, `modelDropdownLabel`, `modelDropdownMenu`, `thinkingBtn`).
  - `updateThinkingBtn()` (1246), `currentModelId`/`availableModels`/`currentThinkingLevel` (1250–1252).
  - `fetchModelInfo()` (1255) pulls `get_state` → `currentModelId`, `currentThinkingLevel`.
  - `updateModelLabel()` (1286) strips `claude-`/date suffix for the label.
  - `toggle/open/closeModelDropdown()` (1291–1361) renders the menu from `availableModels`; on item click sends `rpcCommand({type:'set_model', provider, modelId})` and updates `currentModelId`/label/contextWindow.
  - Outside-click handler (1366–1370) and Escape handler (1398–1400) close the dropdown.
  - `thinkingBtn` click (1374–1379) sends `cycle_thinking_level`.
  - Line 1717: `thinkingBtn.disabled` / `modelDropdownBtn.disabled` toggle with live-session availability.
  - Sync points that call `updateModelLabel()` / `updateThinkingBtn()`: 439–442, 1268–1279, 1332–1333, 1377–1378, 1630–1640, 2009–2011, 2053–2054.
- `bin/tau.js`:
  - Line 557: `get_available_models` is intercepted by the Tau server and returns `models: []` — so the dropdown is already empty; the input-box approach is strictly better. Validation therefore cannot check membership and must rely on RPC `set_model` success/failure for unknown models.
  - Lines 324–341: `set_model` updates `session.model`; `set_thinking_level`/`thinking_level_changed` update `session.thinkingLevel`.
  - `get_state` returns `session.model` (string or `{provider,id}`) and `session.thinkingLevel`.
- Pi RPC contract (`~/.local/share/pi/docs/rpc.md`):
  - `set_model`: `{"type":"set_model","provider":"...","modelId":"..."}`.
  - `set_thinking_level`: `{"type":"set_thinking_level","level":"..."}` — valid levels: `off, minimal, low, medium, high, xhigh` (`xhigh` only OpenAI codex-max).
- The existing "New Tau tab" modal (`#new-live-session-model`, placeholder `openai/gpt-5.5:high`) already uses the same `provider/model:thinking` syntax — we mirror that convention.
- CSS: `public/style.css` lines 1099–1238 cover `.model-dropdown*` and `.thinking-tag*`.
- The settings panel's separate "Thinking level" row (`#setting-thinking` / `#btn-thinking-level`) is **not** next to the model widget — leave it intact; it will still cycle thinking and its result should reflect in the new input via the existing sync points.

## Implementation

### 1. `public/index.html` (header)
Replace the `.model-dropdown` div **and** the `#thinking-btn` button (lines 44–51) with a single input:
```html
<input class="model-input" id="model-input" type="text"
       placeholder="provider/model:thinking"
       title="Set model and (optionally) thinking level for this session"
       autocomplete="off" spellcheck="false">
```
Leave `#mobile-model-bar` (line 116) untouched — it is unrelated (holds cost/token usage on mobile).

### 2. `public/style.css`
- Add `.model-input` styling reusing the `.model-dropdown-btn` look: monospace, `var(--bg-glass)`, 1px border, `var(--radius-md)`, padding 4px 10px, font-size 12px, `max-width: 240px`, `min-width: 160px`, focus ring using `var(--accent)`. Add a `.model-input:disabled` dimmed state and a `.model-input.invalid` red-border state for validation errors.
- Remove now-unused rules: `.model-dropdown-menu`, `.model-dropdown-search*`, `.model-dropdown-item*`, `.thinking-tag*` (lines 1135–1238). Keep `.model-dropdown`, `.model-dropdown-btn`, `.model-dropdown-chevron` rules or drop them — drop them for cleanliness since the elements no longer exist. (Mobile rule at line 3317 referencing `.model-dropdown-item` also removed.)

### 3. `public/app.js`
**Element refs (1241–1245):** replace with:
```js
const modelInput = document.getElementById('model-input');
```

**Display function:** replace `updateThinkingBtn()` + `updateModelLabel()` with a single `updateModelDisplay()`:
- Build the display string from `currentModelId` (string, or `{provider,id}`) + `currentThinkingLevel`:
  - `const provider = (typeof currentModelId === 'object') ? currentModelId.provider : (currentModelId.split('/')[0] || '');`
  - `const modelId = (typeof currentModelId === 'object') ? currentModelId.id : (currentModelId.split('/').slice(1).join('/') || currentModelId);`
  - `modelInput.value = thinking ? \`${provider}/${modelId}:${currentThinkingLevel}\` : \`${provider}/${modelId}\`;` — always include the `:level` suffix so the user sees the live thinking level (since `currentThinkingLevel` always has a value, default `'off'`).
  - If no model yet, set `''` and let the placeholder show.
- **Important:** only overwrite the value if the input is not currently focused (so we don't clobber the user mid-typing). Track focus via `modelInput.dataset.editing`.

**Parse + validate function** `parseModelSpec(raw)`:
- Trim. Regex: `^([^\/:]+)\/([^\/:]+)(:([a-zA-Z]+))?$/`.
- Require both provider and modelId non-empty (captured groups 1 & 2).
- If thinking group present, lowercase it and validate against `new Set(['off','minimal','low','medium','high','xhigh'])`. Invalid → return `{error: 'Invalid thinking level. Use one of: off, minimal, low, medium, high, xhigh'}`.
- No match → `{error: 'Use format provider/model[:thinking], e.g. opencode-go/deepseek-v4-pro:xhigh'}`.
- Success → `{provider, modelId, thinking: group4 ? lower : null}`.

**Commit handler** `applyModelInput()`:
- If no live session: show "Select a live Tau tab first." in `statusText`, revert value, return.
- `const parsed = parseModelSpec(modelInput.value);`
- On error: set `modelInput.classList.add('invalid')`, show `parsed.error` in `statusText` (auto-clear after 3s), revert `modelInput.value` to last-good display, return.
- Send `const r = await rpcCommand({type:'set_model', provider: parsed.provider, modelId: parsed.modelId}, \`Switching to ${parsed.provider}/${parsed.modelId}...\`);`
- If `r.success`:
  - Update `currentModelId` from `r.data` (full Model object: `r.data.id` / `r.data.provider`) or fall back to `{provider: parsed.provider, id: parsed.modelId}`. Update `contextWindowSize` if `r.data.contextWindow` and call `updateTokenUsage()`.
  - If `parsed.thinking !== null`:
    - `const t = await rpcCommand({type:'set_thinking_level', level: parsed.thinking}, 'Setting thinking...');`
    - If `t.success`: `currentThinkingLevel = parsed.thinking;`
    - Else: show thinking error in status, keep old thinking (do not block model change already applied).
  - (If `parsed.thinking === null`: leave `currentThinkingLevel` unchanged — per spec "use current thinking level and no update".)
  - Remove `.invalid`, call `updateModelDisplay()`.
- Else (`r.success === false`): set `.invalid`, show `r.error || 'Unknown model'`, revert input, return.

**Event wiring:**
- `modelInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applyModelInput(); modelInput.blur(); } if (e.key === 'Escape') { modelInput.value = lastGoodDisplay; modelInput.blur(); } });`
- `modelInput.addEventListener('focus', () => { modelInput.dataset.editing = '1'; modelInput.classList.remove('invalid'); });`
- `modelInput.addEventListener('blur', () => { delete modelInput.dataset.editing; applyModelInput(); });` — commit on blur (so clicking away applies or reverts).
- Remove: `modelDropdownBtn.addEventListener('click', toggleModelDropdown)`, the outside-click dropdown closer, the Escape `closeModelDropdown()` branch (1398–1400), and the `thinkingBtn.addEventListener('click', ...)` block.

**Remove dead code:** `toggleModelDropdown`, `openModelDropdown`, `closeModelDropdown`, `fetchModelInfo`'s use of `availableModels` can stay (harmless) but the `availableModels`-based menu is gone. Keep `fetchModelInfo` calling `updateModelDisplay()` instead of `updateModelLabel()`/`updateThinkingBtn()`.

**Sync points:** at every existing call site of `updateModelLabel()` and/or `updateThinkingBtn()` (lines 439–442, 1268–1279, 1332–1333 [now inside applyModelInput], 1377–1378, 1630–1640, 2009–2011, 2053–2054), replace with a single `updateModelDisplay()` call. This keeps the input in sync when the settings-panel thinking button cycles, or when the server pushes `model_select` / `thinking_level_changed` events.

**Disabled state (line 1717):** replace `modelDropdownBtn.disabled`/`thinkingBtn.disabled` with `modelInput.disabled = !hasLiveSession;`.

### 4. No backend changes
`bin/tau.js` and `extensions/*` are unchanged — `set_model` and `set_thinking_level` already exist and are forwarded to Pi RPC. The `get_available_models` interception (returns `[]`) is fine since we no longer need a model list for the UI.

## Validation summary (the "strong input validation")
- Format must be `provider/model[:thinking]`; provider and modelId both required, neither may contain `/` or `:`.
- Thinking optional; if present must be one of `off, minimal, low, medium, high, xhigh` (case-insensitive, normalized to lowercase).
- Omitted thinking → current thinking preserved, no `set_thinking_level` sent.
- Format-valid but nonexistent provider/model → caught by `set_model` RPC failure; error shown, input reverted.

## Files changed
- `public/index.html` — swap header widgets for one input.
- `public/style.css` — add `.model-input` rules; remove dropdown-menu/thinking-tag rules.
- `public/app.js` — new `modelInput` ref, `parseModelSpec`, `applyModelInput`, `updateModelDisplay`; remove dropdown/thinking-button logic; rewire sync points and disabled state.

## Testing
- Manual (browser): load Tau, connect a live tab. Type a valid `provider/model:high` → Enter; confirm status "Done", input shows new value with `:high`, subsequent prompt uses the model/thinking. Type `badmodel` → see format error, input reverts. Type `provider/model:foo` → thinking-level error, revert. Type `provider/model` (no thinking) → model switches, thinking unchanged, input re-suffixed with current level. Click settings-panel thinking button → input suffix updates. With no live tab → "Select a live Tau tab first." and revert. Escape while editing → revert + blur.
- `npm test` (node --test) — confirm no existing unit tests break (none cover this UI, but verify suite still passes).
