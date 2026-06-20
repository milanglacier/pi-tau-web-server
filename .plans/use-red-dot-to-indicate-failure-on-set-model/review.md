# Review: fix/use-red-light-to-indicate-wrong-model-field

Branch: `fix/use-red-light-to-indicate-wrong-model-field`
Commit reviewed: `288119e` (`fix: indicate red light on model set failure.`)
Scope: `git diff 2928c67..288119e` — `public/app.js`, `public/style.css` (plus added `plan.md`, deleted `CLAUDE.md`).

## Findings

### 1. Restore step leaves stale `disconnected` class, so the dot can stay red while connected

`flashStatusError` only removes `connected` and `streaming` when entering the
error state, and only removes `error` on restore — it never clears
`disconnected`:

```js
statusIndicator.classList.remove('connected', 'streaming'); // leaves 'disconnected'
statusIndicator.classList.add('error');
// ...
statusIndicator.classList.remove('error');
statusIndicator.classList.add(open ? 'connected' : 'disconnected');
```

If the indicator is `disconnected` (WS down) when an error flashes and the
socket reconnects before the 3s timeout, the restore adds `connected` without
removing `disconnected`, yielding `class="status-indicator disconnected
connected"`. Because `.status-indicator.disconnected` is declared *after*
`.status-indicator.connected` in `public/style.css` (lines 1154 vs. 1166), the
red `disconnected` rule wins on equal specificity, so the dot stays red even
though `wsClient.ws.readyState === OPEN`. `updateUI()` (lines 1964–1970) and the
poll path also only add/remove `connected`/`streaming` and never strip
`disconnected`, so the wrong state persists until the next WS open/close event
calls `updateConnectionStatus` (line 1938), which resets via `className`
assignment. The original code only touched `statusText.textContent` and never
manipulated the class list, so this is newly introduced.

Fix by resetting the class atomically, the way `updateConnectionStatus` does:

```js
statusIndicator.className = 'status-indicator error';
// ...on restore:
statusIndicator.className = `status-indicator ${open ? 'connected' : 'disconnected'}`;
```

**Location:** `public/app.js`, `flashStatusError`, lines 1303–1311.

### 2. Restore clobbers the `streaming` indicator when an error fires mid-stream

`applyModelInput` is reachable while streaming: `modelInput` is never disabled
by `updateUI()` (only `messageInput`/`sendBtn` are, lines 1972–1973), so a user
can edit and blur the model box during an active stream. If `set_model` or
`set_thinking_level` then fails, `flashStatusError` removes `streaming`, adds
`error`, and on restore unconditionally sets `connected` + `'Connected'`
regardless of `state.isStreaming`:

```js
statusIndicator.classList.remove('error');
const open = wsClient.ws?.readyState === WebSocket.OPEN;
statusIndicator.classList.add(open ? 'connected' : 'disconnected');
statusText.textContent = open ? 'Connected' : 'Disconnected';
```

With `state.isStreaming === true`, the dot flips from the orange pulsing
`streaming` state to a solid green `connected` / `'Connected'` and stays that
way until the next `updateUI()` (agent end, snapshot, or the ~10s poll at line
1733) re-adds `streaming`. The original text-only `setTimeout` did not touch the
indicator class, so the streaming dot survived the error flash. At minimum the
restore should fall back to the streaming state when `state.isStreaming` is true
(e.g. re-add `streaming` and set `'Working...'`), or simply delegate to
`updateUI()` instead of hand-rolling the restore.

**Location:** `public/app.js`, `flashStatusError` restore block, lines 1306–1311.

## Minor notes (not blocking)

- `.status-indicator.error` (`public/style.css` lines 1171–1175) duplicates
  `.disconnected` verbatim plus `connectPop`. Fine, but if finding 1 is fixed by
  reusing `disconnected` semantics, a distinct `error` class may no longer be
  necessary. Left to author preference.
- The restore text drops the `'Connected • TS'` suffix and `statusText.title`
  set by `updateConnectionStatus` (line 1942). This is pre-existing behavior
  (the old inline `setTimeout` did the same), so not counted as a finding, but
  the helper is a good place to fix it if desired.

## Verdict

Needs revision.

The helper correctly turns the dot red on errors, but its restore step
manipulates the indicator class list incrementally instead of resetting it
atomically. This both can leave a stale `disconnected` class that keeps the dot
red after reconnection (finding 1) and can overwrite an active `streaming`
state when an error occurs mid-stream (finding 2). Both are fixable in a few
lines by mirroring the `className =` reset pattern already used in
`updateConnectionStatus`.

---

## Fix summaries

Both findings addressed in `public/app.js` `flashStatusError` (lines
1299–1317). The incremental `classList.remove`/`add` calls were replaced with
atomic `className =` resets, matching the pattern used by
`updateConnectionStatus` (line 1938).

### Finding 1 — stale `disconnected` class

Both the error-enter and restore steps now set the full class string via
`statusIndicator.className = 'status-indicator <state>'`, so no prior
`connected` / `disconnected` / `streaming` class can linger alongside the new
one. A reconnection that completes during the 3s flash now produces a clean
`status-indicator connected` class, and the dot correctly turns green.

### Finding 2 — restore clobbers `streaming` mid-stream

The restore branch now checks `state.isStreaming` (the same flag `updateUI`
reads at line 1961). When the socket is open and a stream is in progress, it
restores `status-indicator streaming` + `'Working...'` instead of forcing
`connected` / `'Connected'`, so an error flashed during a stream no longer
overrides the orange pulsing dot.

### Verification

- `node --check public/app.js` passes (no syntax errors).
- No DOM/browser tests exist for `app.js` (the `test/` suite is server-side
  Node only), so no test changes were needed or applicable.
- The `.status-indicator.error` CSS class (`public/style.css` 1171–1175) is
  retained: it is still applied on error-enter via `className =
  'status-indicator error'`, and its `connectPop` animation remains the
  intentional visual cue for the red flash. The minor note about reusing
  `disconnected` semantics was not applied, since the `error` class carries the
  pop animation that `disconnected` lacks.
- The non-blocking minor note about the dropped `'Connected • TS'` suffix was
  intentionally left as-is to keep the change scoped to the two findings and
  preserve the original restore-text behavior.
