/*
 * Session-tree navigation for the backend-local `navigate_tree` RPC command.
 *
 * pi stores a session as an append-only JSONL tree (entries have id/parentId;
 * the current position is the "leaf"). pi's native RPC protocol only exposes
 * READ-ONLY tree commands (get_tree / get_entries) — there is no command that
 * moves the leaf — so tau bundles a small pi extension
 * (src/pi-extension/tau-tree.ts, loaded into every child via `--extension`)
 * that registers a `/tau-tree-navigate <entryId>` command. The handler calls
 * pi's own ctx.navigateTree() — the same API the TUI /tree uses — so the move
 * happens in-process, respects other extensions' session_before_tree hooks,
 * and persists itself by appending a `custom` marker entry (pi derives the
 * leaf from the LAST entry on load, so a bare in-memory move would not
 * survive a restart). Matched extension commands never reach the LLM and
 * never append a user message, so neither the command text nor the marker is
 * visible to the model.
 *
 * navigateTree below drives that command over RPC: it resolves the target
 * from a preflight get_tree, sends the prompt, then re-fetches the tree to
 * refresh session.entries and VERIFY the move — a handler error does not fail
 * the prompt response (pi reports it as an `extension_error` event instead),
 * so the follow-up get_tree is the real success check.
 *
 * Selection semantics mirror pi's /tree (docs/sessions.md "Selection
 * Behavior"); the extension delegates them to ctx.navigateTree, and tau
 * re-derives them here (selectNavigationTarget) only to detect no-ops, verify
 * the new leaf, and hand the client its editorText — RPC-mode extensions
 * cannot fill an editor:
 *   - user (or custom) MESSAGE entry → the leaf moves to the entry's PARENT
 *     and the message text goes back as editorText so the client can put it
 *     in the input box for edit + resubmit (root user message → reset to an
 *     empty conversation).
 *   - any other entry → the leaf moves TO that entry, no editorText.
 */

import type { JsonRecord, RpcCommand, RpcResponse } from './types.js';

/**
 * Name of the slash command registered by tau's bundled pi extension.
 * Keep in sync with NAVIGATE_COMMAND in src/pi-extension/tau-tree.ts.
 */
export const NAVIGATE_COMMAND = 'tau-tree-navigate';

/**
 * customType of the marker entries the extension appends to persist a leaf
 * move. Keep in sync with src/pi-extension/tau-tree.ts (and the frontend
 * constant in src/public/tree-view.ts, which hides markers from the tree).
 */
export const NAVIGATION_MARKER_TYPE = 'tau:navigate-tree';

/** Loosely-typed session entry as stored in the JSONL file / returned by get_tree. */
export type TreeEntry = {
  id: string;
  parentId: string | null;
  type?: string;
  message?: { role?: string; content?: unknown };
  content?: unknown;
  customType?: string;
  [key: string]: unknown;
};

export type SessionTreeNodeLike = { entry: TreeEntry; children?: SessionTreeNodeLike[] };

export type NavigationTarget = {
  /** Entry id the leaf should move to; null means reset to an empty conversation. */
  leafTargetId: string | null;
  /** Message text for the client's input box (user/custom message targets only). */
  editorText?: string;
};

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type?: unknown; text?: unknown } => !!b && typeof b === 'object')
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

/**
 * Decide where the leaf should move for a navigation target, mirroring pi's
 * /tree selection behavior. Pure function — exported for tests.
 */
export function selectNavigationTarget(entry: TreeEntry): NavigationTarget {
  if (entry.type === 'message' && entry.message?.role === 'user') {
    return { leafTargetId: entry.parentId ?? null, editorText: textFromContent(entry.message.content) };
  }
  if (entry.type === 'custom_message') {
    return { leafTargetId: entry.parentId ?? null, editorText: textFromContent(entry.content) };
  }
  return { leafTargetId: entry.id };
}

/** Flatten get_tree nodes (possibly multiple roots) into an id → entry map. */
export function flattenTree(nodes: SessionTreeNodeLike[] | undefined | null): Map<string, TreeEntry> {
  const byId = new Map<string, TreeEntry>();
  const stack = [...(nodes || [])];
  while (stack.length) {
    const node = stack.pop();
    if (!node || !node.entry || typeof node.entry.id !== 'string') continue;
    byId.set(node.entry.id, node.entry);
    if (node.children && node.children.length) stack.push(...node.children);
  }
  return byId;
}

/** Walk root→leaf along parentId links; returns [] for a null/unknown leaf. */
export function pathFromRoot(byId: Map<string, TreeEntry>, leafId: string | null | undefined): TreeEntry[] {
  const path: TreeEntry[] = [];
  const seen = new Set<string>();
  let current = leafId ? byId.get(leafId) : undefined;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  path.reverse();
  return path;
}

/** True when `leafId` is `ancestorId` or one of its descendants. */
export function leafDescendsFrom(byId: Map<string, TreeEntry>, leafId: string | null | undefined, ancestorId: string): boolean {
  const seen = new Set<string>();
  let current = leafId ? byId.get(leafId) : undefined;
  while (current && !seen.has(current.id)) {
    if (current.id === ancestorId) return true;
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}

/**
 * Structural view of PiRpcSession that navigateTree needs. Kept structural so
 * tests can drive the flow with a fake session (no LLM, no child process).
 */
export type NavigableSession = {
  id: string;
  isStreaming: boolean;
  entries: JsonRecord[];
  send: (command: RpcCommand, opts?: { timeoutMs?: number }) => Promise<RpcResponse>;
  snapshot: () => JsonRecord;
  manager: { broadcast: (data: unknown) => void; broadcastUpdated: (id: string) => void };
  /**
   * Last `extension_error` event text reported by the pi child (set by
   * PiRpcSession.handleEvent). The extension command's errors surface here
   * instead of failing the prompt response, so navigateTree clears it before
   * prompting and reports it when the leaf verification fails.
   */
  lastExtensionError?: string | null;
  /** Set once navigateTree has confirmed the child loaded tau's extension. */
  navigateCommandChecked?: boolean;
};

// Session ids with a navigate_tree currently in flight. navigateTree runs a
// multi-await check→navigate→verify sequence, so without this a second
// navigation (or a prompt — see the guard in server-main's handleRpcCommand)
// could interleave with it and land its entries on the wrong branch.
const navigationsInFlight = new Set<string>();

/** True while a navigate_tree is moving this session's leaf. */
export function isTreeNavigationInProgress(sessionId: string): boolean {
  return navigationsInFlight.has(sessionId);
}

function assertNotStreaming(session: NavigableSession): void {
  if (session.isStreaming) {
    throw new Error('Cannot navigate the session tree while the agent is streaming; abort or wait for the turn to finish');
  }
}

/**
 * Once per child process, confirm pi actually registered tau's extension
 * command. Without this check a broken install (extension file missing or
 * failing to load) would make the `/tau-tree-navigate …` text fall through
 * pi's command matching and be sent to the LLM as a literal user prompt.
 */
async function assertNavigateCommandAvailable(session: NavigableSession): Promise<void> {
  if (session.navigateCommandChecked) return;
  const resp = await session.send({ type: 'get_commands' }, { timeoutMs: 15000 });
  if (resp.success === false) {
    throw new Error(`pi could not list its commands: ${resp.error || 'unknown error'}`);
  }
  const commands = ((resp.data || {}) as { commands?: Array<{ name?: string; source?: string }> }).commands || [];
  const found = commands.some((c) => c.name === NAVIGATE_COMMAND && c.source === 'extension');
  if (!found) {
    throw new Error(`The pi child did not load tau's ${NAVIGATE_COMMAND} extension; cannot navigate the session tree`);
  }
  session.navigateCommandChecked = true;
}

/**
 * Full navigate_tree flow for a live session: resolve the target from a
 * preflight get_tree, have the child move its leaf in-process via the bundled
 * extension's /tau-tree-navigate command, re-fetch the tree to confirm the
 * move, refresh session.entries to the new active path, and broadcast a fresh
 * `live_session_snapshot` (plus `live_session_updated`) so every connected
 * browser re-renders the conversation.
 *
 * The streaming guard cannot be made fully airtight from tau's side (a prompt
 * whose agent_start has not yet round-tripped through the child is invisible
 * here), so the flow is defensive instead: one navigation per session at a
 * time, the extension re-checks idleness in-process (ctx.isIdle()) right
 * before moving the leaf, prompts are refused by handleRpcCommand while a
 * navigation is in flight, and if the child still turns out to have moved on
 * (leaf verification fails) the clients are re-synced to the child's real
 * state before the error is reported.
 */
export async function navigateTree(session: NavigableSession, entryId: string): Promise<{ editorText?: string }> {
  if (navigationsInFlight.has(session.id)) {
    throw new Error('Another tree navigation for this session is already in progress');
  }
  navigationsInFlight.add(session.id);
  try {
    assertNotStreaming(session);
    // Preflight: fetch the tree to resolve the target entry (clear error for
    // unknown ids), detect no-ops, and derive editorText locally — RPC-mode
    // extensions cannot fill the client's editor, and the /tau-tree-navigate
    // prompt response cannot carry handler data.
    let treeResp = await session.send({ type: 'get_tree' }, { timeoutMs: 15000 });
    if (treeResp.success === false) {
      throw new Error(`pi did not answer the pre-navigation tree check: ${treeResp.error || 'unknown error'}`);
    }
    let treeData = (treeResp.data || {}) as { tree?: SessionTreeNodeLike[]; leafId?: string | null };
    let byId = flattenTree(treeData.tree);
    const entry = byId.get(entryId);
    if (!entry) throw new Error(`Entry ${entryId} not found in the session tree`);
    const target = selectNavigationTarget(entry);
    const previousLeafId = treeData.leafId ?? null;
    // Already there: pi's navigateTree no-ops when the selected entry IS the
    // current leaf, and moving to the current position would be pure churn —
    // skip the round-trip (but still hand back the editorText, so selecting
    // the leaf user message keeps prefilling the composer).
    if (entryId === previousLeafId || (target.leafTargetId !== null && target.leafTargetId === previousLeafId)) {
      return target.editorText !== undefined ? { editorText: target.editorText } : {};
    }
    await assertNavigateCommandAvailable(session);
    // A turn may have started while the preflight round-tripped; re-check
    // here for a fast, precise error (the extension re-checks in-process via
    // ctx.isIdle() as the authoritative guard).
    assertNotStreaming(session);
    session.lastExtensionError = null;
    const prompted = await session.send({ type: 'prompt', message: `/${NAVIGATE_COMMAND} ${entryId}` }, { timeoutMs: 30000 });
    if (prompted.success === false) {
      throw new Error(`pi refused the tree-navigation command: ${prompted.error || 'unknown error'}`);
    }
    // The prompt ack only means the handler ran — its errors surface as
    // `extension_error` events, not as a failed response — so the follow-up
    // get_tree is the real success check.
    treeResp = await session.send({ type: 'get_tree' }, { timeoutMs: 30000 });
    if (treeResp.success === false) {
      // The child MAY have moved its leaf; we just cannot re-derive the
      // entries. At least nudge clients so they refetch metadata instead of
      // silently rendering the old branch forever.
      session.manager.broadcastUpdated(session.id);
      throw new Error(`pi could not report the session tree after navigating: ${treeResp.error || 'unknown error'}`);
    }
    treeData = (treeResp.data || {}) as { tree?: SessionTreeNodeLike[]; leafId?: string | null };
    byId = flattenTree(treeData.tree);
    const newLeafId = treeData.leafId ?? null;
    // Refresh entries and broadcast BEFORE verifying the leaf: at this point
    // the child is authoritative, so even when verification fails below every
    // client must be re-rendered onto whatever the child actually has.
    session.entries = pathFromRoot(byId, newLeafId) as unknown as JsonRecord[];
    session.manager.broadcast({ type: 'live_session_snapshot', sessionId: session.id, ...session.snapshot() });
    session.manager.broadcastUpdated(session.id);
    // On success the extension appended a marker at the navigation target and
    // that marker IS the child's new leaf (no reload happens, so nothing else
    // gets appended in between). Requiring the leaf to have changed AND to be
    // a marker parented at the target rejects both a silent no-move (handler
    // error) and a leaf that moved somewhere unexpected.
    const newLeaf = newLeafId ? byId.get(newLeafId) : undefined;
    const moved =
      newLeafId !== previousLeafId &&
      newLeaf !== undefined &&
      newLeaf.type === 'custom' &&
      newLeaf.customType === NAVIGATION_MARKER_TYPE &&
      (newLeaf.parentId ?? null) === target.leafTargetId;
    if (!moved) {
      const detail = session.lastExtensionError ? `: ${session.lastExtensionError}` : '';
      throw new Error(`pi did not move the session leaf to the expected entry${detail}`);
    }
    return target.editorText !== undefined ? { editorText: target.editorText } : {};
  } finally {
    navigationsInFlight.delete(session.id);
  }
}
