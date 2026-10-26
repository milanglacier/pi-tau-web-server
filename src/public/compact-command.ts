/**
 * Recognize `/compact` typed in the chat box.
 *
 * Pi's RPC prompt does not run Pi's built-in terminal commands, so Tau runs
 * compaction itself. Only `/compact` on its own, or `/compact` followed by
 * whitespace and text, is recognized. The text becomes the instructions for
 * the summary, as in Pi's terminal UI (`/compact focus on the API changes`).
 * Anything else that starts with `/` is left for Pi, so extension commands,
 * prompt templates and skills keep working.
 */
export type CompactCommand = { customInstructions?: string };

export function parseCompactCommand(text: string): CompactCommand | null {
  const match = /^\/compact(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const customInstructions = match[1]?.trim();
  return customInstructions ? { customInstructions } : {};
}
