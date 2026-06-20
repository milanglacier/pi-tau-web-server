# Plan: Keep full provider/model:thinking in the model input + less-conservative truncation

## Goal
1. After the user sets the model in the header model-input box, the displayed value must retain the **full** `provider/model:thinking` form instead of collapsing to just `model:thinking` (provider stripped).
2. Make the default UI truncation of the model-input less conservative so the full model name is shown as much as possible, especially on small/mobile screens.

## Root cause (verified)

### Provider stripping
`public/app.js` `applyModelInput()` (lines ~1388–1396). After a successful `set_model` RPC, the response `data` is parsed:
```js
if (data.provider && data.id) {
  currentModelId = { provider: data.provider, id: data.id };
} else if (data.id) {
  currentModelId = data.id;            // ← BUG: bare string, provider lost
} else {
  currentModelId = { provider: parsed.provider, id: parsed.modelId };
}
```
When the backend response contains `data.id` but no `data.provider`, `currentModelId` becomes a bare string like `"deepseek-v4-pro"`. `modelDisplayString()` (lines ~1284–1304) then has no `/` to split and renders `deepseek-v4-pro:off` — provider gone. The user just typed `parsed.provider`, so we always know it.

Note: the other sync paths (`applyActiveSessionMetadata` ~482, `fetchModelInfo` ~1461, `handleMirrorSync` ~1724) already have comments/code intending to preserve the `{provider,id}` object, and `modelLabel` from the backend is built as `${provider}/${id}` (`bin/tau.js:135`), so those paths are string-with-`/` and render fine. The regression is specifically `applyModelInput`'s middle branch.

### Truncation too conservative
`public/style.css` `.model-input` (lines ~1100–1113):
```css
white-space: nowrap;
max-width: 240px;     /* hard cap, not relaxed on mobile */
min-width: 160px;     /* prevents shrinking to use available header space */
```
- No mobile override exists (the `@media (max-width: 768px)` block at ~3072 only tweaks header padding/gap).
- `<input>` text doesn't ellipsis; a long name just scrolls/clips at the box edge. With a 240px cap the visible portion is short, especially on phones where the header has spare room the input can't use.

## Changes

### 1. `public/app.js` — `applyModelInput()` (~line 1392)
Replace the three-branch `currentModelId` assignment so the provider is **always** retained, falling back to the user-typed `parsed.provider` when the server omits it:
```js
const data = r.data || {};
const provider = data.provider || parsed.provider;
const id = data.id || parsed.modelId;
currentModelId = (provider && id) ? { provider, id } : (id || parsed.modelId);
```
This guarantees `modelDisplayString()` always has a provider and renders `provider/model:thinking`. The bare-string fallback only triggers if `provider` is somehow empty (defensive), preserving current behavior for that edge case.

### 2. `public/style.css` — `.model-input` (~line 1100)
Make the input grow to use available header width instead of a hard 240px cap:
- Change `max-width: 240px` → `max-width: 360px` (or `420px`) on desktop so wider headers show the full name.
- Add `flex: 1 1 auto;` so it fills spare `.header-left` space and can shrink.
- Keep `min-width` but lower to e.g. `120px` so it can shrink further when header is crowded.

### 3. `public/style.css` — mobile `@media (max-width: 768px)` (~line 3072)
Add a `.model-input` override to maximize visible name on small screens:
```css
.model-input {
  flex: 1 1 0;
  min-width: 0;
  max-width: none;
  width: 100%;
  padding: 4px 8px;
  font-size: 11px;   /* fit more characters; matches .live-tab-model */
}
```
This lets the input take all remaining `.header-left` width on phones, showing the full `provider/model:thinking` string instead of clipping at 240px.

## Files touched
- `public/app.js` (1 edit in `applyModelInput`)
- `public/style.css` (2 edits: `.model-input` base rule + mobile media query)

## Verification
- Run the app, type a model whose backend response returns `id` without `provider` (or simulate); confirm the input keeps `provider/model:thinking` after commit.
- Resize to ~375px width: confirm the input expands to fill the header and shows the full model name; confirm desktop still looks correct (input not oversized, capped at the new max-width).
- Confirm no regression in the non-edit display path (`updateModelDisplay` / `modelDisplayString`) and that editing/blurring still no-ops when unchanged.
