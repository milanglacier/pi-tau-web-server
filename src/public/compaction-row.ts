/**
 * The transcript row for one compaction.
 *
 * The row is created when Pi starts compacting and is updated in place until
 * compaction ends. A finished row stays in the transcript as a divider that
 * marks where the context was compacted. Saved history draws the same
 * finished row for each compaction entry.
 *
 * The text and HTML builders are pure so they can be unit tested without a
 * DOM. The summary is markdown written by a model, so it is rendered with
 * renderMarkdownText, which shows any HTML in it as text.
 */

import { renderMarkdownText } from './markdown.js';

/** A failed summary request that Pi will retry. */
export type SummaryRetry = { attempt: number; maxAttempts: number; delayMs?: number; started?: boolean };

export type CompactionRowState =
  | { status: 'running'; reason?: string; startedAt?: number; retry?: SummaryRetry | null }
  | { status: 'done'; summary?: string; tokensBefore?: number; estimatedTokensAfter?: number; willRetry?: boolean }
  | { status: 'cancelled' }
  | { status: 'failed'; errorMessage?: string };

export function compactionRunningText(reason?: string) {
  if (reason === 'threshold') return 'Context is nearly full. Compacting automatically…';
  if (reason === 'overflow') return 'Context overflowed. Compacting…';
  return 'Compacting context…';
}

/** 850 → "850", 1240 → "1.2k", 32000 → "32k", 150400 → "150k". */
export function formatTokenCount(tokens: number) {
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 10_000) return `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(tokens / 1000)}k`;
}

export function compactionDoneText(state: { tokensBefore?: number; estimatedTokensAfter?: number }) {
  const { tokensBefore, estimatedTokensAfter } = state;
  if (typeof tokensBefore === 'number' && typeof estimatedTokensAfter === 'number') {
    return `Context compacted · ${formatTokenCount(tokensBefore)} → ~${formatTokenCount(estimatedTokensAfter)} tokens`;
  }
  if (typeof tokensBefore === 'number') return `Context compacted · was ${formatTokenCount(tokensBefore)} tokens`;
  return 'Context compacted';
}

export function compactionFailedText(errorMessage?: string) {
  const message = (errorMessage || '').trim();
  if (!message) return 'Compaction failed';
  return /^compaction failed/i.test(message) ? message : `Compaction failed: ${message}`;
}

export function summaryRetryText(retry: SummaryRetry) {
  const attempts = `attempt ${retry.attempt}/${retry.maxAttempts}`;
  if (retry.started) return `Summary request failed. Retrying (${attempts})…`;
  const seconds = Math.max(1, Math.ceil((retry.delayMs ?? 0) / 1000));
  return `Summary request failed. Retrying in ${seconds}s (${attempts})…`;
}

/** 4_000 → "4s", 65_000 → "1m 05s". */
export function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
}

export function compactionRowClassName(state: CompactionRowState) {
  return `compaction-message compaction-${state.status}`;
}

function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function compactionRowHtml(state: CompactionRowState, now = Date.now()) {
  if (state.status === 'running') {
    const elapsed = typeof state.startedAt === 'number'
      ? `<span class="compaction-elapsed">${formatElapsed(now - state.startedAt)}</span>`
      : '';
    const retry = state.retry ? `<div class="compaction-note">${escapeHtml(summaryRetryText(state.retry))}</div>` : '';
    return `<div class="compaction-line"><span class="compaction-spinner" aria-hidden="true">⟳</span><span class="compaction-text">${escapeHtml(compactionRunningText(state.reason))}</span>${elapsed}</div>${retry}`;
  }
  if (state.status === 'done') {
    const note = state.willRetry ? '<div class="compaction-note">Retrying the reply…</div>' : '';
    const summary = state.summary
      ? `<details class="compaction-summary"><summary>Summary</summary><div class="compaction-summary-body">${renderMarkdownText(state.summary)}</div></details>`
      : '';
    return `<div class="compaction-line"><span class="compaction-text">${escapeHtml(compactionDoneText(state))}</span></div>${note}${summary}`;
  }
  if (state.status === 'cancelled') {
    return '<div class="compaction-line"><span class="compaction-text">Compaction cancelled</span></div>';
  }
  return `<div class="compaction-line"><span class="compaction-text">${escapeHtml(compactionFailedText(state.errorMessage))}</span></div>`;
}

/** Draw `state` into `element`, creating the element when none is given. */
export function renderCompactionRow(state: CompactionRowState, element: HTMLElement = document.createElement('div')) {
  element.className = compactionRowClassName(state);
  if (state.status === 'running') element.setAttribute('role', 'status');
  else element.removeAttribute('role');
  if (state.status === 'running' && typeof state.startedAt === 'number') element.dataset.startedAt = String(state.startedAt);
  else delete element.dataset.startedAt;
  element.innerHTML = compactionRowHtml(state);
  return element;
}
