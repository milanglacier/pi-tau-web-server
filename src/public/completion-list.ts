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
};

type CompletionListOptions = {
  input: HTMLInputElement;
  /** Return the rows for the current text. A stale call is aborted through `signal`. */
  getItems(text: string, signal: AbortSignal): Promise<CompletionItem[]> | CompletionItem[];
  /** Highlight the first row as soon as rows appear, so Enter accepts it. */
  highlightFirst?: boolean;
  /** Ask for rows again right after a row is accepted, to keep drilling down. */
  continueAfterAccept?: boolean;
  /** Wait this long after typing before asking for rows. */
  debounceMs?: number;
};

/**
 * Attach a suggestion dropdown to a text input.
 *
 * Arrow keys move the highlight. Tab accepts the highlighted row, or the first
 * row when none is highlighted. Enter accepts a highlighted row and otherwise
 * behaves normally (for example, submitting a form). Escape closes the list.
 */
export function attachCompletionList(options: CompletionListOptions) {
  const { input, getItems, highlightFirst = false, continueAfterAccept = false, debounceMs = 0 } = options;

  const wrap = document.createElement('div');
  wrap.className = 'completion-wrap';
  input.parentNode!.insertBefore(wrap, input);
  wrap.appendChild(input);
  const list = document.createElement('div');
  list.className = 'completion-list hidden';
  list.setAttribute('role', 'listbox');
  wrap.appendChild(list);

  let items: CompletionItem[] = [];
  let active = -1;
  let requestId = 0;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

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

  async function refresh() {
    controller?.abort();
    const current = ++requestId;
    controller = new AbortController();
    try {
      const result = await getItems(input.value, controller.signal);
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
    if (timer) clearTimeout(timer);
    input.value = item.value;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    if (continueAfterAccept) refresh();
    else close();
  }

  input.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(refresh, debounceMs);
  });

  input.addEventListener('keydown', (e) => {
    if (isImeComposition(e) || !isOpen()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + items.length) % items.length;
      paintActive();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      accept(active >= 0 ? active : 0);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      accept(active);
    }
  });

  input.addEventListener('blur', close);

  return { close };
}
