import type { MessageContentBlock } from './app-types.js';

// ═══════════════════════════════════════
// Session Tree View
// ═══════════════════════════════════════
// Centered modal (same overlay/frosted-sheet pattern as the model picker)
// that renders pi's session entry tree (get_tree RPC) and lets the user jump
// the active leaf to any earlier entry via the backend-local navigate_tree
// RPC command. The conversation itself re-renders when the server broadcasts
// a fresh snapshot after the leaf moves — this module never re-renders the
// message list itself.

type TreeEntryMessage = {
  role?: string;
  content?: string | MessageContentBlock[];
  toolName?: string;
  [key: string]: unknown;
};

type TreeEntry = {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: TreeEntryMessage;
  customType?: string;
  content?: string;
  summary?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  name?: string;
  label?: string;
  [key: string]: unknown;
};

type TreeNode = {
  entry: TreeEntry;
  children: TreeNode[];
  label?: string;
  labelTimestamp?: string;
};

type FlatRow = { node: TreeNode; depth: number };

type TreeViewOptions = {
  getActiveLiveSessionId(): string | null;
  isStreaming(): boolean;
  setComposerText(text: string): void;
  flashStatusError(message: string, ms?: number): void;
};

const HINT_DEFAULT = '↑↓ move · Enter jump · Esc close';
const HINT_STREAMING = 'Session is streaming — navigation is disabled until the turn finishes.';

// customType of the internal marker entries the server appends to persist a
// leaf move (keep in sync with NAVIGATION_MARKER_TYPE in src/server/tree.ts).
// They are tau plumbing, not conversation content, so the tree never shows
// them — not even in "All entries" mode.
const NAVIGATION_MARKER_TYPE = 'tau:navigate-tree';

// Indent guides are capped so deeply-branched trees stay readable on narrow
// screens (depth counts branch points, not entries — see flatten()).
const MAX_GUIDE_DEPTH = 6;

// Small inline-SVG role glyphs, matching the app's existing icon style
// (16px, stroke currentColor).
const SVG_ATTRS = 'width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const ICONS: Record<string, string> = {
  user: `<svg ${SVG_ATTRS}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  assistant: `<svg ${SVG_ATTRS}><path d="M12 3l2 5.5L19.5 10 14 12l-2 5.5L10 12l-5.5-2L10 8.5z"/></svg>`,
  tool: `<svg ${SVG_ATTRS}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`,
  compaction: `<svg ${SVG_ATTRS}><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`,
  meta: `<svg ${SVG_ATTRS}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
};

function firstLine(text: string) {
  return (String(text || '').split('\n').find((line) => line.trim()) || '').trim();
}

function messageText(msg: TreeEntryMessage | undefined) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
  }
  return '';
}

// Classify an entry for glyph + filtering, and produce the one-line snippet.
function describeEntry(entry: TreeEntry): { kind: string; text: string } {
  if (entry.type === 'message') {
    const role = entry.message?.role || '';
    if (role === 'user') return { kind: 'user', text: firstLine(messageText(entry.message)) || '(empty message)' };
    if (role === 'assistant') {
      const text = firstLine(messageText(entry.message));
      if (text) return { kind: 'assistant', text };
      const toolNames = Array.isArray(entry.message?.content)
        ? entry.message.content.filter((b) => b.type === 'toolCall').map((b) => b.name || 'tool').join(', ')
        : '';
      return { kind: 'assistant', text: toolNames ? `→ ${toolNames}` : '(empty message)' };
    }
    if (role === 'toolResult') return { kind: 'tool', text: entry.message?.toolName || 'tool result' };
    return { kind: 'meta', text: firstLine(messageText(entry.message)) || role || 'message' };
  }
  if (entry.type === 'custom_message') {
    return { kind: 'user', text: firstLine(String(entry.content || '')) || entry.customType || 'custom message' };
  }
  if (entry.type === 'custom') return { kind: 'meta', text: entry.customType || 'custom' };
  if (entry.type === 'compaction') {
    const summary = firstLine(String(entry.summary || ''));
    return { kind: 'compaction', text: summary ? `Compaction — ${summary}` : 'Compaction' };
  }
  if (entry.type === 'branch_summary') {
    const summary = firstLine(String(entry.summary || ''));
    return { kind: 'compaction', text: summary ? `Branch summary — ${summary}` : 'Branch summary' };
  }
  // Model id can contain slashes; display is always the provider/id join.
  if (entry.type === 'model_change') return { kind: 'meta', text: `model → ${[entry.provider, entry.modelId].filter(Boolean).join('/')}` };
  if (entry.type === 'thinking_level_change') return { kind: 'meta', text: `thinking → ${entry.thinkingLevel || ''}` };
  if (entry.type === 'session_info') return { kind: 'meta', text: `name → ${entry.name || ''}` };
  if (entry.type === 'label') return { kind: 'meta', text: `label → ${entry.label || ''}` };
  return { kind: 'meta', text: entry.type || 'entry' };
}

export function setupTreeView(options: TreeViewOptions) {
  const { getActiveLiveSessionId, isStreaming, setComposerText, flashStatusError } = options;

  // Static index.html shell elements — assert non-null at the query site,
  // matching the other setup modules.
  const treeBtn = document.getElementById('tree-btn')!;
  const overlay = document.getElementById('tree-view-overlay')!;
  const modal = document.getElementById('tree-view')!;
  const listEl = document.getElementById('tree-view-list')!;
  const messageEl = document.getElementById('tree-view-message')!;
  const filterBtn = document.getElementById('tree-view-filter')!;
  const closeBtn = document.getElementById('tree-view-close')!;

  let treeData: TreeNode[] = [];
  let leafId: string | null = null;
  let showAll = false; // default: messages only (pi's default /tree filter)
  let rows: FlatRow[] = [];
  let rowEls: HTMLButtonElement[] = [];
  let activeIndex = -1;
  let openSessionId: string | null = null;
  let navigating = false;

  function isOpen() {
    return !modal.classList.contains('hidden');
  }

  function setMessage(text: string, isError = false) {
    messageEl.textContent = text;
    messageEl.classList.toggle('error', isError);
  }

  function updateFilterButton() {
    filterBtn.textContent = showAll ? 'All entries' : 'Messages only';
    filterBtn.setAttribute('aria-pressed', showAll ? 'true' : 'false');
    filterBtn.title = showAll ? 'Showing every entry — click to hide tool results and housekeeping entries' : 'Hiding tool results and housekeeping entries — click to show every entry';
  }

  // Flatten the tree depth-first. Depth counts BRANCH POINTS, not entries: a
  // linear run of parent→child entries stays at one indent level and only a
  // node with several children pushes its children one level deeper —
  // otherwise every ordinary exchange would gain a level and long sessions
  // would indent themselves off-screen. Filtered-out entries never render:
  // their children are promoted into their place (at the depth the hidden
  // entry would have had), so the branch structure stays readable in
  // messages-only mode. "Messages only" mirrors pi's no-tools filter: tool
  // results and housekeeping entries (model/thinking/name changes, custom
  // meta entries) are hidden, messages and compactions stay. tau's internal
  // navigation markers are plumbing and are hidden in every mode.
  function flatten(nodes: TreeNode[], depth: number, out: FlatRow[]) {
    for (const node of nodes) {
      const entry = node.entry;
      const isInternalMarker = entry.type === 'custom' && entry.customType === NAVIGATION_MARKER_TYPE;
      const kind = describeEntry(entry).kind;
      const hidden = isInternalMarker || (!showAll && (kind === 'tool' || kind === 'meta'));
      if (!hidden) out.push({ node, depth });
      const childDepth = depth + ((node.children || []).length > 1 ? 1 : 0);
      flatten(node.children, childDepth, out);
    }
    return out;
  }

  // ids on the active path (root → current leaf), derived by walking
  // parentId links from the leaf.
  function computeActivePath(): Set<string> {
    const byId = new Map<string, TreeEntry>();
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.entry?.id) byId.set(node.entry.id, node.entry);
        walk(node.children || []);
      }
    };
    walk(treeData);
    const path = new Set<string>();
    let cursor = leafId;
    while (cursor && byId.has(cursor) && !path.has(cursor)) {
      path.add(cursor);
      cursor = byId.get(cursor)?.parentId || null;
    }
    return path;
  }

  function setActiveIndex(index: number, scroll = false) {
    if (!rows.length) { activeIndex = -1; listEl.removeAttribute('aria-activedescendant'); return; }
    activeIndex = Math.max(0, Math.min(index, rows.length - 1));
    rowEls.forEach((el, i) => {
      const active = i === activeIndex;
      el.classList.toggle('active', active);
      el.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    // Keep the roving highlight visible to screen readers: DOM focus stays on
    // the listbox, aria-activedescendant follows the highlighted option.
    const activeEl = rowEls[activeIndex];
    if (activeEl?.id) listEl.setAttribute('aria-activedescendant', activeEl.id);
    if (scroll) activeEl?.scrollIntoView({ block: 'nearest' });
  }

  function render(scrollLeafIntoView = false) {
    rows = flatten(treeData, 0, []);
    rowEls = [];
    listEl.innerHTML = '';
    listEl.removeAttribute('aria-activedescendant');
    const path = computeActivePath();
    const streaming = isStreaming();
    setMessage(streaming ? HINT_STREAMING : HINT_DEFAULT, false);
    listEl.classList.toggle('tree-view-inert', streaming);

    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'tree-view-empty';
      empty.textContent = 'No entries in this session yet.';
      listEl.appendChild(empty);
      activeIndex = -1;
      return;
    }

    // The "current" marker goes on the DEEPEST VISIBLE row of the active
    // path, not on the raw leaf entry: the leaf is often hidden (tau's
    // navigation marker, a filtered tool result) or a housekeeping entry
    // appended below the spot the user actually jumped to. DFS order lists
    // ancestors before descendants, so the last on-path row is the deepest.
    let currentIndex = -1;
    rows.forEach((row, index) => {
      if (row.node.entry.id && path.has(row.node.entry.id)) currentIndex = index;
    });

    rows.forEach((row, index) => {
      const entry = row.node.entry;
      const { kind, text } = describeEntry(entry);
      const onPath = !!entry.id && path.has(entry.id);
      const isCurrent = index === currentIndex;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = `tree-row-${index}`;
      btn.className = `tree-row${onPath ? ' on-path' : ''}${isCurrent ? ' leaf' : ''}`;
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', 'false');
      if (streaming) btn.disabled = true;
      btn.title = text;

      const guides = document.createElement('span');
      guides.className = 'tree-guides';
      for (let i = 0; i < Math.min(row.depth, MAX_GUIDE_DEPTH); i++) {
        const guide = document.createElement('span');
        guide.className = 'tree-guide';
        guides.appendChild(guide);
      }
      btn.appendChild(guides);

      const icon = document.createElement('span');
      icon.className = `tree-row-icon tree-row-icon-${kind}`;
      icon.innerHTML = ICONS[kind] || ICONS.meta;
      btn.appendChild(icon);

      const snippet = document.createElement('span');
      snippet.className = 'tree-row-text';
      snippet.textContent = text;
      btn.appendChild(snippet);

      const label = row.node.label;
      if (label) {
        const badge = document.createElement('span');
        badge.className = 'tree-row-label';
        badge.textContent = label;
        btn.appendChild(badge);
      }

      if (isCurrent) {
        const current = document.createElement('span');
        current.className = 'tree-row-current';
        current.textContent = 'current';
        btn.appendChild(current);
      }

      btn.addEventListener('mouseenter', () => setActiveIndex(index));
      btn.addEventListener('click', () => { void selectRow(index); });
      listEl.appendChild(btn);
      rowEls.push(btn);
    });

    setActiveIndex(currentIndex >= 0 ? currentIndex : rows.length - 1);
    if (scrollLeafIntoView) {
      requestAnimationFrame(() => rowEls[activeIndex]?.scrollIntoView({ block: 'center' }));
    }
  }

  async function selectRow(index: number) {
    const row = rows[index];
    const entryId = row?.node.entry?.id;
    if (!entryId || navigating) return;
    if (isStreaming()) {
      setMessage(HINT_STREAMING, false);
      return;
    }
    const sessionId = openSessionId || getActiveLiveSessionId();
    if (!sessionId) {
      setMessage('Select a live Tau tab first.', true);
      return;
    }
    navigating = true;
    setMessage('Jumping…', false);
    try {
      const resp = await fetch('/api/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'navigate_tree', sessionId, entryId }),
      });
      const data = await resp.json();
      if (data?.success) {
        const editorText = data.data?.editorText;
        close();
        // The conversation re-renders when the server broadcasts a fresh
        // snapshot; we only need to hand the message text to the composer.
        if (typeof editorText === 'string') setComposerText(editorText);
      } else {
        const error = data?.error || 'Failed to navigate the session tree';
        setMessage(error, true);
        flashStatusError(error);
      }
    } catch {
      const error = 'Failed to navigate the session tree';
      setMessage(error, true);
      flashStatusError(error);
    } finally {
      navigating = false;
    }
  }

  // Page step for PageUp/PageDown, mirroring pi's TUI tree paging.
  const PAGE_STEP = 10;

  function onKeyDown(e: KeyboardEvent) {
    if (!isOpen()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (!rows.length) return;
    // Arrow keys wrap around like the model picker's list.
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((activeIndex + 1) % rows.length, true);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((activeIndex - 1 + rows.length) % rows.length, true);
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      setActiveIndex(0, true);
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      setActiveIndex(rows.length - 1, true);
      return;
    }
    if (e.key === 'PageDown') {
      e.preventDefault();
      setActiveIndex(activeIndex + PAGE_STEP, true);
      return;
    }
    if (e.key === 'PageUp') {
      e.preventDefault();
      setActiveIndex(activeIndex - PAGE_STEP, true);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0) void selectRow(activeIndex);
    }
  }

  // Monotonic sequence so a slow get_tree response never clobbers a newer one
  // (open → turn-end reload → snapshot reload can overlap).
  let loadSeq = 0;

  async function loadTree(centerCurrent: boolean) {
    const sessionId = openSessionId;
    if (!sessionId) return;
    const seq = ++loadSeq;
    try {
      const resp = await fetch('/api/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'get_tree', sessionId }),
      });
      const data = await resp.json();
      if (!isOpen() || openSessionId !== sessionId || seq !== loadSeq) return;
      if (!data?.success || !data.data) {
        setMessage(data?.error || 'Failed to load the session tree', true);
        return;
      }
      treeData = (data.data.tree || []) as TreeNode[];
      leafId = (data.data.leafId as string | null) ?? null;
      render(centerCurrent);
    } catch {
      if (isOpen() && openSessionId === sessionId && seq === loadSeq) {
        setMessage('Failed to load the session tree', true);
      }
    }
  }

  async function open() {
    const sessionId = getActiveLiveSessionId();
    if (!sessionId) {
      flashStatusError('Select a live Tau tab first.');
      return;
    }
    openSessionId = sessionId;
    treeData = [];
    leafId = null;
    rows = [];
    rowEls = [];
    activeIndex = -1;
    listEl.innerHTML = '';
    listEl.classList.remove('tree-view-inert');
    updateFilterButton();
    setMessage('Loading session tree…', false);
    modal.classList.remove('hidden');
    overlay.classList.remove('hidden');
    document.addEventListener('keydown', onKeyDown, true);
    // Move focus into the dialog (the model picker focuses its input the same
    // way) so Tab does not keep walking the page behind the overlay and the
    // listbox's aria-activedescendant highlight is announced.
    listEl.focus();
    await loadTree(true);
  }

  function close() {
    const hadFocus = modal.contains(document.activeElement);
    modal.classList.add('hidden');
    overlay.classList.add('hidden');
    document.removeEventListener('keydown', onKeyDown, true);
    listEl.innerHTML = '';
    listEl.removeAttribute('aria-activedescendant');
    treeData = [];
    rows = [];
    rowEls = [];
    activeIndex = -1;
    openSessionId = null;
    // Hand focus back to the button that opened the dialog.
    if (hadFocus && treeBtn instanceof HTMLElement && !treeBtn.classList.contains('hidden')) treeBtn.focus();
  }

  // Keep an open modal in sync with the session's live state instead of
  // freezing whatever was true at open time. Streaming starting disables the
  // rows in place; streaming ending means the turn appended entries, so the
  // tree is refetched (which also re-enables the rows and re-centers on the
  // new current position).
  function notifyStreamingChanged(sessionId: string | null | undefined, streaming: boolean) {
    if (!isOpen() || !openSessionId || (sessionId && sessionId !== openSessionId)) return;
    if (streaming) {
      listEl.classList.add('tree-view-inert');
      rowEls.forEach((el) => { el.disabled = true; });
      if (!navigating) setMessage(HINT_STREAMING, false);
    } else {
      void loadTree(true);
    }
  }

  // Another client moved this session's leaf (the server broadcast a fresh
  // snapshot) — refetch so the displayed tree is not stale.
  function notifyTreeChanged(sessionId: string | null | undefined) {
    if (!isOpen() || !openSessionId || (sessionId && sessionId !== openSessionId)) return;
    if (!navigating) void loadTree(true);
  }

  function closeIfOpen() {
    if (!isOpen()) return false;
    close();
    return true;
  }

  // Header entry button visibility is gated on having an active live
  // session, mirroring the other session-dependent header controls.
  function setVisible(visible: boolean) {
    treeBtn.classList.toggle('hidden', !visible);
  }

  filterBtn.addEventListener('click', () => {
    showAll = !showAll;
    updateFilterButton();
    // Re-render with centering, like open(): rebuilding the list resets the
    // scroll position, so without it toggling the filter would throw the view
    // back to the session root and lose the current position.
    if (treeData.length || leafId) render(true);
  });
  treeBtn.addEventListener('click', () => { void open(); });
  overlay.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  // Focusable so open() can move focus into the dialog; keyboard interaction
  // is roving-highlight (aria-activedescendant), not per-row tab stops.
  (listEl as HTMLElement).tabIndex = -1;
  updateFilterButton();

  return { open, close, closeIfOpen, setVisible, notifyStreamingChanged, notifyTreeChanged };
}
