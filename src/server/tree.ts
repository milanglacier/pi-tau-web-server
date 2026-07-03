/*
 * Session-tree navigation for the backend-local `navigate_tree` RPC command.
 *
 * pi stores a session as an append-only JSONL tree (entries have id/parentId;
 * the current position is the "leaf"). pi's RPC protocol only exposes
 * READ-ONLY tree commands (get_tree / get_entries) — there is no command that
 * moves the leaf — so tau moves the leaf on disk with the pi SDK and then
 * makes the running `pi --mode rpc` child reload the same file via
 * `switch_session` (which unconditionally re-opens the file from disk, even
 * for the same path).
 *
 * Persistence detail: SessionManager.branch()/resetLeaf() only mutate the
 * in-memory leaf pointer, and on load pi derives the leaf from the LAST entry
 * in the file. So the only append-only way to persist a leaf move is to
 * append a small `custom` marker entry whose parentId is the navigation
 * target. `custom` entries never participate in LLM context
 * (buildSessionContext ignores them), so the marker is invisible to the
 * model; after the child reloads, its leaf lands on the marker (or on
 * housekeeping entries pi appends under it, e.g. thinking_level_change), and
 * the active path root→leaf passes exactly through the navigation target.
 *
 * Selection semantics mirror pi's /tree (docs/sessions.md "Selection
 * Behavior"):
 *   - user (or custom) MESSAGE entry → move the leaf to the entry's PARENT
 *     and hand the message text back as editorText so the client can put it
 *     in the input box for edit + resubmit (root user message → reset to an
 *     empty conversation).
 *   - any other entry → move the leaf TO that entry, no editorText.
 */

import type { JsonRecord, RpcCommand, RpcResponse } from './types.js';

/** customType used for the marker entries tau appends to persist a leaf move. */
export const NAVIGATION_MARKER_TYPE = 'tau:navigate-tree';

type PiSdk = typeof import('@earendil-works/pi-coding-agent', { with: { 'resolution-mode': 'import' } });

// The pi SDK is ESM-only while tau's server compiles to CommonJS, so it must
// be loaded with a (cached) dynamic import instead of require().
let sdkPromise: Promise<PiSdk> | null = null;
function loadPiSdk(): Promise<PiSdk> {
  if (!sdkPromise) sdkPromise = import('@earendil-works/pi-coding-agent');
  return sdkPromise;
}

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

export type AppliedNavigation = NavigationTarget & {
  /** Id of the appended marker entry, or null when the leaf was already in place. */
  markerId: string | null;
  /** False when the file already had the desired leaf and nothing was appended. */
  changed: boolean;
  /** Leaf the file had before the move, so a failed reload can be rolled back. */
  previousLeafId: string | null;
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

/**
 * Move the session file's leaf to `entryId` (per selectNavigationTarget) by
 * opening the file with the pi SDK, branching, and appending a marker custom
 * entry so the move survives a reload. Returns what the client editor should
 * be pre-filled with and which entry ids to expect as the new leaf.
 *
 * `beforeMutate` (when given) runs after the target is resolved but before
 * anything is written to the file; throwing from it aborts the navigation
 * with the file untouched. navigateTree uses it to re-check the streaming
 * guard after the awaited SDK load/file read.
 */
export async function applyTreeNavigation(sessionFile: string, entryId: string, beforeMutate?: () => void): Promise<AppliedNavigation> {
  const { SessionManager } = await loadPiSdk();
  const manager = SessionManager.open(sessionFile);
  const entry = manager.getEntry(entryId) as TreeEntry | undefined;
  if (!entry) throw new Error(`Entry ${entryId} not found in the session tree`);
  const target = selectNavigationTarget(entry);
  const previousLeafId = manager.getLeafId() ?? null;
  // Already there (e.g. navigating to the current leaf): appending a marker
  // and reloading the child would be pure churn, so skip both.
  if (target.leafTargetId !== null && target.leafTargetId === previousLeafId) {
    return { ...target, markerId: null, changed: false, previousLeafId };
  }
  beforeMutate?.();
  if (target.leafTargetId === null) manager.resetLeaf();
  else manager.branch(target.leafTargetId);
  const markerId = manager.appendCustomEntry(NAVIGATION_MARKER_TYPE, { navigatedTo: entryId });
  return { ...target, markerId, changed: true, previousLeafId };
}

/**
 * Best-effort undo of applyTreeNavigation for the paths where the marker was
 * written but the pi child could not reload the file: append another marker
 * that points back at the pre-navigation leaf, so that resuming or restarting
 * the session lands where the user last was instead of on a move they were
 * told had failed.
 */
export async function rollbackTreeNavigation(sessionFile: string, previousLeafId: string | null): Promise<void> {
  try {
    const { SessionManager } = await loadPiSdk();
    const manager = SessionManager.open(sessionFile);
    if ((manager.getLeafId() ?? null) === previousLeafId) return;
    if (previousLeafId === null) manager.resetLeaf();
    else manager.branch(previousLeafId);
    manager.appendCustomEntry(NAVIGATION_MARKER_TYPE, { restoredTo: previousLeafId });
  } catch {
    // The rollback is best effort — the original navigation error is what
    // the caller reports; a failed rollback must not mask it.
  }
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
  sessionFile: string | null;
  isStreaming: boolean;
  entries: JsonRecord[];
  send: (command: RpcCommand, opts?: { timeoutMs?: number }) => Promise<RpcResponse>;
  snapshot: () => JsonRecord;
  manager: { broadcast: (data: unknown) => void; broadcastUpdated: (id: string) => void };
};

// Session ids with a navigate_tree currently in flight. navigateTree runs a
// multi-await check→branch→reload sequence, so without this a second
// navigation (or a prompt — see the guard in server-main's handleRpcCommand)
// could interleave with it and be silently aborted by the child reload.
const navigationsInFlight = new Set<string>();

/** True while a navigate_tree is rewriting/reloading this session. */
export function isTreeNavigationInProgress(sessionId: string): boolean {
  return navigationsInFlight.has(sessionId);
}

function assertNotStreaming(session: NavigableSession): void {
  if (session.isStreaming) {
    throw new Error('Cannot navigate the session tree while the agent is streaming; abort or wait for the turn to finish');
  }
}

/**
 * Full navigate_tree flow for a live session: branch the file, make the pi
 * child reload it via same-path switch_session, confirm the leaf via
 * get_tree, refresh session.entries to the new active path, and broadcast a
 * fresh `live_session_snapshot` (plus `live_session_updated`) so every
 * connected browser re-renders the conversation.
 *
 * The streaming guard cannot be made fully airtight from tau's side (a prompt
 * whose agent_start has not yet round-tripped through the child is invisible
 * here), so the flow is defensive instead: one navigation per session at a
 * time, the streaming check is repeated after every await before the file is
 * mutated, prompts are refused by handleRpcCommand while a navigation is in
 * flight, and if the child still turns out to have moved on (leaf
 * verification fails) the clients are re-synced to the child's real state
 * before the error is reported.
 */
export async function navigateTree(session: NavigableSession, entryId: string): Promise<{ editorText?: string }> {
  if (navigationsInFlight.has(session.id)) {
    throw new Error('Another tree navigation for this session is already in progress');
  }
  navigationsInFlight.add(session.id);
  try {
    assertNotStreaming(session);
    if (!session.sessionFile) {
      throw new Error('Session has no session file yet; there is no tree to navigate');
    }
    // Preflight: confirm the child is alive and responsive BEFORE anything is
    // persisted to disk, so a dead/hung child cannot leave the file branched
    // while the user is told the navigation failed.
    let treeResp = await session.send({ type: 'get_tree' }, { timeoutMs: 15000 });
    if (treeResp.success === false) {
      throw new Error(`pi did not answer the pre-navigation tree check: ${treeResp.error || 'unknown error'}`);
    }
    // A turn may have started while the preflight round-tripped; re-check
    // before touching the file (and again inside applyTreeNavigation, after
    // its own awaited SDK load/file read, via the beforeMutate hook).
    assertNotStreaming(session);
    const nav = await applyTreeNavigation(session.sessionFile, entryId, () => assertNotStreaming(session));
    if (nav.changed) {
      let switched: RpcResponse;
      try {
        switched = await session.send({ type: 'switch_session', sessionPath: session.sessionFile }, { timeoutMs: 30000 });
      } catch (e) {
        // The marker is already on disk but the child never confirmed the
        // reload — put the persisted leaf back so a failed navigation leaves
        // the session (including a later resume of this file) as it was.
        await rollbackTreeNavigation(session.sessionFile, nav.previousLeafId);
        throw e;
      }
      const switchData = (switched.data || {}) as JsonRecord;
      if (switched.success === false || switchData.cancelled) {
        await rollbackTreeNavigation(session.sessionFile, nav.previousLeafId);
        if (switched.success === false) throw new Error(`pi failed to reload the session file: ${switched.error || 'unknown error'}`);
        throw new Error('A pi extension cancelled the session reload');
      }
      treeResp = await session.send({ type: 'get_tree' }, { timeoutMs: 30000 });
      if (treeResp.success === false) {
        // The child HAS reloaded onto the new branch; we just cannot re-derive
        // the entries. At least nudge clients so they refetch metadata instead
        // of silently rendering the old branch forever.
        session.manager.broadcastUpdated(session.id);
        throw new Error(`pi could not report the session tree after navigating: ${treeResp.error || 'unknown error'}`);
      }
    }
    const treeData = (treeResp.data || {}) as { tree?: SessionTreeNodeLike[]; leafId?: string | null };
    const byId = flattenTree(treeData.tree);
    // Refresh entries and broadcast BEFORE verifying the leaf: at this point
    // the child is authoritative, so even when verification fails below every
    // client must be re-rendered onto whatever the child actually loaded.
    session.entries = pathFromRoot(byId, treeData.leafId ?? null) as unknown as JsonRecord[];
    session.manager.broadcast({ type: 'live_session_snapshot', sessionId: session.id, ...session.snapshot() });
    session.manager.broadcastUpdated(session.id);
    // After a reload the child's leaf is our marker entry, or a housekeeping
    // entry pi appended under it (e.g. thinking_level_change) — either way the
    // leaf must sit at or below the entry we navigated to.
    const expectedLeaf = nav.markerId ?? nav.leafTargetId;
    if (expectedLeaf !== null && !leafDescendsFrom(byId, treeData.leafId ?? null, expectedLeaf)) {
      throw new Error('pi reloaded the session but the leaf did not move to the expected entry');
    }
    return nav.editorText !== undefined ? { editorText: nav.editorText } : {};
  } finally {
    navigationsInFlight.delete(session.id);
  }
}
