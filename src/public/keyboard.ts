/**
 * Keyboard helpers shared across the web workspace.
 */

/**
 * True when a keydown belongs to an active IME composition (Chinese, Japanese,
 * Korean, etc.) and therefore belongs to the input method, not to app logic.
 * `isComposing` covers Chrome and Firefox; the `keyCode === 229` check covers
 * Safari (and some Android IMEs), which fire the composition-confirming Enter
 * after compositionend with `isComposing` false. `keyCode` is deprecated but
 * this pair is the accepted cross-browser idiom for exactly this case.
 *
 * Every keydown handler should bail out on these events as its first check, so
 * that no composition keystroke (Enter to confirm, arrows to pick candidates,
 * Escape to cancel) ever triggers app behavior.
 */
export function isImeComposition(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}
