import { attachCompletionList, type CompletionContext, type CompletionItem } from './completion-list.js';
import { findAtToken, findSlashToken, formatFileInsertion } from './composer-tokens.js';
import { matchCommands, type PiCommand } from './slash-commands.js';

type FileContext = CompletionContext & { kind: 'file'; quoted: boolean };
type CommandContext = CompletionContext & { kind: 'command' };

type ComposerCompletionOptions = {
  input: HTMLTextAreaElement;
  /** The positioned element the menu opens in, above the input. */
  anchor: HTMLElement;
  /** The live tab being viewed, or null when there is none and no menu should open. */
  getSessionId(): string | null;
};

const FILE_DEBOUNCE_MS = 100;

/**
 * Suggestions in the chat input, as in Pi's terminal. `@` suggests files and
 * folders of the tab's working directory, and `/` at the start suggests
 * commands: Pi's extension commands, prompt templates and skills, plus Tau's
 * own.
 */
export function setupComposerCompletion({ input, anchor, getSessionId }: ComposerCompletionOptions) {
  const commandsBySession = new Map<string, PiCommand[]>();
  const commandLoads = new Map<string, Promise<PiCommand[]>>();
  // The tab whose command list was asked for during the current `/` menu.
  let commandMenuSession: string | null = null;

  /** Ask Pi for the tab's commands. Requests made while one is running share it. */
  function loadCommands(sessionId: string): Promise<PiCommand[]> {
    let load = commandLoads.get(sessionId);
    if (!load) {
      load = fetch('/api/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'get_commands', sessionId }),
      })
        .then((response) => response.json())
        .then((data) => {
          if (!data.success) throw new Error(data.error || 'Pi could not list its commands');
          const commands = (data.data?.commands || []) as PiCommand[];
          commandsBySession.set(sessionId, commands);
          return commands;
        })
        .catch(() => {
          // Keep an older list, or an empty one, so a failure never repeats forever.
          const known = commandsBySession.get(sessionId) ?? [];
          commandsBySession.set(sessionId, known);
          return known;
        })
        .finally(() => { commandLoads.delete(sessionId); });
      commandLoads.set(sessionId, load);
    }
    return load;
  }

  // Pi's list is read again whenever a `/` menu opens, because extensions can
  // add or remove commands after a reload.
  function commandsForMenu(sessionId: string): Promise<PiCommand[]> | PiCommand[] {
    if (commandMenuSession !== sessionId) {
      commandMenuSession = sessionId;
      return loadCommands(sessionId);
    }
    return commandsBySession.get(sessionId) ?? loadCommands(sessionId);
  }

  function fileItem(item: { name: string; path: string; isDirectory: boolean }, quoted: boolean): CompletionItem {
    const insertion = formatFileInsertion(item.path, quoted);
    return {
      primary: item.isDirectory ? `${item.name}/` : item.name,
      meta: item.path,
      value: insertion.text,
      caretOffset: insertion.caretOffset,
      // A folder goes on to its contents. A file ends the reference.
      continueAfterAccept: item.isDirectory,
      skipQuoteAfterCaret: insertion.text.startsWith('@"'),
    };
  }

  const list = attachCompletionList<FileContext | CommandContext>({
    input,
    anchorAbove: anchor,
    highlightFirst: true,
    debounceMs: (context) => (context.kind === 'file' ? FILE_DEBOUNCE_MS : 0),
    getContext(textBeforeCaret) {
      if (!getSessionId()) return null;
      const at = findAtToken(textBeforeCaret);
      if (at) return { kind: 'file', start: at.start, query: at.query, quoted: at.quoted };
      const slash = findSlashToken(textBeforeCaret);
      if (slash) return { kind: 'command', start: slash.start, query: slash.query };
      return null;
    },
    async getItems(query, signal, context) {
      const sessionId = getSessionId();
      if (!sessionId) return [];
      if (context.kind === 'command') {
        return matchCommands(await commandsForMenu(sessionId), query).map((command) => ({
          primary: `/${command.name}`,
          badge: command.badge,
          meta: command.description,
          value: `/${command.name} `,
          // A complete command name is sent by Enter, as in Pi's terminal.
          alreadyTyped: command.name === query,
        }));
      }
      const response = await fetch(`/api/complete/files?sessionId=${encodeURIComponent(sessionId)}&query=${encodeURIComponent(query)}`, { signal });
      if (!response.ok) throw new Error('File suggestions are not available');
      const data = await response.json() as { items?: Array<{ name: string; path: string; isDirectory: boolean }> };
      return (data.items || []).map((item) => fileItem(item, context.quoted));
    },
  });

  // Leaving the `/` text ends that menu, so the next one reads Pi's list again.
  input.addEventListener('input', () => {
    const caret = input.selectionStart ?? input.value.length;
    if (!findSlashToken(input.value.slice(0, caret))) commandMenuSession = null;
  });

  return {
    ...list,
    /** Close the menu. The next `/` menu reads Pi's list again. */
    close() {
      commandMenuSession = null;
      list.close();
    },
    /** True once Pi's command list for the tab has been read. */
    hasCommands: (sessionId: string) => commandsBySession.has(sessionId),
    /** Read Pi's command list for the tab. */
    loadCommands,
    /** The names in Pi's command list for the tab, as last read. */
    commandNames: (sessionId: string): Set<string> => new Set((commandsBySession.get(sessionId) ?? []).map((command) => command.name)),
  };
}
