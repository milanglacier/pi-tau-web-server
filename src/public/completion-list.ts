import { isImeComposition } from './keyboard.js';

export type CompletionItem = {
  /** Main text of the row. */
  primary: string;
  /** Small tag shown after the main text. */
  badge?: string;
  /** Dim text shown on the right. */
  meta?: string;
  /** Text put into the input when the row is accepted. */
  value: string;
  /** Where the caret goes inside `value` after accepting. The end of `value` by default. */
  caretOffset?: number;
  /** Ask for rows again right after this row is accepted. Overrides the list-wide setting. */
  continueAfterAccept?: boolean;
  /** True when the text before the caret already is this row. Enter then has nothing to complete and is left to the input. */
  alreadyTyped?: boolean;
  /** Remove a `"` that directly follows the caret, because `value` closes its own quote. */
  skipQuoteAfterCaret?: boolean;
};

/** The part of the text before the caret that a list works on. */
export type CompletionContext = {
  /** Where the text to replace starts. It ends at the caret. */
  start: number;
  /** The text the rows are looked up with. */
  query: string;
};

type CompletionListOptions<Context extends CompletionContext> = {
  input: HTMLInputElement | HTMLTextAreaElement;
  /**
   * Find the part of the text before the caret that the list completes, or
   * return null to show no list. Accepting a row replaces only that part.
   * Without it, the whole value is the query and accepting replaces all of it.
   */
  getContext?(textBeforeCaret: string): Context | null;
  /** Return the rows for a query. A stale call is aborted through `signal`. */
  getItems(query: string, signal: AbortSignal, context: Context): Promise<CompletionItem[]> | CompletionItem[];
  /** Highlight the first row as soon as rows appear, so Enter accepts it. */
  highlightFirst?: boolean;
  /** Ask for rows again right after a row is accepted, to keep drilling down. */
  continueAfterAccept?: boolean;
  /** Wait this long after typing before asking for rows. May depend on what is being completed. */
  debounceMs?: number | ((context: Context) => number);
  /**
   * Show the list inside this element, above the input, instead of in a
   * wrapper below it. The element must be positioned.
   */
  anchorAbove?: HTMLElement;
};

/**
 * Attach a suggestion dropdown to a text input or text area.
 *
 * Arrow keys move the highlight. Tab accepts the highlighted row, or the first
 * row when none is highlighted. Enter accepts a highlighted row, unless the
 * row is already fully typed, and otherwise behaves normally (for example,
 * submitting a form). Escape closes the list.
 * While a list is open, these keys are handled here and reach no other
 * listener on the input.
 */
export function attachCompletionList<Context extends CompletionContext = CompletionContext>(options: CompletionListOptions<Context>) {
  const { input, getContext, getItems, highlightFirst = false, continueAfterAccept = false, debounceMs = 0, anchorAbove } = options;

  const list = document.createElement('div');
  list.className = 'completion-list hidden';
  list.setAttribute('role', 'listbox');
  if (anchorAbove) {
    list.classList.add('above');
    anchorAbove.appendChild(list);
  } else {
    const wrap = document.createElement('div');
    wrap.className = 'completion-wrap';
    input.parentNode!.insertBefore(wrap, input);
    wrap.appendChild(input);
    wrap.appendChild(list);
  }

  let items: CompletionItem[] = [];
  let active = -1;
  let requestId = 0;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The text that accepting a row replaces, fixed when the rows were asked for.
  let replaceStart = 0;
  let replaceEnd = 0;
  // Set while this list sends its own `input` event, so it does not treat
  // the event as typing.
  let announcingAccept = false;

  function isOpen() {
    return items.length > 0;
  }

  function close() {
    if (timer) clearTimeout(timer);
    timer = null;
    controller?.abort();
    requestId++;
    items = [];
    active = -1;
    list.innerHTML = '';
    list.classList.add('hidden');
  }

  function paintActive() {
    list.querySelectorAll('.model-item').forEach((row, index) => {
      row.classList.toggle('active', index === active);
      row.setAttribute('aria-selected', index === active ? 'true' : 'false');
    });
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  }

  function render() {
    list.innerHTML = '';
    list.classList.toggle('hidden', !items.length);
    items.forEach((item, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'model-item';
      row.setAttribute('role', 'option');
      const name = document.createElement('span');
      name.className = 'model-item-name';
      name.textContent = item.primary;
      if (item.badge) {
        const badge = document.createElement('span');
        badge.className = 'model-item-provider';
        badge.textContent = item.badge;
        name.appendChild(badge);
      }
      const meta = document.createElement('span');
      meta.className = 'model-item-context';
      meta.textContent = item.meta || '';
      row.append(name, meta);
      // Keep focus in the input while the pointer is used on the list.
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('mouseenter', () => { active = index; paintActive(); });
      row.addEventListener('click', () => accept(index));
      list.appendChild(row);
    });
    paintActive();
  }

  /** What to look up for the text and caret as they are now, or null for nothing. */
  function readContext() {
    if (!getContext) {
      return { start: 0, end: input.value.length, context: { start: 0, query: input.value } as Context };
    }
    const caret = input.selectionStart ?? input.value.length;
    const context = getContext(input.value.slice(0, caret));
    return context ? { start: context.start, end: caret, context } : null;
  }

  async function refresh() {
    controller?.abort();
    const current = ++requestId;
    const found = readContext();
    if (!found) {
      close();
      return;
    }
    controller = new AbortController();
    replaceStart = found.start;
    replaceEnd = found.end;
    try {
      const result = await getItems(found.context.query, controller.signal, found.context);
      if (current !== requestId) return;
      items = result;
      active = highlightFirst && items.length ? 0 : -1;
      render();
    } catch {
      if (current !== requestId) return;
      items = [];
      active = -1;
      render();
    }
  }

  function accept(index: number) {
    const item = items[index];
    if (!item) return;
    const start = replaceStart;
    const end = replaceEnd + (item.skipQuoteAfterCaret && input.value[replaceEnd] === '"' ? 1 : 0);
    const keepGoing = item.continueAfterAccept ?? continueAfterAccept;
    close();
    input.value = input.value.slice(0, start) + item.value + input.value.slice(end);
    input.focus();
    const caret = start + (item.caretOffset ?? item.value.length);
    input.setSelectionRange(caret, caret);
    // Let other listeners on the input see the new text.
    announcingAccept = true;
    try { input.dispatchEvent(new Event('input', { bubbles: true })); } finally { announcingAccept = false; }
    if (keepGoing) refresh();
  }

  // The union of input types makes `addEventListener` lose its key typing.
  const target: HTMLElement = input;

  target.addEventListener('input', () => {
    if (announcingAccept) return;
    close();
    const found = readContext();
    if (!found) return;
    timer = setTimeout(refresh, typeof debounceMs === 'function' ? debounceMs(found.context) : debounceMs);
  });

  target.addEventListener('keydown', (e) => {
    if (isImeComposition(e) || !isOpen()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopImmediatePropagation();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + items.length) % items.length;
      paintActive();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation();
      accept(active >= 0 ? active : 0);
    } else if (e.key === 'Enter' && !e.shiftKey && active >= 0 && items[active].alreadyTyped) {
      close();
    } else if (e.key === 'Enter' && !e.shiftKey && active >= 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      accept(active);
    } else if (getContext && ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
      // The caret is leaving the text the rows were found for.
      close();
    }
  });

  if (getContext) target.addEventListener('click', close);
  target.addEventListener('blur', close);

  return { close, isOpen };
}
