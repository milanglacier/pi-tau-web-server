# Don't submit the chat input when Enter confirms an IME composition

## Context

When a user types with an input method editor (IME — e.g. Chinese, Japanese, Korean input on PC) and presses Enter, their intent is to confirm the current composition, not to send the message. The web workspace's keydown handlers intercept that Enter and submit whatever is in the input box, which is undesirable.

This affects **all browsers**, not just Safari: Chrome and Firefox fire the composition-confirming Enter as a `keydown` with `key === 'Enter'` and `isComposing === true`, and our handlers only check `e.key === 'Enter'`, so they submit anyway. The fix is the standard guard: ignore Enter keydown events that are part of a composition (`event.isComposing` covers Chrome/Firefox; the additional `keyCode === 229` check covers the Safari quirk where the confirming Enter keydown fires after `compositionend` with `isComposing === false`).

No handler in the codebase currently has this protection. The same bug class exists in five Enter handlers; all should be fixed the same way.

## The guard pattern

At the top of each Enter branch (or handler), bail out when the event is part of an IME composition:

```typescript
if (e.isComposing || e.keyCode === 229) return;
```

(`keyCode` is deprecated but this is the accepted cross-browser idiom for this exact case; TypeScript's DOM lib still types it.)

## Files to change (TypeScript sources in `src/public/`; `public/*.js` are compiled artifacts)

1. **`src/public/app-main.ts:1025-1031`** — the main chat message input (`#message-input` textarea). This is the handler the bug report is about. Guard the `e.key === 'Enter' && !e.shiftKey` branch so a composition-confirming Enter neither sends nor calls `preventDefault()`.

2. **`src/public/model-picker.ts:410-446`** — the model picker input's keydown handler. Guard at the top of the handler (it also handles ArrowUp/ArrowDown/Escape, which IMEs can use for candidate navigation, so an early return for any composing key event is correct here).

3. **`src/public/dialogs.ts:122-124`** — the generic input dialog. Convert the deprecated `keypress` listener to `keydown` with the same guard, keeping the Enter→`submit()` behavior.

4. **`src/public/session-sidebar.ts:332-335`** — the session rename input. Without the guard, a composition Enter blurs the input and commits the rename mid-composition, losing the composed text.

5. **`src/public/tree-view.ts:397-400`** (listener registered at line 451) — document-level capture-phase keydown for the tree modal. Guard at the top of `onKeyDown`; as a capture-phase document listener it would otherwise swallow composition keys before they reach any focused input.

## Build step

After editing, regenerate the checked-in compiled output:

```
npx tsc -p tsconfig.public.json
```

This recompiles `src/public/*.ts` into `public/*.js` (the artifacts are committed to the repo).

## Verification

1. `npx tsc -p tsconfig.public.json` compiles cleanly and the corresponding `public/*.js` files contain the new guards.
2. Automated check with `agent-browser-wrapped`: load the workspace, focus `#message-input`, type text, then dispatch a synthetic `KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })` — the message must NOT be sent and the text must remain in the box. Then dispatch a plain Enter keydown (`isComposing: false`) and confirm the message IS sent, and that Shift+Enter still inserts a newline.
3. Manual sanity check (real IME behavior can't be fully simulated): type with an IME in the chat box, press Enter to confirm the composition — the text is committed to the textarea without sending; a second Enter sends it.
