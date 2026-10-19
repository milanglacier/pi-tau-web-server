/**
 * Message Renderer - Renders chat messages with markdown support
 */

import { renderMarkdown, renderUserMarkdown } from './markdown.js';

type RenderedImage = {
  data: string;
  mimeType?: string;
};

type MessageContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
};

type RenderMessage = {
  id?: string;
  content?: string | MessageContentBlock[];
  images?: RenderedImage[];
  usage?: {
    cost?: { total?: number };
    [key: string]: unknown;
  };
  error?: string;
};

export class MessageRenderer {
  container: HTMLElement;
  isNearBottom: boolean;

  constructor(container: HTMLElement) {
    this.container = container;
    this.isNearBottom = true;

    // Track scroll position for smart auto-scroll
    this.container.addEventListener('scroll', () => {
      const threshold = 100;
      this.isNearBottom =
        this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < threshold;
    });
  }

  clear() {
    this.container.innerHTML = '';
  }

  renderWelcome() {
    this.container.innerHTML = `
      <div class="welcome">
        <div class="welcome-icon"><img src="icons/tau-192.png" alt="τ" class="tau-icon-welcome"></div>
        <p>Welcome to Tau</p>
        <p class="hint">Type a message below to start chatting with Pi, or select a session from the sidebar.</p>
        <div class="shortcuts-hint">
          <span>/ Focus input</span>
          <span>Esc Abort</span>
        </div>
      </div>
    `;
  }

  renderUserMessage(message: RenderMessage, isHistory = false, target: ParentNode = this.container) {
    // Remove welcome message if present
    const welcome = this.container.querySelector('.welcome');
    if (welcome) welcome.remove();

    const div = document.createElement('div');
    div.className = `message user${isHistory ? ' history' : ''}`;

    let imagesHtml = '';
    if (message.images && message.images.length > 0) {
      imagesHtml = '<div class="message-images">' +
        message.images.map(img => {
          const src = img.data.startsWith('data:') ? img.data : `data:${img.mimeType || 'image/png'};base64,${img.data}`;
          return `<img class="message-image" src="${src}" alt="Attached image" />`;
        }).join('') +
        '</div>';
    }

    div.innerHTML = `
      <div class="message-content">${imagesHtml}${renderUserMarkdown(message.content as string)}</div>
      <button class="message-copy-btn" aria-label="Copy message"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
    `;
    this._setupCopyBtn(div);
    target.appendChild(div);
    if (!isHistory) this.scrollToBottom();
  }

  renderAssistantMessage(message: RenderMessage, isStreaming = false, isHistory = false, target: ParentNode = this.container) {
    // Remove welcome message if present
    const welcome = this.container.querySelector('.welcome');
    if (welcome) welcome.remove();

    const div = document.createElement('div');
    div.className = `message assistant${isHistory ? ' history' : ''}`;
    div.dataset.messageId = message.id || 'streaming';

    let contentHtml = '';
    let usageHtml = '';

    if (typeof message.content === 'string') {
      contentHtml = isStreaming ? this.escapeHtml(message.content) : renderMarkdown(message.content);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'text') {
          contentHtml += isStreaming ? this.escapeHtml(block.text) : renderMarkdown(block.text || '');
        } else if (block.type === 'thinking') {
          contentHtml += this.renderThinkingBlock(block.thinking);
        }
      }
    }

    // Usage/cost info
    if (message.usage && message.usage.cost) {
      const cost = message.usage.cost.total;
      if (cost && cost > 0) {
        usageHtml = `<span class="message-usage">$${cost.toFixed(4)}</span>`;
      }
    }

    const streamingClass = isStreaming ? ' streaming' : '';
    const errorHtml = message.error ? this.messageErrorHtml(message.error) : '';

    div.innerHTML = `
      <div class="message-content${streamingClass}">${contentHtml}${errorHtml}</div>
      ${usageHtml}
      ${!isStreaming ? '<button class="message-copy-btn" aria-label="Copy message"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>' : ''}
    `;

    if (!isStreaming) this._setupCopyBtn(div);
    target.appendChild(div);
    if (!isHistory) this.scrollToBottom();

    return div;
  }

  renderThinkingBlock(thinking?: string) {
    const id = 'thinking-' + Math.random().toString(36).slice(2, 8);
    return `<div class="thinking-block">
<div class="thinking-toggle" onclick="var c=document.getElementById('${id}');c.classList.toggle('expanded');this.classList.toggle('expanded')">
<span class="chevron"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg></span>
<span class="thinking-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/><path d="M6.5 9h11"/><path d="M7 13h10"/></svg> Thinking</span>
</div>
<div class="thinking-content" id="${id}">${this.escapeHtml(thinking)}</div>
</div>`;
  }

  updateStreamingThinking(messageElement: HTMLElement, thinking: string) {
    let thinkingDiv = messageElement.querySelector('.streaming-thinking');
    if (!thinkingDiv) {
      const contentDiv = messageElement.querySelector('.message-content');
      if (!contentDiv) return;
      thinkingDiv = document.createElement('div');
      thinkingDiv.className = 'thinking-block streaming-thinking';
      thinkingDiv.innerHTML = `
        <div class="thinking-toggle expanded" onclick="var c=this.nextElementSibling;c.classList.toggle('expanded');this.classList.toggle('expanded')">
          <span class="chevron"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg></span>
          <span class="thinking-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/><path d="M6.5 9h11"/><path d="M7 13h10"/></svg> Thinking</span>
        </div>
        <div class="thinking-content expanded"></div>`;
      contentDiv.prepend(thinkingDiv);
    }
    const contentEl = thinkingDiv.querySelector('.thinking-content');
    if (contentEl) {
      contentEl.textContent = thinking;
      this.scrollToBottom();
    }
  }

  updateStreamingMessage(messageElement: HTMLElement, content: string) {
    const contentDiv = messageElement.querySelector('.message-content');
    if (!contentDiv) return;

    // Render markdown incrementally so headings, lists, inline formatting,
    // and other block elements appear live — not just after streaming ends.
    const rendered = renderMarkdown(content);
    const thinkingBlock = contentDiv.querySelector('.streaming-thinking');

    if (thinkingBlock) {
      // Keep the thinking block; update only the text portion
      let textNode = contentDiv.querySelector('.streaming-text');
      if (!textNode) {
        // First time text arrives after thinking started:
        // remove any stale text nodes that were placed directly in contentDiv
        // before the thinking block existed.
        let node = thinkingBlock.nextSibling;
        while (node) {
          const next = node.nextSibling;
          node.remove();
          node = next;
        }
        textNode = document.createElement('div');
        textNode.className = 'streaming-text';
        contentDiv.appendChild(textNode);
      }
      textNode.innerHTML = rendered;
    } else {
      contentDiv.innerHTML = rendered;
    }
    this.scrollToBottom();
  }

  /**
   * Replace the streaming DOM with the final render of `thinking` and the
   * markdown `text`. The caller passes both, so a message without text ends
   * with only its thinking block.
   */
  finalizeStreamingMessage(messageElement: HTMLElement, usage: RenderMessage['usage'] | null = null, thinking = '', text = '') {
    const contentDiv = messageElement.querySelector('.message-content');
    if (contentDiv) {
      contentDiv.classList.remove('streaming');

      // Final render — catches edge cases like code blocks whose closing
      // fence arrived on the very last delta.
      let html = '';
      if (thinking) {
        html += this.renderThinkingBlock(thinking);
      }
      html += renderMarkdown(text);
      contentDiv.innerHTML = html;
    }

    // Add copy button after streaming finishes
    if (!messageElement.querySelector('.message-copy-btn')) {
      const btn = document.createElement('button');
      btn.className = 'message-copy-btn';
      btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      messageElement.appendChild(btn);
      this._setupCopyBtn(messageElement);
    }

    // Add usage info if available
    if (usage && usage.cost) {
      const total = usage.cost.total;
      if (total && total > 0) {
        if (!messageElement.querySelector('.message-usage')) {
          const span = document.createElement('span');
          span.className = 'message-usage';
          span.textContent = `$${total.toFixed(4)}`;
          messageElement.appendChild(span);
        }
      }
    }
  }

  renderSystemMessage(text: string) {
    const div = document.createElement('div');
    div.className = 'system-message';
    div.textContent = String(text ?? '');
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  /** Add a provider error inside a finished assistant message. */
  appendMessageError(messageElement: HTMLElement, errorMessage: string) {
    const contentDiv = messageElement.querySelector('.message-content');
    if (!contentDiv || contentDiv.querySelector('.message-error')) return;
    contentDiv.insertAdjacentHTML('beforeend', this.messageErrorHtml(errorMessage));
    this.scrollToBottom();
  }

  messageErrorHtml(errorMessage: string) {
    return `<div class="message-error"><div class="message-error-title">Request failed</div><div class="message-error-detail">${this.escapeHtml(errorMessage)}</div></div>`;
  }

  renderError(errorMessage: string) {
    const div = document.createElement('div');
    div.className = 'error-message';
    div.textContent = `⚠️ ${errorMessage}`;
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  _setupCopyBtn(messageEl: HTMLElement) {
    const btn = messageEl.querySelector('.message-copy-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const content = messageEl.querySelector('.message-content');
      if (!content) return;
      const text = content.textContent;
      // Fallback for non-HTTPS (LAN access)
      const copyText = (t: string) => {
        if (navigator.clipboard) return navigator.clipboard.writeText(t);
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return Promise.resolve();
      };
      copyText(text).then(() => {
        btn.classList.add('copied');
        setTimeout(() => {
          btn.classList.remove('copied');
        }, 1500);
      });
    });
  }

  escapeHtml(text: unknown) {
    const div = document.createElement('div');
    div.textContent = String(text ?? '');
    return div.innerHTML;
  }

  scrollToBottom() {
    if (this.isNearBottom) {
      requestAnimationFrame(() => {
        this.container.scrollTop = this.container.scrollHeight;
      });
    }
  }
}
