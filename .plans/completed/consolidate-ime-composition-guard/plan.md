# Consolidate the IME composition guard into one shared helper

## Context

Commit `ba75e2a` fixed the bug where the Enter that confirms an IME composition (Chinese, Japanese, Korean input) submitted the chat input, by adding `if (e.isComposing || e.keyCode === 229) return;` to five keydown handlers. The mechanism is the standard cross-browser idiom — `isComposing` is the UI Events spec property marking composition key events, and `keyCode === 229` covers Safari, which fires the confirming Enter after `compositionend` with `isComposing` false — so it stays.

What was non-standard about that commit is the shape, not the mechanism:

- The identical two-clause guard was pasted into five files, each with its own copy of the explanatory comment, and any future keydown handler can silently forget it.
- The chat-input handler nested its guard inside the `e.key === 'Enter' && !e.shiftKey` branch. That is behaviorally identical (the handler acts on no other key) but encodes the invariant per key branch instead of stating it once at the top of the handler like the other four sites, and would silently break if another key branch were added later.
- One handler with the same bug class was missed: the global keyboard-shortcuts listener in `src/public/app-main.ts` — an Escape that cancels an IME composition inside the message input bubbles to `document` and can abort a streaming response or close panels.

The invariant to preserve: no key event that belongs to an active IME composition (Enter to confirm, arrows to pick candidates, Escape to cancel) should ever trigger app behavior; those keystrokes belong to the input method.

## Changes

1. **New file `src/public/keyboard.ts`** exporting one helper, with the Safari/keyCode-229 rationale documented once:
   ```typescript
   export function isImeComposition(e: KeyboardEvent): boolean {
     return e.isComposing || e.keyCode === 229;
   }
   ```

2. **Replace the five inline guards** with `if (isImeComposition(e)) return;` placed uniformly as the **first line of each handler** (importing from `./keyboard.js`, matching the existing `./app-types.js` import style):
   - `src/public/app-main.ts` (chat input — move the guard from inside the Enter branch to the top of the handler)
   - `src/public/model-picker.ts`
   - `src/public/dialogs.ts`
   - `src/public/session-sidebar.ts`
   - `src/public/tree-view.ts`

3. **Add the same guard to the global shortcuts listener** at the top of the `document.addEventListener('keydown', ...)` handler in `src/public/app-main.ts`, so Escape/`/` pressed during a composition never trigger app shortcuts.

4. **Rebuild the checked-in compiled artifacts**: `npx tsc -p tsconfig.public.json` (regenerates `public/*.js`, including the new `public/keyboard.js`).

## Verification

1. `npx tsc -p tsconfig.public.json` compiles cleanly; `public/*.js` reference the shared helper and `public/keyboard.js` exists.
2. With `agent-browser-wrapped`: focus `#message-input`, type text, dispatch `new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })` — the message must not send; dispatch a plain Enter — the message sends; Shift+Enter still inserts a newline. Dispatch `Escape` with `isComposing: true` — no panel closes and streaming is not aborted.
