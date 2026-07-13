# Plan: Show red status indicator when set-model fails

## Goal

When a user types an invalid model or invalid thinking level in the model input text box (`#model-input`), the UI currently shows the error message in `#status-text` but leaves the `#status-indicator` dot **green** (`connected`). Change it so the dot turns **red** for the duration of the error, then restores to the real connection state (green `connected` / red `disconnected`) when the status text reverts after 3 seconds.

## Root cause

`applyModelInput()` in `public/app.js` (lines 1300-1357) sets `statusText.textContent` to an error string in several branches but never touches `statusIndicator`. The dot keeps whatever class it had (usually `connected` = green). There is no CSS "error" state for the indicator — only `connected` (green), `disconnected` (red), and `streaming` (accent).

## Files to change

1. `public/style.css` — add an `.status-indicator.error` class (red, mirrors `disconnected`).
2. `public/app.js` — in `applyModelInput()`, turn the indicator red on each error and restore it in the matching `setTimeout`.

## Implementation

### 1. `public/style.css` (after the `.status-indicator.disconnected` block, ~line 1164)

Add:

```css
.status-indicator.error {
  background: var(--error);
  box-shadow: 0 0 8px rgba(248, 113, 113, 0.4);
  animation: connectPop 0.4s var(--spring);
}
```

(Reuses `--error` red like `disconnected`; adds the same pop animation as `connected` for a noticeable transition.)

### 2. `public/app.js` — add a small helper near `applyModelInput` (before it, ~line 1299)

```js
// Turn the status indicator red and show an error message; after `ms`,
// restore the indicator to the real connection state and reset the text.
function flashStatusError(msg, ms = 3000) {
  statusIndicator.classList.remove('connected', 'streaming');
  statusIndicator.classList.add('error');
  statusText.textContent = msg;
  setTimeout(() => {
    statusIndicator.classList.remove('error');
    const open = wsClient.ws?.readyState === WebSocket.OPEN;
    statusIndicator.classList.add(open ? 'connected' : 'disconnected');
    statusText.textContent = open ? 'Connected' : 'Disconnected';
  }, ms);
}
```

### 3. `public/app.js` — replace the inline error/restore blocks in `applyModelInput`

There are **four** spots that currently set `statusText.textContent` to an error and schedule a `setTimeout` to revert the text only. Replace each with a call to `flashStatusError(...)` (keeping the existing `modelInput` revert / `invalid` class logic untouched):

- **"Select a live Tau tab first."** (lines ~1310-1311): replace the two lines with `flashStatusError('Select a live Tau tab first.');`
- **Parse error** (`parsed.error`, lines ~1317-1318): replace the `statusText.textContent = parsed.error;` + `setTimeout(...)` two lines with `flashStatusError(parsed.error);`
- **`set_thinking_level` failure** (lines ~1340-1341): replace with `flashStatusError((t && t.error) ? t.error : 'Failed to set thinking level');`
- **`set_model` RPC failure** (lines ~1352-1353): replace with `flashStatusError((r && r.error) ? r.error : 'Unknown model');`

Each branch keeps its existing `modelInput.value = modelDisplayString();` and `modelInput.classList.add/remove('invalid')` / `setTimeout(... invalid)` lines — only the status-text + status-indicator handling is delegated to the helper.

### 4. Success path

No change needed. On success, `updateModelDisplay()` / `updateUI()` already keep the indicator green/connected. (The `set_thinking_level` failure sub-case is handled by `flashStatusError` above, which restores to connected after the timeout.)

## Notes

- No backend/extension changes required; this is purely client-side UI feedback.
- The helper preserves the existing 3-second timeout behavior and the "Connected/Disconnected" restore text, so behavior is identical except the dot now correctly goes red on errors.
