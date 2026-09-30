/**
 * Tool Card - Renders and updates tool execution cards (collapsible)
 */

import { NestedToolCallsModel } from './nested-tool-calls.js';
import { createJavaScriptCodeBlock } from './javascript-code-block.js';
import type { NestedCallSummary, NestedCallsRecord, NestedCallsSummary } from './nested-tool-calls.js';

export type ToolArgs = Record<string, unknown>;

type CallsRow = {
  element: HTMLElement;
  toggle: HTMLButtonElement;
  call: NestedCallSummary;
  details?: HTMLElement;
  argumentsKey?: string;
};

type CallsView = {
  section: HTMLElement;
  toggle: HTMLButtonElement;
  list: HTMLElement;
  notice: HTMLElement;
  indicator: HTMLElement;
  rows: Map<string, CallsRow>;
};

type ExpansionChoice = { body?: boolean; calls?: boolean };

export type ToolExecution = {
  toolCallId?: string;
  toolName?: string;
  args?: ToolArgs;
  status?: string;
  output?: string;
  isError?: boolean;
};

type ToolResultBlock = {
  type?: string;
  text?: string;
  [key: string]: unknown;
};

export type ToolResult = {
  content?: ToolResultBlock[];
  nestedCalls?: NestedCallsRecord;
  [key: string]: unknown;
};

export class ToolCardRenderer {
  container: HTMLElement;
  toolCards: Map<string, HTMLElement>;
  historyCardsExpanded: boolean;
  readonly nestedCalls = new NestedToolCallsModel();
  private roots = new Map<string, ToolExecution>();
  private liveRoots = new Set<string>();
  private callsViews = new Map<string, CallsView>();
  private expansion = new Map<string, ExpansionChoice>();
  private allChoice: boolean | undefined;
  private bottomScrollFrame: number | undefined;
  private bottomScrollTop: number | undefined;

  constructor(container: HTMLElement) {
    this.container = container;
    this.toolCards = new Map(); // toolCallId -> element
    this.historyCardsExpanded = false;
  }

  createToolCard(toolExecution: ToolExecution) {
    const { toolCallId, toolName, args, status } = toolExecution;
    const id = String(toolCallId || '');
    this.rememberRoot(toolExecution);
    const existing = this.toolCards.get(id);
    if (existing) return existing;

    const card = document.createElement('div');
    card.className = 'tool-card';
    card.dataset.toolCallId = String(toolCallId || '');

    const argsPreview = this.getArgsPreview(String(toolName || ''), args);
    const isExpanded = this.allChoice ?? (status === 'streaming' || status === 'pending');

    const isEdit = (toolName === 'edit' || toolName === 'Edit') && args && (args.oldText || args.old_text) && (args.newText || args.new_text);

    card.innerHTML = `
      <div class="tool-card-header">
        <div class="tool-header-left">
          <span class="tool-card-chevron${isExpanded ? ' expanded' : ''}"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg></span>
          <span class="tool-name">${this.escapeHtml(toolName || '')}</span>
          ${argsPreview ? `<span class="tool-args-preview">${this.escapeHtml(argsPreview)}</span>` : ''}
        </div>
        <div class="tool-header-right">
          <button class="tool-action-btn copy-output-btn" title="Copy output" onclick="event.stopPropagation(); var t=this.closest('.tool-card').querySelector('.tool-output'); if(!t||!t.textContent.trim())return; var s=t.textContent,b=this; (navigator.clipboard?navigator.clipboard.writeText(s):new Promise(function(r){var a=document.createElement('textarea');a.value=s;a.style.cssText='position:fixed;left:-9999px';document.body.appendChild(a);a.select();document.execCommand('copy');document.body.removeChild(a);r()})).then(function(){b.classList.add('copied');setTimeout(function(){b.classList.remove('copied')},1500)})"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button>
          <div class="tool-status ${status}">${status}</div>
        </div>
      </div>
      <div class="tool-card-body${isExpanded ? ' expanded' : ''}">
        <div class="tool-output-wrapper">
          <div class="tool-output"></div>
        </div>
      </div>
    `;

    const body = card.querySelector('.tool-card-body')!;
    const argumentsEl = isEdit
      ? this.renderDiff(String(args.oldText || args.old_text || ''), String(args.newText || args.new_text || ''))
      : this.renderArguments(toolName || '', args);
    if (argumentsEl) body.insertBefore(argumentsEl, body.firstChild);

    this.container.appendChild(card);
    this.toolCards.set(id, card);
    this.bindHeader(id, card);
    this.renderNestedCalls(id);
    this.scrollToBottom();

    return card;
  }

  updateToolCard(toolExecution: ToolExecution) {
    let card = this.toolCards.get(String(toolExecution.toolCallId || ''));

    if (!card) {
      card = this.createToolCard(toolExecution);
    }

    // Update status
    const statusElement = card.querySelector('.tool-status');
    if (statusElement) {
      statusElement.className = `tool-status ${toolExecution.status}`;
      statusElement.textContent = toolExecution.status ?? null;
    }

    // Auto-expand when streaming
    if (toolExecution.status === 'streaming' && this.choice(String(toolExecution.toolCallId || '')).body === undefined) {
      this.setBodyExpanded(card, true);
    }

    // Update output
    const outputElement = card.querySelector('.tool-output');
    if (outputElement && toolExecution.output) {
      outputElement.textContent = toolExecution.output;
      this.scrollToBottom();
    }
  }

  finalizeToolCard(toolCallId: string, result: ToolResult, isError: boolean) {
    const card = this.toolCards.get(toolCallId);
    if (!card) return;

    const wasFollowing = this.isFollowingBottom();
    // Update status
    const statusElement = card.querySelector('.tool-status');
    if (statusElement) {
      const status = isError ? 'error' : 'complete';
      statusElement.className = `tool-status ${status}`;
      statusElement.textContent = status;
    }

    // Update output with final result
    const outputElement = card.querySelector('.tool-output');
    if (outputElement && result) {
      const output = this.formatResult(result);
      outputElement.textContent = output;
    }

    this.nestedCalls.finish(toolCallId);
    const summary = this.nestedCalls.get(toolCallId);
    if (!isError && this.isClean(summary) && this.choice(toolCallId).body === undefined) {
      this.setBodyExpanded(card, false);
    }
    this.renderNestedCalls(toolCallId);
    if (summary) this.scrollToBottom(wasFollowing);
  }

  /**
   * Create a snapshot card using DOM methods (no innerHTML).
   */
  createHistoryCard(toolExecution: ToolExecution, target: ParentNode = this.container) {
    const { toolCallId, toolName, args } = toolExecution;
    const id = String(toolCallId || '');
    this.rememberRoot(toolExecution);
    const existing = this.toolCards.get(id);
    if (existing) return existing;

    const card = document.createElement('div');
    card.className = this.liveRoots.has(id) ? 'tool-card' : 'tool-card history';
    card.dataset.toolCallId = String(toolCallId || '');

    // Header
    const header = document.createElement('div');
    header.className = 'tool-card-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'tool-header-left';

    const chevron = document.createElement('span');
    chevron.className = `tool-card-chevron${this.historyCardsExpanded ? ' expanded' : ''}`;
    chevron.innerHTML = '<svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg>';
    headerLeft.appendChild(chevron);

    const name = document.createElement('span');
    name.className = 'tool-name';
    name.textContent = String(toolName || '');
    headerLeft.appendChild(name);

    const preview = this.getArgsPreview(String(toolName || ''), args);
    if (preview) {
      const previewEl = document.createElement('span');
      previewEl.className = 'tool-args-preview';
      previewEl.textContent = preview;
      headerLeft.appendChild(previewEl);
    }

    header.appendChild(headerLeft);

    // Right side: copy button + status
    const headerRight = document.createElement('div');
    headerRight.className = 'tool-header-right';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'tool-action-btn copy-output-btn';
    copyBtn.title = 'Copy output';
    copyBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const output = card.querySelector('.tool-output');
      if (!output || !output.textContent.trim()) return;
      const text = output.textContent;
      (navigator.clipboard ? navigator.clipboard.writeText(text) : new Promise<void>((r) => {
        const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); r();
      })).then(() => {
        copyBtn.classList.add('copied');
        setTimeout(() => copyBtn.classList.remove('copied'), 1500);
      });
    });
    headerRight.appendChild(copyBtn);

    const status = document.createElement('div');
    status.className = `tool-status ${toolExecution.status ?? 'complete'}`;
    status.textContent = toolExecution.status ?? 'complete';
    headerRight.appendChild(status);

    header.appendChild(headerRight);

    card.appendChild(header);

    // Body is collapsed by default unless Expand All was invoked while
    // progressive history chunks are still pending.
    const body = document.createElement('div');
    body.className = `tool-card-body${this.historyCardsExpanded ? ' expanded' : ''}`;

    const isEdit = (toolName === 'edit' || toolName === 'Edit') && args && (args.oldText || args.old_text) && (args.newText || args.new_text);

    if (isEdit) {
      body.appendChild(this.renderDiff(String(args.oldText || args.old_text || ''), String(args.newText || args.new_text || '')));
    } else {
      const argsEl = this.renderArguments(toolName || '', args);
      if (argsEl) body.appendChild(argsEl);
    }

    const outputEl = document.createElement('div');
    outputEl.className = 'tool-output';
    body.appendChild(outputEl);

    card.appendChild(body);

    target.appendChild(card);
    this.toolCards.set(id, card);
    this.bindHeader(id, card);
    this.renderNestedCalls(id);

    return card;
  }

  /**
   * Add a saved result to its card.
   */
  addHistoryResult(toolCallId: string, result: ToolResult, isError: boolean) {
    const card = this.toolCards.get(toolCallId);
    if (!card) return;

    if (isError) {
      const statusEl = card.querySelector('.tool-status');
      if (statusEl) {
        statusEl.className = 'tool-status error';
        statusEl.textContent = 'error';
      }
    }

    const outputElement = card.querySelector('.tool-output');
    if (outputElement && result) {
      outputElement.textContent = this.formatResult(result);
    }
    if (result?.nestedCalls) this.nestedCalls.replace(toolCallId, result.nestedCalls);
    this.nestedCalls.finish(toolCallId);
    this.renderNestedCalls(toolCallId);
  }

  rememberRoot(execution: ToolExecution) {
    const id = execution.toolCallId;
    if (!id) return;
    const known = this.roots.has(id);
    this.roots.set(id, execution);
    if (!known) {
      for (const owner of this.nestedCalls.registerRoot(id)) this.renderNestedCalls(owner);
    }
    if (execution.status === 'complete' || execution.status === 'error') this.nestedCalls.finish(id);
  }

  observeNestedCall(event: Parameters<NestedToolCallsModel['observe']>[0]) {
    const owner = this.nestedCalls.observe(event);
    if (owner) {
      this.liveRoots.add(owner);
      const wasFollowing = this.isFollowingBottom();
      this.toolCards.get(owner)?.classList.remove('history');
      this.renderNestedCalls(owner);
      this.scrollToBottom(wasFollowing);
    }
  }

  reconcileToolResult(toolCallId: string, result: ToolResult, isError: boolean) {
    if (!this.toolCards.has(toolCallId)) {
      const root = this.roots.get(toolCallId);
      if (!root) return;
      this.createToolCard({ ...root, status: 'complete' });
    }
    if (result.nestedCalls) this.nestedCalls.replace(toolCallId, result.nestedCalls);
    this.finalizeToolCard(toolCallId, result, isError);
  }

  settleNestedCalls() {
    for (const id of this.nestedCalls.settle()) this.renderNestedCalls(id);
  }

  private choice(id: string): ExpansionChoice {
    return this.expansion.get(id) ?? { body: this.allChoice, calls: this.allChoice };
  }

  private setBodyExpanded(card: HTMLElement, expanded: boolean) {
    card.querySelector('.tool-card-body')?.classList.toggle('expanded', expanded);
    card.querySelector('.tool-card-chevron')?.classList.toggle('expanded', expanded);
    card.querySelector('.tool-card-header')?.setAttribute('aria-expanded', String(expanded));
  }

  private bindHeader(id: string, card: HTMLElement) {
    const header = card.querySelector<HTMLElement>('.tool-card-header')!;
    header.tabIndex = 0;
    header.setAttribute('role', 'button');
    header.setAttribute('aria-label', `Toggle ${this.roots.get(id)?.toolName || 'tool'} details`);
    this.setBodyExpanded(card, !!card.querySelector('.tool-card-body.expanded'));
    const toggle = () => {
      const open = !card.querySelector('.tool-card-body.expanded');
      this.expansion.set(id, { ...this.choice(id), body: open });
      this.setBodyExpanded(card, open);
    };
    header.addEventListener('click', toggle);
    header.addEventListener('keydown', event => {
      if (event.target === header && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        toggle();
      }
    });
  }

  private setText(element: Element, text: string) {
    if (element.textContent !== text) element.textContent = text;
  }

  private isClean(summary?: NestedCallsSummary) {
    return !summary || summary.calls.every(call => call.status === 'ok');
  }

  private argumentsText(call: NestedCallSummary) {
    if (call.arguments === undefined) {
      return `Arguments omitted${call.argumentsBytes !== undefined ? ` (${call.argumentsBytes} bytes)` : ''}`;
    }
    return JSON.stringify(call.arguments, null, 2);
  }

  private updateDetails(row: CallsRow) {
    if (!row.details) {
      row.details = document.createElement('div');
      row.details.className = 'nested-call-details';
      const error = document.createElement('div');
      error.className = 'nested-call-error';
      row.details.appendChild(error);
      row.element.appendChild(row.details);
    }
    const error = row.details.querySelector<HTMLElement>('.nested-call-error')!;
    const text = this.argumentsText(row.call);
    const key = JSON.stringify([row.call.name, text]);
    if (row.argumentsKey !== key) {
      let args = this.renderArguments(row.call.name, row.call.arguments, 'nested-call-arguments');
      if (!args) {
        args = document.createElement('pre');
        args.textContent = text;
      }
      args.classList.add('nested-call-arguments');
      const previous = row.details.querySelector('.nested-call-arguments');
      if (previous) previous.replaceWith(args);
      else row.details.insertBefore(args, error);
      row.argumentsKey = key;
    }
    if (error.textContent !== (row.call.error || '')) error.textContent = row.call.error || '';
    error.hidden = !row.call.error;
  }

  private renderNestedCalls(id: string) {
    const card = this.toolCards.get(id);
    const summary = this.nestedCalls.get(id);
    if (!card) return;
    if (!summary || (summary.complete && summary.calls.length === 0)) {
      const view = this.callsViews.get(id);
      view?.section.remove();
      view?.indicator.remove();
      this.callsViews.delete(id);
      return;
    }
    const history = card.classList.contains('history');
    let view = this.callsViews.get(id);
    if (!view) {
      const section = document.createElement('div');
      section.className = 'nested-calls';
      const toggle = document.createElement('button');
      toggle.className = 'nested-calls-toggle';
      toggle.type = 'button';
      const list = document.createElement('div');
      list.className = 'nested-calls-list';
      const notice = document.createElement('div');
      notice.className = 'nested-calls-notice';
      section.append(toggle, list, notice);
      const body = card.querySelector('.tool-card-body')!;
      body.insertBefore(section, body.querySelector('.tool-output-wrapper, .tool-output'));
      const indicator = document.createElement('span');
      indicator.className = 'nested-calls-indicator';
      card.querySelector('.tool-header-left')!.appendChild(indicator);
      view = { section, toggle, list, notice, indicator, rows: new Map() };
      this.callsViews.set(id, view);
      const current = view;
      toggle.addEventListener('click', () => {
        const open = toggle.getAttribute('aria-expanded') !== 'true';
        this.expansion.set(id, { ...this.choice(id), calls: open });
        toggle.setAttribute('aria-expanded', String(open));
        current.list.hidden = !open;
        current.notice.hidden = !open || !current.notice.textContent;
      });
    }

    const labels = { ok: 'succeeded', error: 'failed', running: 'running', unfinished: 'unfinished' };
    const counts = (Object.keys(labels) as Array<keyof typeof labels>)
      .map(status => ({ status, count: summary.calls.filter(call => call.status === status).length }))
      .filter(({ count }) => count > 0)
      .map(({ status, count }) => `${count} ${labels[status]}`).join(', ');
    const caption = `Calls · ${counts || '0 retained'}${summary.complete ? '' : ' · incomplete'}`;
    this.setText(view.toggle, caption);
    this.setText(view.indicator, caption);
    view.indicator.classList.toggle('has-failure', summary.calls.some(call => call.status === 'error'));
    view.indicator.classList.toggle('has-unfinished', summary.calls.some(call => call.status === 'unfinished'));
    this.setText(view.notice, summary.final
      ? (summary.complete ? '' : 'Incomplete record: calls or arguments may be omitted, or calls may be unfinished. Counts describe retained calls only.')
      : `Observed calls only. Calls that started before this browser attached may be missing.${summary.complete ? '' : ' Some calls or arguments were omitted, or calls are unfinished.'}`);

    const retained = new Set(summary.calls.map(call => call.id));
    for (const [callId, row] of view.rows) {
      if (!retained.has(callId)) {
        row.element.remove();
        view.rows.delete(callId);
      }
    }
    let previous: HTMLElement | null = null;
    for (const call of summary.calls) {
      let row = view.rows.get(call.id);
      if (!row) {
        const element = document.createElement('div');
        element.className = 'nested-call-row';
        element.dataset.callId = call.id;
        const toggle = document.createElement('button');
        toggle.className = 'nested-call-toggle';
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', 'false');
        for (const className of ['name', 'preview', 'status', 'duration']) {
          const span = document.createElement('span');
          span.className = `nested-call-${className}`;
          toggle.appendChild(span);
        }
        element.appendChild(toggle);
        row = { element, toggle, call };
        view.rows.set(call.id, row);
        const current = row;
        toggle.addEventListener('click', () => {
          const open = toggle.getAttribute('aria-expanded') !== 'true';
          toggle.setAttribute('aria-expanded', String(open));
          if (open) this.updateDetails(current);
          if (current.details) current.details.hidden = !open;
        });
      }
      row.call = call;
      row.element.style.setProperty('--call-depth', String(Math.min(call.depth, 3)));
      row.element.dataset.status = call.status;
      this.setText(row.toggle.querySelector('.nested-call-name')!, call.name);
      this.setText(row.toggle.querySelector('.nested-call-preview')!, call.arguments === undefined
        ? this.argumentsText(call) : this.getArgsPreview(call.name, call.arguments));
      this.setText(row.toggle.querySelector('.nested-call-status')!, labels[call.status]);
      this.setText(row.toggle.querySelector('.nested-call-duration')!, call.durationMs === undefined ? '' : `${call.durationMs} ms`);
      row.toggle.setAttribute('aria-label', `${call.name}: ${labels[call.status]}. Toggle arguments and error`);
      if (row.toggle.getAttribute('aria-expanded') === 'true') this.updateDetails(row);
      const next: ChildNode | null = previous ? previous.nextSibling : view.list.firstChild;
      if (next !== row.element) view.list.insertBefore(row.element, next);
      previous = row.element;
    }

    const status = card.querySelector('.tool-status')?.textContent;
    const completed = status === 'complete' || status === 'error';
    const clean = completed && status === 'complete' && this.isClean(summary);
    const autoOpen = !history && !clean;
    const choice = this.choice(id);
    const open = choice.calls ?? (history ? this.historyCardsExpanded : autoOpen);
    view.toggle.setAttribute('aria-expanded', String(open));
    view.list.hidden = !open;
    view.notice.hidden = !open || !view.notice.textContent;
    if (choice.body === undefined && !history) this.setBodyExpanded(card, autoOpen);
  }

  /** Compact preview for the header line */
  getArgsPreview(toolName: string, args?: ToolArgs) {
    if (!args || Object.keys(args).length === 0) return '';

    // Show the most relevant arg inline
    if (args.path) return String(args.path);
    if (args.command) return String(args.command).substring(0, 80);
    if (args.query) return String(args.query).substring(0, 60);
    if (args.url) return String(args.url);

    // Fallback: first string value
    for (const val of Object.values(args)) {
      if (typeof val === 'string' && val.length > 0) {
        return val.substring(0, 60);
      }
    }
    return '';
  }

  private renderArguments(toolName: string, args?: ToolArgs, className = 'tool-args'): HTMLElement | undefined {
    if (toolName === 'codemode' && typeof args?.code === 'string') {
      const element = document.createElement('div');
      element.className = `${className} tool-code-args`;
      element.appendChild(createJavaScriptCodeBlock(args.code));
      return element;
    }
    const text = this.formatJson(args);
    if (!text) return undefined;
    const element = document.createElement(className === 'nested-call-arguments' ? 'pre' : 'div');
    element.className = className;
    element.textContent = text;
    return element;
  }

  formatJson(obj?: ToolArgs) {
    if (!obj) return '';
    try {
      if (Object.keys(obj).length === 0) return '';
      return JSON.stringify(obj, null, 2);
    } catch {
      return String(obj);
    }
  }

  /** Render a simple inline diff for Edit tool */
  renderDiff(oldText: string, newText: string) {
    const container = document.createElement('div');
    container.className = 'tool-diff';

    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');

    // Removed lines
    for (const line of oldLines) {
      const el = document.createElement('div');
      el.className = 'diff-line diff-removed';
      el.textContent = '- ' + line;
      container.appendChild(el);
    }

    // Added lines
    for (const line of newLines) {
      const el = document.createElement('div');
      el.className = 'diff-line diff-added';
      el.textContent = '+ ' + line;
      container.appendChild(el);
    }

    return container;
  }

  formatResult(result: ToolResult) {
    if (!result) return '';

    if (result.content && Array.isArray(result.content)) {
      return result.content
        .map((block) => {
          if (block.type === 'text') return block.text;
          return JSON.stringify(block);
        })
        .join('\n');
    }

    const { nestedCalls: _nestedCalls, ...output } = result;
    return JSON.stringify(output, null, 2);
  }

  escapeHtml(text: unknown) {
    const div = document.createElement('div');
    div.textContent = String(text ?? '');
    return div.innerHTML;
  }

  private isFollowingBottom() {
    return this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < 100 ||
      (this.bottomScrollFrame !== undefined && Math.abs(this.container.scrollTop - this.bottomScrollTop!) < 1);
  }

  scrollToBottom(wasFollowing = this.isFollowingBottom()) {
    if (!wasFollowing) return;
    if (this.bottomScrollFrame !== undefined) cancelAnimationFrame(this.bottomScrollFrame);
    const top = this.container.scrollTop;
    this.bottomScrollTop = top;
    this.bottomScrollFrame = requestAnimationFrame(() => {
      this.bottomScrollFrame = undefined;
      this.bottomScrollTop = undefined;
      // A reader can scroll away before the next frame.
      if (Math.abs(this.container.scrollTop - top) >= 1) return;
      const behavior = this.container.style.scrollBehavior;
      this.container.style.scrollBehavior = 'auto';
      this.container.scrollTop = this.container.scrollHeight;
      this.container.style.scrollBehavior = behavior;
    });
  }

  expandAll() {
    this.historyCardsExpanded = true;
    this.allChoice = true;
    this.toolCards.forEach((card, id) => {
      this.expansion.set(id, { body: true, calls: true });
      this.setBodyExpanded(card, true);
      this.renderNestedCalls(id);
    });
  }

  collapseAll() {
    this.historyCardsExpanded = false;
    this.allChoice = false;
    this.toolCards.forEach((card, id) => {
      this.expansion.set(id, { body: false, calls: false });
      this.setBodyExpanded(card, false);
      this.renderNestedCalls(id);
    });
  }

  clear() {
    if (this.bottomScrollFrame !== undefined) cancelAnimationFrame(this.bottomScrollFrame);
    this.bottomScrollFrame = undefined;
    this.bottomScrollTop = undefined;
    this.toolCards.forEach((card) => card.remove());
    this.toolCards.clear();
    this.roots.clear();
    this.liveRoots.clear();
    this.nestedCalls.clear();
    this.callsViews.clear();
    this.expansion.clear();
    this.allChoice = undefined;
    this.historyCardsExpanded = false;
  }
}
