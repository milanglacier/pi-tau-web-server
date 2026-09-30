/**
 * History render pre-pass — pure, DOM-free.
 *
 * Turns a session's raw history entries into a flat list of renderable items
 * before any DOM work happens. The key transform: toolResult entries are
 * paired onto their originating toolCall item here, so a toolCall item is
 * self-contained. That lets the renderer draw history in any order (newest
 * chunk first, older chunks later) without ever orphaning a tool result whose
 * card lives in a chunk that has not been rendered yet.
 */

import type { AppMessage, MessageContentBlock, UsageRecord } from './app-types.js';
import type { ToolResult } from './tool-card.js';

export type SessionHistoryEntry = { type?: string; message?: AppMessage };

export type HistoryImage = { data: string; mimeType: string };

export type HistoryUserItem = { kind: 'user'; content: string; images?: HistoryImage[] };
export type HistoryAssistantItem = {
  kind: 'assistant';
  content: MessageContentBlock[] | string;
  usage?: UsageRecord;
};
export type HistoryToolCallItem = {
  kind: 'toolCall';
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: ToolResult;
  isError?: boolean;
};

export type HistoryItem = HistoryUserItem | HistoryAssistantItem | HistoryToolCallItem;

export type HistoryBuildResult = {
  items: HistoryItem[];
  totalCost: number;
  lastInputTokens: number;
  lastUsage: UsageRecord | null;
};

export function buildHistoryItems(entries: SessionHistoryEntry[]): HistoryBuildResult {
  const items: HistoryItem[] = [];
  const toolCallItems = new Map<string, HistoryToolCallItem>();
  let totalCost = 0;
  let lastInputTokens = 0;
  let lastUsage: UsageRecord | null = null;

  for (const entry of entries) {
    if (entry.type !== 'message') continue;

    const msg = entry.message;
    if (!msg) continue;

    if (msg.role === 'user') {
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : (msg.content || [])
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
      const images = Array.isArray(msg.content)
        ? msg.content
            .filter((b) => b.type === 'image')
            .map((b) => ({ data: b.source?.data || b.data || '', mimeType: b.source?.media_type || b.media_type || 'image/png' }))
        : [];
      if (content || images.length > 0) {
        items.push({ kind: 'user', content: content || '', images: images.length > 0 ? images : undefined });
      }
    } else if (msg.role === 'assistant') {
      const blocks = (msg.content as MessageContentBlock[]) || [];
      const textBlocks = blocks.filter((b) => b.type === 'text');
      const thinkingBlocks = blocks.filter((b) => b.type === 'thinking');
      const contentBlocks = blocks.filter((b) => b.type === 'text' || b.type === 'thinking');
      const text = textBlocks.map((b) => b.text).join('\n');

      if (text || thinkingBlocks.length > 0) {
        items.push({
          kind: 'assistant',
          content: contentBlocks.length > 0 ? contentBlocks : text,
          usage: msg.usage,
        });

        if (msg.usage?.cost?.total) {
          totalCost += msg.usage.cost.total;
        }
        if (msg.usage?.input) {
          lastInputTokens = msg.usage.input + (msg.usage.cacheRead || 0);
          lastUsage = msg.usage;
        }
      }

      for (const tc of blocks) {
        if (tc.type !== 'toolCall') continue;
        const item: HistoryToolCallItem = {
          kind: 'toolCall',
          toolCallId: String(tc.id || ''),
          toolName: String(tc.name || ''),
          args: tc.arguments || {},
        };
        items.push(item);
        toolCallItems.set(item.toolCallId, item);
      }
    } else if (msg.role === 'toolResult') {
      // Attach the result to its toolCall item instead of emitting an item of
      // its own; unmatched results are dropped, matching the old behavior of
      // addHistoryResult() silently ignoring unknown toolCallIds.
      const item = toolCallItems.get(msg.toolCallId ?? '');
      if (item) {
        item.result = {
          content: (msg.content as MessageContentBlock[]) || [],
          ...(msg.nestedCalls ? { nestedCalls: msg.nestedCalls } : {}),
        };
        item.isError = msg.isError ?? false;
      }
    }
  }

  return { items, totalCost, lastInputTokens, lastUsage };
}
