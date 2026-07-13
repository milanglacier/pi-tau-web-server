---
status: COMPLETED
---

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

---

## 2nd-reviewer assessment

Branch: `fix/use-red-light-to-indicate-wrong-model-field`
Commits reviewed: `288119e` and `3f7ea7e` (i.e. `git diff a06faa4..HEAD` on
`public/app.js` and `public/style.css`).

### Confirmation of prior findings

Both findings from the first review are resolved.

- Finding 1 (stale `disconnected` class): the enter and restore steps now use
  atomic `statusIndicator.className = 'status-indicator <state>'` assignments
  (`public/app.js` lines 1305 and 1312/1315), so no prior
  `connected`/`disconnected`/`streaming` class can linger alongside `error`.
  A reconnect during the 3 s flash now yields a clean `connected` class.
- Finding 2 (`streaming` clobbered mid-stream): the restore branch now checks
  `state.isStreaming` (line 1311) and re-applies `status-indicator streaming` +
  `'Working...'` when the socket is open and a stream is in progress, instead of
  forcing `connected`/`'Connected'`. Matches the flag `updateUI` reads.

`node --check public/app.js` passes; the `.status-indicator.error` CSS rule is
retained and is the only place the red flash gets its `connectPop` cue.

### Findings

#### 1. Red dot and status text desync when `set_model` succeeds but `set_thinking_level` fails

`applyModelInput` runs `set_model` and `set_thinking_level` as two separate
`rpcCommand` calls. On `set_model` success, `rpcCommand` sets the text to
`'Done'` and schedules a **2 s** restore to `'Connected'`
(`public/app.js` lines 1202–1203). If the subsequent `set_thinking_level` call
fails, `applyModelInput` calls `flashStatusError(t.error)` (lines 1361–1364),
which turns the dot red and schedules a **3 s** restore. Because the thinking
RPC typically fails well within 2 s of the `set_model` success, the stale
2 s `'Done'` timer fires *during* the 3 s red-dot window and overwrites the
error text with `'Connected'`, leaving a red `error` dot next to the word
`'Connected'` for roughly the last second of the flash.

```js
// rpcCommand, set_model success — 2s timer still pending:
statusText.textContent = 'Done';
setTimeout(() => { statusText.textContent = 'Connected'; }, 2000);
// ...then thinking fails -> flashStatusError keeps the dot red for 3s
```

The text-overwrite race itself is pre-existing (`rpcCommand` has always owned
its own restore timers), but the *visible dot/text mismatch* is introduced by
this change: previously there was no persistent red dot, so the early text
reset was not contradictory. This is the headline path of the feature — a
single `provider/model[thinking]` input where the model is valid but the
thinking level is rejected — so it is readily reachable. A minimal fix is to
make the error flash own the text for its full duration, e.g. have
`applyModelInput` suppress `rpcCommand`'s status messaging on the
`set_thinking_level` failure path (or cancel/ignore `rpcCommand`'s pending
restore when `flashStatusError` runs), rather than letting the two timer
systems race.

**Location:** `public/app.js` — `rpcCommand` lines 1202–1203 (2 s `'Done'`
restore) interacting with `applyModelInput` lines 1361–1364 and
`flashStatusError` lines 1302–1317.

### Minor notes (not blocking)

- **Overlapping flashes can clear the dot early.** Two `applyModelInput`
  failures within 3 s (e.g. user edits to a second invalid spec and blurs
  before the first flash elapses) schedule two independent restore timers; the
  first restore atomically resets the dot to `connected`/`disconnected` while
  the second error is still nominally active, briefly turning the dot green
  before the second error's intended end. The original text-only `setTimeout`
  had the same overlapping-timer problem for the text, but the dot-color
  clobber is new. Narrow trigger; mention only for completeness.
- The restore text still drops the `'Connected • TS'` suffix and
  `statusText.title` that `updateConnectionStatus` sets (line 1949–1950). This
  was already noted as pre-existing by the first reviewer; still applies now
  that the helper is the single restore path for these flows.

### Verdict

Needs revision (minor).

The first reviewer's two findings are correctly addressed: the atomic
`className` reset eliminates the stale-class bug, and the `isStreaming`-aware
restore preserves the streaming dot. One new, reachable desync remains on the
feature's core path — when `set_model` succeeds and `set_thinking_level`
fails, `rpcCommand`'s stale 2 s `'Done'` timer overwrites the error text while
the red dot persists for 3 s, producing a red dot beside `'Connected'`. It is a
small window and rooted in pre-existing `rpcCommand` timer behaviour, but the
visible mismatch is introduced by this change and is worth a one-line fix to
give the error flash ownership of the status text for its full duration.

---

## 2nd-reviewer fix summary

Finding 1 (red dot / status text desync) addressed in `public/app.js`.

### Root cause

`rpcCommand` and `flashStatusError` each scheduled their own independent
`setTimeout` restore of `statusText`, with no shared handle. On the feature's
headline path — `set_model` succeeds (rpcCommand schedules a 2 s
`'Done'` -> `'Connected'` restore) and then `set_thinking_level` fails
(`flashStatusError` turns the dot red for 3 s) — the stale 2 s timer fired
inside the 3 s red-dot window and overwrote the error text with `'Connected'`,
producing a red `error` dot beside the word `'Connected'`.

### Fix

Introduced a single module-level `statusRestoreTimer` plus a
`setStatusMessage(text, restoreText, restoreMs)` helper (`public/app.js`
lines 41–52) that clears any previously scheduled restore before setting a
new one. All transient `statusText` restores now flow through this helper:

- `rpcCommand`: the five inline `setTimeout` restore sites (needs-live-session
  error, `'Done'`, `data.error`, catch `'Error'`) now call `setStatusMessage`
  (lines 1206, 1210, 1218, 1220, 1224).
- `rpcExportHtml`: the 4 s `'Exported: ...'` restore now uses `setStatusMessage`
  (line 1231).
- `flashStatusError`: on entry it calls `clearTimeout(statusRestoreTimer)` and
  schedules its own restore on the same handle (lines 1321–1323), so any
  `rpcCommand` restore pending from an earlier successful step in the same
  flow is cancelled before the red-dot window begins.

Because every new transient message cancels the prior restore, the
`rpcCommand` 2 s `'Done'` timer can no longer fire during the 3 s error flash,
and the error text owns the status bar for the full duration of the red dot.

### Side effect: overlapping flashes (minor note)

The shared-timer approach also resolves the non-blocking "overlapping flashes
can clear the dot early" note. Two `applyModelInput` failures within 3 s now
cancel the first restore when the second `flashStatusError` runs, so the first
restore can no longer atomically reset the dot to `connected`/`disconnected`
while the second error is still active.

### Verification

- `node --check public/app.js` passes.
- No DOM/browser tests exist for `app.js` (the `test/` suite is server-side
  Node only), so no test changes were needed or applicable.
- Left the persistent (non-transient) `statusText.textContent` assignments in
  `updateConnectionStatus` (lines 1966, 1973, 1979) and `updateUI`
  (lines 1990, 1994) untouched: these set durable state and do not schedule
  restores, so routing them through `setStatusMessage` would be incorrect.
- The non-blocking note about the dropped `'Connected • TS'` suffix remains
  unaddressed to keep this change scoped to the desync finding; it is
  pre-existing behavior and out of scope for this fix.

---

## 3rd-reviewer assessment

Branch: `fix/use-red-light-to-indicate-wrong-model-field`
Commits reviewed: `288119e`, `3f7ea7e`, `6c24f18` (i.e. `git diff 2928c67..HEAD`
on `public/app.js` and `public/style.css`).

### Confirmation of prior findings

Both earlier findings are resolved in the current tree.

- Finding 1 (stale `disconnected` class) and finding 2 (`streaming` clobbered
  on restore): `flashStatusError` now uses atomic
  `statusIndicator.className = 'status-indicator <state>'` resets on both enter
  (`public/app.js` line 1317) and restore (lines 1329/1333), and the restore
  checks `state.isStreaming` (line 1327) to preserve the streaming dot.
- 2nd-reviewer finding (red dot / status text desync when `set_model` succeeds
  but `set_thinking_level` fails): the shared `statusRestoreTimer` +
  `setStatusMessage` helper (lines 41–52) ensures `flashStatusError` cancels
  `rpcCommand`'s pending `'Done'` -> `'Connected'` restore on entry
  (line 1321). On the headline path the stale 2 s text timer is in fact
  cancelled even earlier — the `set_thinking_level` call's intermediate
  `setStatusMessage('Setting thinking...')` (line 1376 via `rpcCommand` line
  1210) clears it before the thinking fetch even resolves — so the error text
  owns the bar for the full 3 s. Verified by tracing the call sequence.

`node --check public/app.js` passes.

### Findings

#### 1. Any unrelated `setStatusMessage` call during the 3 s red-dot window cancels the flash restore, leaving the dot stuck red

The shared `statusRestoreTimer` is now the single handle for both
`setStatusMessage` restores and `flashStatusError`'s restore. `setStatusMessage`
clears that handle on every call (line 45) but **never touches
`statusIndicator.className`** — only the flash's restore callback (lines
1323–1334) is responsible for removing the `error` class. So if any other
status update lands during the 3 s flash, it cancels the only callback that
would have turned the dot green again, and nothing else resets the class.

This is readily reachable on the feature's own path. A user who enters an
invalid thinking level (e.g. `provider/model[bad]`) and blurs gets `set_model`
succeeding then `set_thinking_level` failing → `flashStatusError` (red dot,
3 s restore pending). The natural next action is to click the thinking-level
cycle button in the settings panel (`btnThinkingLevel`, `public/app.js` lines
2114–2120), which calls `rpcCommand({ type: 'cycle_thinking_level' })` with no
status message; on success `rpcCommand` runs `setStatusMessage('Done',
'Connected', 2000)` (line 1218), which calls `clearTimeout(statusRestoreTimer)`
and cancels the flash restore. The `statusIndicator` element still has
`class="status-indicator error"`, so the dot stays red while the text reads
`'Done'` then `'Connected'`. The same trap fires via the Compact command
(palette entry line 1162 / button line 1943, `setStatusMessage('Compacting...')`
then `'Done'`), `set_auto_compaction` (line 2110), and `set_auth` (line 2141).

The stuck state does not self-heal: `updateUI` (the only thing the 10 s poll
at line 1740 runs, and what stream events call) uses incremental
`classList.add('connected')` / `remove('streaming')` (lines 1988, 1993) and
never removes `error`, so with `error` + `connected` both present the dot stays
red (`.status-indicator.error` is declared after `.status-indicator.connected`
in `public/style.css`, lines 1171 vs. 1155, so it wins on equal specificity).
Only `updateConnectionStatus` (WS open/close, line 1962) does a full
`className =` reset, so on a stable connection the dot can remain red
indefinitely.

This is a regression introduced by `6c24f18`. In the 2nd-reviewer state
(`3f7ea7e`), `flashStatusError`'s restore was on an independent `setTimeout`
that `rpcCommand`'s inline timers could not cancel, so the dot always restored
after 3 s; the unification that fixed the 1-second text race over-corrected and
made the flash's indicator restore cancellable by any unrelated status update.

A minimal fix keeps the flash's indicator-restore off the shared text-timer
handle (e.g. a separate `flashRestoreTimer` that `setStatusMessage` does not
clear), and/or makes `setStatusMessage` clear the `error` class on the
indicator when it starts a new non-error message — mirroring the atomic reset
`updateConnectionStatus` already uses.

**Location:** `public/app.js` — `setStatusMessage` lines 44–52 (clears shared
handle, no indicator reset) interacting with `flashStatusError` restore lines
1323–1334; reachable via `rpcCommand` success line 1218 and intermediate line
1210, and callers at lines 1162, 1943, 2110, 2115, 2141.

### Minor notes (not blocking)

- **Mid-stream error feedback is lost.** `modelInput` is never disabled while
  streaming (`updateMirrorInputState` keys only on `hasLiveSession`), so an
  invalid model blur mid-stream calls `flashStatusError`, but the next stream
  snapshot runs `updateUI` which does `classList.add('streaming')` without
  removing `error` and overwrites `statusText` with `'Working...'` (lines
  1988, 1990). Because `.status-indicator.streaming` is declared after
  `.status-indicator.error` (`public/style.css` lines 1174 vs. 1171), the dot
  flips back to the streaming accent immediately and the error text is
  overwritten. The text clobber is pre-existing (`updateUI` always owned the
  streaming text); only the brief red-dot suppression is new. Mentioned for
  completeness, not as a blocker.

### Verdict

Needs revision (minor).

The two prior findings are correctly resolved and the text-desync on the
headline `set_model`-succeeds / `set_thinking_level`-fails path is fixed.
However, unifying all restores under one `statusRestoreTimer` handle made the
flash's indicator restore cancellable by any unrelated `setStatusMessage`
call — most naturally the thinking-level cycle button the user clicks right
after a thinking-level failure — leaving the `error` class on the indicator
with no timer to clear it and no self-heal in `updateUI`, so the dot stays red
indefinitely on a stable connection. Routing the flash's indicator restore off
the shared handle (or having `setStatusMessage` reset the `error` class) closes
the regression while preserving the desync fix.

---

## 3rd-reviewer fix summary

Finding 1 (stranded red dot when an unrelated `setStatusMessage` cancels the
flash restore) addressed in `public/app.js`.

### Root cause

`6c24f18` unified every transient `statusText` restore — `rpcCommand`'s,
`rpcExportHtml`'s, and `flashStatusError`'s indicator+text restore — under a
single `statusRestoreTimer` handle. `setStatusMessage` clears that handle on
every call but never touches `statusIndicator.className`, so the flash's
restore callback was the *only* code path that removed the `error` class.
When an unrelated status update landed during the 3 s red-dot window (most
naturally the user clicking the thinking-level cycle button right after a
thinking-level failure → `rpcCommand` success → `setStatusMessage('Done',
'Connected', 2000)`), it cancelled the flash's restore to clear the text
timer, leaving `class="status-indicator error"` on the dot with no timer to
clear it. `updateUI` (the only thing the 10 s poll and stream events run)
uses incremental `classList.add('connected')` and never removes `error`, and
`.status-indicator.error` wins the CSS tie over `.status-indicator.connected`
(declared later, equal specificity), so on a stable connection the dot stayed
red indefinitely until a WS open/close triggered `updateConnectionStatus`.

### Fix

Split the flash's indicator restore off the shared text-timer handle and gave
`setStatusMessage` explicit responsibility for retiring a superseded flash.

- New module-level `statusFlashTimer` (`public/app.js` line 47), separate
  from `statusRestoreTimer`. `setStatusMessage` does **not** clear it as part
  of its normal text-timer cancellation, so an unrelated status update can no
  longer cancel the only callback that clears the `error` class.
- New `restoreStatusIndicator()` helper (lines 54–59) that resets
  `statusIndicator.className` atomically to `connected`/`disconnected`/
  `streaming` based on `wsClient.ws.readyState` and `state.isStreaming` — the
  same state-derivation `updateUI` uses. It touches only the indicator class,
  not `statusText`, so callers keep control of the accompanying text.
- `setStatusMessage` (lines 63–76) now checks `statusFlashTimer !== null` on
  entry: if a flash is active, it clears `statusFlashTimer`, calls
  `restoreStatusIndicator()` to return the dot to its real state, then sets
  the new text. A new status message thus supersedes a stale error flash
  cleanly — the dot leaves red immediately and the new action's text shows —
  rather than stranding the red dot.
- `flashStatusError` (lines 1341–1361) now schedules its dot+text restore on
  `statusFlashTimer` instead of `statusRestoreTimer`, and clears any prior
  `statusFlashTimer` on entry so overlapping flashes (a second
  `applyModelInput` failure within 3 s) cannot leak a stray restore that
  would reset the dot before the second flash's own restore fires — preserving
  the 2nd-reviewer's resolution of the overlapping-flashes minor note.

### Scenario trace

- **Headline desync (2nd reviewer, still fixed):** `set_model` success →
  `setStatusMessage('Done','Connected',2000)` schedules on
  `statusRestoreTimer` (`statusFlashTimer` is null, so the flash-cancel block
  is skipped). `set_thinking_level` runs `setStatusMessage('Setting
  thinking...')` (clears the text timer). Thinking fails → `flashStatusError`
  clears `statusRestoreTimer`, turns the dot red, schedules on
  `statusFlashTimer`. No text restore is pending, so the error text owns the
  bar for the full 3 s.
- **3rd-reviewer stranded dot (now fixed):** thinking fails → flash (red,
  `statusFlashTimer` set). User clicks the thinking-level cycle button →
  `rpcCommand({type:'cycle_thinking_level'})` (no status message) resolves →
  `setStatusMessage('Done','Connected',2000)` sees `statusFlashTimer !== null`,
  clears it, calls `restoreStatusIndicator()` (dot → green), then sets
  `'Done'`. The dot is no longer red. The same retirement fires for the
  Compact command (`setStatusMessage('Compacting...')` at the call start),
  `set_auto_compaction`, and `set_auth`.
- **Overlapping flashes (minor note, still fixed):** a second
  `flashStatusError` within 3 s clears the first `statusFlashTimer` before
  scheduling its own, so only the second restore fires and the dot stays red
  for the full second flash.

### Verification

- `node --check public/app.js` passes.
- No DOM/browser tests exist for `app.js` (the `test/` suite is server-side
  Node only), so no test changes were needed or applicable.
- The non-blocking minor note about mid-stream error feedback (`updateUI`
  adding `streaming` alongside `error` during an active stream, with
  `.status-indicator.streaming` winning the CSS tie and overwriting the
  error text with `'Working...'`) is intentionally left unaddressed: the text
  clobber is pre-existing (`updateUI` has always owned the streaming text),
  only the brief red-dot suppression is new, and the flash's
  `statusFlashTimer` restore still fires at 3 s to reset the indicator. Out
  of scope for this fix.
- The pre-existing dropped `'Connected • TS'` suffix / `statusText.title`
  (set by `updateConnectionStatus`) remains unaddressed to keep the change
  scoped; it predates this branch.

---

## 4th-reviewer assessment

Branch: `fix/use-red-light-to-indicate-wrong-model-field`
Commits reviewed: `288119e`, `3f7ea7e`, `6c24f18`, `a672bc3` (i.e.
`git diff main..HEAD` on `public/app.js` and `public/style.css`).

### Confirmation of prior findings

All three earlier findings are resolved in the current tree.

- Finding 1 (stale `disconnected` class) and finding 2 (`streaming` clobbered
  on restore): `flashStatusError` now uses atomic
  `statusIndicator.className = 'status-indicator error'` on entry
  (`public/app.js` line 1340) and delegates restore to
  `restoreStatusIndicator()` (lines 1357, 57–59), which picks the current
  `connected`/`disconnected`/`streaming` state.
- 2nd-reviewer finding (red dot / status text desync when `set_model` succeeds
  but `set_thinking_level` fails): the shared `statusRestoreTimer` +
  `setStatusMessage` helper (lines 41–52 / 63–76) cancels `rpcCommand`'s
  pending `'Done'` -> `'Connected'` restore on entry, and the intermediate
  `setStatusMessage('Setting thinking...')` clears it even earlier.
- 3rd-reviewer finding (stranded red dot when an unrelated
  `setStatusMessage` cancels the flash restore): `statusFlashTimer` is now
  separate from `statusRestoreTimer` (lines 47, 63–76). `setStatusMessage`
  retires an active flash explicitly instead of cancelling its only restore,
  so the dot cannot be left red indefinitely.

`node --check public/app.js` passes.

### Findings

#### 1. `updateUI` overwrites the status text during a red-dot flash, producing a red dot beside `'Connected'`

`updateUI()` in `public/app.js` runs on every stream snapshot and on the
~10 s `pollInstances` timer (`setInterval` at line 1791). It always writes
the status bar from scratch:

```js
statusIndicator.classList.remove('streaming');
statusIndicator.classList.add('connected');
statusText.textContent = 'Connected';
```

(`public/app.js` lines 2019–2021). It never removes the `error` class, and
because `.status-indicator.error` is declared *after*
`.status-indicator.connected` in `public/style.css` (lines 1169 vs. 1152),
the dot stays red when both classes are present. So if the 10 s poll fires
inside the 3 s `flashStatusError` window — roughly a 30 % chance for any
error flash where the user takes no other action — the status text flips to
`'Connected'` while the indicator remains red until `statusFlashTimer` fires.

Before this branch, `updateUI` already clobbered transient error text with
`'Connected'`, but there was no persistent red dot to mismatch. The new
`.error` class makes the stale text state visually contradictory.

The fix is small and consistent with the rest of the change: guard the
status-bar writes in `updateUI` so they do not run while `statusFlashTimer`
is active. The remaining `updateUI` work (disabling inputs, showing the abort
button, etc.) should still run.

```js
if (statusFlashTimer === null) {
  if (isStreaming) { /* streaming status ... */ }
  else { /* connected status ... */ }
}
```

This keeps the error flash in control of the status bar for its full 3 s,
mirroring how `setStatusMessage` now supersedes the flash only when a new,
explicit status message arrives.

**Location:** `public/app.js` — `updateUI` status block lines 2014–2029,
reachable via `setInterval(pollInstances, 10000)` at line 1791 and stream
snapshot callers.

### Verdict

Needs revision (minor).

The status-indicator/timer logic is now sound: no stale classes, no stranded
red dot, and no `rpcCommand` text timer can race the error message. The one
remaining gap is that `updateUI`'s periodic and stream-driven status writes
are unaware of the active flash, so they can paint `'Connected'` over the
error text while the red dot persists. Guarding those writes with the
existing `statusFlashTimer` flag closes the last visible desync without
affecting the rest of `updateUI`.

---

## 4th-reviewer fix summary

Finding 1 (`updateUI` overwriting the status text during a red-dot flash,
producing a red dot beside `'Connected'`) addressed in `public/app.js`.

### Root cause

`flashStatusError` now owns the status indicator (red `error` class) and
`statusText` for a full 3 s via `statusFlashTimer`. However, `updateUI()`
(`public/app.js` lines 2010–2029) also writes the status bar on every stream
snapshot and on the ~10 s `pollInstances` timer (`setInterval` at line 1791).
It sets `statusText.textContent = 'Connected'` and adds the `connected` class
without removing `error`. Because `.status-indicator.error` is declared after
`.status-indicator.connected` in `public/style.css` (lines 1169 vs. 1152), the
dot stayed red while the text read `'Connected'` for the remainder of the
flash window. Before this branch there was no persistent red dot, so the text
clobber was not visually contradictory.

### Fix

Guarded the status-bar block in `updateUI` so it only runs when no error flash
is active:

```js
if (statusFlashTimer === null) {
  if (isStreaming) { /* streaming dot + 'Working...' */ }
  else { /* connected dot + 'Connected' */ }
}
```

The rest of `updateUI` (disabling `messageInput`/`sendBtn`, toggling the abort
button, etc.) continues to run normally. The flash's own restore callback
(`flashStatusError`, lines 1355–1362) re-derives the correct
`connected`/`disconnected`/`streaming` state when it fires, so the status bar
catches up after the 3 s flash expires.

### Side effects

- The non-streaming poll path can no longer paint `'Connected'` over an active
  error message, removing the red-dot / text mismatch.
- The streaming path is also guarded, so a stream snapshot during a flash no
  longer overwrites the error text with `'Working...'` and flips the dot to
  the streaming accent. The 3rd-reviewer's non-blocking "mid-stream error
  feedback is lost" note is therefore resolved as well.
- `updateConnectionStatus` (WS open/close) still resets the indicator and text
  unconditionally: a connection-state change is more important than a transient
  error flash and is the correct source of truth.
- `setStatusMessage` continues to explicitly retire an active flash via
  `restoreStatusIndicator()`, so user-initiated actions still supersede stale
  flashes as intended.

### Verification

- `node --check public/app.js` passes.
- No DOM/browser tests exist for `app.js` (the `test/` suite is server-side
  Node only), so no test changes were needed or applicable.
- The pre-existing dropped `'Connected • TS'` suffix / `statusText.title`
  (set by `updateConnectionStatus`) remains unaddressed to keep the change
  scoped; it predates this branch.

---

## 5th-reviewer assessment

Branch: `fix/use-red-light-to-indicate-wrong-model-field`
Commits reviewed: `288119e`, `3f7ea7e`, `6c24f18`, `a672bc3`, `1d66ace` (i.e.
`git diff main..HEAD` on `public/app.js` and `public/style.css`).

### Confirmation of prior findings

All four earlier findings are resolved in the current tree.

- **Finding 1** (stale `disconnected` class) and **finding 2** (`streaming`
  clobbered on restore): `flashStatusError` uses atomic
  `statusIndicator.className = 'status-indicator error'` on entry
  (`public/app.js` line 1340) and delegates restore to
  `restoreStatusIndicator()` (lines 54–59), which derives the current
  `connected`/`disconnected`/`streaming` state.
- **2nd-reviewer finding** (red dot / status text desync when `set_model`
  succeeds but `set_thinking_level` fails): the shared `statusRestoreTimer` +
  `setStatusMessage` helper (lines 41–52 / 63–76) cancels `rpcCommand`'s
  pending `'Done'` -> `'Connected'` restore, and the intermediate
  `setStatusMessage('Setting thinking...')` clears it even earlier.
- **3rd-reviewer finding** (stranded red dot when an unrelated
  `setStatusMessage` cancels the flash restore): `statusFlashTimer` is
  separate from `statusRestoreTimer` (lines 47, 63–76). `setStatusMessage`
  retires an active flash explicitly via `restoreStatusIndicator()`, so the
  dot cannot be left red indefinitely.
- **4th-reviewer finding** (`updateUI` overwriting status text during a
  red-dot flash): `updateUI` guards its status-bar writes with
  `statusFlashTimer === null` (lines 2014–2029), so poll and stream snapshots
  no longer paint `'Connected'` or `'Working...'` over an active error
  message.

`node --check public/app.js` passes.

### Findings

None.

### Verdict

Correct as-is.

The status indicator and timer logic is now fully consistent: no stale CSS
classes, no stranded timers, no text/dot desyncs, and `updateUI` correctly
defers to an active flash while `setStatusMessage` correctly retires a stale
one. No new issues were found in this round.
