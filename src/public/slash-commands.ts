import { fuzzyFilter } from './model-match.js';

/**
 * Slash commands typed in the chat box.
 *
 * Pi's RPC prompt runs extension commands, prompt templates and skills, but
 * not the built-in commands of Pi's terminal. If it is sent one of those, the
 * model receives the literal text. So Tau runs some of them itself, refuses
 * the rest with a note, and sends everything else to Pi unchanged.
 */

/** A command Pi lists through `get_commands`. */
export type PiCommand = { name: string; description?: string; source?: string };

/** What a row in the `/` menu shows. */
export type CommandMenuEntry = { name: string; description: string; badge: string };

/** Commands Tau runs itself, because it has the feature. */
export const TAU_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'compact', description: 'Compact the context to save tokens. Optional text says what to focus on' },
  { name: 'tree', description: 'Jump to any earlier point in the session tree' },
  { name: 'export', description: 'Export the session as an HTML file' },
  { name: 'session', description: 'Show session statistics' },
  { name: 'model', description: 'Choose the model and thinking level' },
];

/** Tau commands that act on their own and take no text after the name. */
export type TauAction = 'tree' | 'export' | 'session' | 'model';
const TAU_ACTIONS = new Set<string>(['tree', 'export', 'session', 'model']);

/** Pi terminal commands that cannot run over RPC and that Tau has no feature for. */
export const TERMINAL_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'settings', 'thinking', 'scoped-models', 'login', 'logout', 'new', 'resume', 'name', 'fork', 'clone',
  'import', 'copy', 'share', 'bug', 'trust', 'reload', 'hotkeys', 'changelog', 'quit',
]);

export type SlashCommandAction =
  /** Send the text to Pi unchanged. */
  | { kind: 'prompt' }
  /** Run the matching Tau feature and clear the input. */
  | { kind: 'tau'; name: TauAction }
  /** Keep the text in the input and explain why it was not sent. */
  | { kind: 'blocked'; name: string; reason: 'terminal-only' | 'arguments' };

/** The name in a message that starts with `/`, or null for any other message. */
export function slashCommandName(text: string): string | null {
  return /^\/(\S+)/.exec(text.trim())?.[1] ?? null;
}

/** True for names that Tau acts on or refuses, so Pi's own command list must be known first. */
export function isTauHandledName(name: string): boolean {
  return TAU_ACTIONS.has(name) || TERMINAL_ONLY_COMMANDS.has(name);
}

/**
 * Decide what to do with a message that starts with `/`. A name that Pi lists
 * in `piCommandNames` always goes to Pi, so an extension command named like a
 * terminal command keeps working. `/compact` is handled by
 * `parseCompactCommand` before this is called.
 */
export function resolveSlashCommand(text: string, piCommandNames: ReadonlySet<string>): SlashCommandAction {
  const name = slashCommandName(text);
  if (!name || piCommandNames.has(name)) return { kind: 'prompt' };
  if (TAU_ACTIONS.has(name)) {
    const hasArguments = text.trim().length > name.length + 1;
    return hasArguments ? { kind: 'blocked', name, reason: 'arguments' } : { kind: 'tau', name: name as TauAction };
  }
  if (TERMINAL_ONLY_COMMANDS.has(name)) return { kind: 'blocked', name, reason: 'terminal-only' };
  return { kind: 'prompt' };
}

/** The note shown when a command is not sent. */
export function blockedCommandNote(action: Extract<SlashCommandAction, { kind: 'blocked' }>): string {
  return action.reason === 'arguments'
    ? `/${action.name} does not take extra text in Tau. Send it on its own, or use it in Pi's terminal.`
    : `/${action.name} only works in Pi's terminal, so Tau did not send it.`;
}

/**
 * Recognize `/compact` typed in the chat box.
 *
 * Only `/compact` on its own, or `/compact` followed by whitespace and text,
 * is recognized. The text becomes the instructions for the summary, as in
 * Pi's terminal UI (`/compact focus on the API changes`). Anything else that
 * starts with `/` is left for `resolveSlashCommand`.
 */
export type CompactCommand = { customInstructions?: string };

export function parseCompactCommand(text: string): CompactCommand | null {
  const match = /^\/compact(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const customInstructions = match[1]?.trim();
  return customInstructions ? { customInstructions } : {};
}

/**
 * The rows of the `/` menu for what was typed after the `/`. Tau's commands
 * come first, as the built-in commands do in Pi's terminal, then Pi's. A Pi
 * command hides a Tau command with the same name. Names are matched loosely,
 * and a skill also matches its bare name, so `tdd` finds `skill:tdd`.
 */
export function matchCommands(piCommands: PiCommand[], query: string): CommandMenuEntry[] {
  const piNames = new Set(piCommands.map((command) => command.name));
  const all: CommandMenuEntry[] = [
    ...TAU_COMMANDS.filter((command) => !piNames.has(command.name)).map((command) => ({ ...command, badge: 'tau' })),
    ...piCommands.map((command) => ({ name: command.name, description: command.description || '', badge: command.source || '' })),
  ];
  const bareName = (entry: CommandMenuEntry) => entry.name.startsWith('skill:') ? entry.name.slice('skill:'.length) : entry.name;
  const byBareName = fuzzyFilter(all, query, bareName).map((match) => match.item);
  const taken = new Set(byBareName);
  const byFullName = fuzzyFilter(all.filter((entry) => entry.name.startsWith('skill:') && !taken.has(entry)), query, (entry) => entry.name).map((match) => match.item);
  return [...byBareName, ...byFullName];
}
