/*
 * pi extension bundled with tau and loaded into every `pi --mode rpc` child
 * via `--extension <this file>` (see PiRpcSession.start in
 * src/server/sessions.ts). It gives tau's backend a way to MOVE the session
 * leaf: pi's native RPC surface only exposes read-only tree commands
 * (get_tree / get_entries), so tau sends
 *
 *   {"type": "prompt", "message": "/tau-tree-navigate <entryId>"}
 *
 * and this command handler performs the navigation in-process with
 * ctx.navigateTree() — the same API pi's own TUI /tree uses, including its
 * selection semantics (user/custom message → leaf moves to the entry's
 * PARENT; anything else → leaf moves to the entry itself). Matched extension
 * commands never reach the LLM and never append a user message, so the
 * /tau-tree-navigate text is invisible to the model and to the session file.
 *
 * Persistence: navigateTree({summarize: false}) only moves the in-memory
 * leaf pointer, and on load pi derives the leaf from the LAST entry in the
 * file — so a bare navigation would not survive a pi restart. When the leaf
 * actually moved, the handler appends a small `custom` marker entry (same
 * `tau:navigate-tree` customType tau has always used) whose parentId is the
 * new leaf. Custom entries never participate in LLM context, so the marker
 * is invisible to the model too.
 *
 * Errors thrown here do NOT fail the RPC `prompt` response; pi reports them
 * as an `extension_error` event (extensionPath "command:tau-tree-navigate").
 * tau's navigateTree (src/server/tree.ts) therefore verifies the move with a
 * follow-up get_tree and surfaces the captured extension_error on mismatch.
 */

// Type-only reference to pi's extension API. Written as an inline import()
// type (not an `import type` statement) because this file is type-checked as
// CommonJS by tsconfig.test.json while pi's package is ESM-only, and at
// runtime it is loaded by pi's jiti / node's type stripping, both of which
// erase pure type positions.
type ExtensionAPI = import('@earendil-works/pi-coding-agent', { with: { 'resolution-mode': 'import' } }).ExtensionAPI;

/** Command name tau's backend invokes; keep in sync with src/server/tree.ts. */
export const NAVIGATE_COMMAND = 'tau-tree-navigate';

/** customType of the marker entries that persist a leaf move across reloads. */
export const NAVIGATION_MARKER_TYPE = 'tau:navigate-tree';

export default function tauTreeExtension(pi: ExtensionAPI) {
  pi.registerCommand(NAVIGATE_COMMAND, {
    description: 'Move the session leaf to an entry (used by the tau web UI tree view)',
    handler: async (args, ctx) => {
      const entryId = args.trim();
      if (!entryId) throw new Error(`/${NAVIGATE_COMMAND}: missing target entry id`);
      if (!ctx.isIdle()) {
        throw new Error('Cannot navigate the session tree while the agent is streaming; abort or wait for the turn to finish');
      }
      if (!ctx.sessionManager.getEntry(entryId)) {
        throw new Error(`Entry ${entryId} not found in the session tree`);
      }
      const previousLeafId = ctx.sessionManager.getLeafId();
      // Pass the ORIGINAL entry id: navigateTree applies the user-message →
      // parent selection rule itself, so pre-resolving the target here would
      // land the leaf one node too high.
      const result = await ctx.navigateTree(entryId, { summarize: false });
      if (result.cancelled) {
        throw new Error('A pi extension cancelled the tree navigation');
      }
      // Persist the move only when the leaf actually changed (navigating to
      // the current position appends nothing, mirroring pi's own /tree).
      if (ctx.sessionManager.getLeafId() !== previousLeafId) {
        pi.appendEntry(NAVIGATION_MARKER_TYPE, { navigatedTo: entryId });
      }
    },
  });
}
