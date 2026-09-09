/**
 * Dialogs - Handles extension UI dialogs
 */

import { isImeComposition } from './keyboard.js';

export type DialogRequest = {
  id?: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  createdAt?: number;
  expiresAt?: number;
  sessionId?: string;
  method?: string;
  [key: string]: unknown;
};

export class DialogHandler {
  container: HTMLElement;
  transport: { send(data: unknown): void | Promise<void> };
  getSessionId: (() => string | null) | null;
  currentDialog: HTMLElement | null;
  currentRequest: { id?: string; sessionId: string | null; request: DialogRequest | null; responding?: boolean } | null;
  timeoutId: ReturnType<typeof setTimeout> | null;
  onIdle: (() => void) | null;

  constructor(container: HTMLElement, transport: { send(data: unknown): void | Promise<void> }, getSessionId: (() => string | null) | null = null) {
    this.container = container;
    // Approval must not make the session's Abort button or other tabs
    // unreachable. Only the dialog sheet intercepts pointer events.
    this.container.style.pointerEvents = 'none';
    this.transport = transport;
    this.getSessionId = getSessionId;
    this.currentDialog = null;
    this.currentRequest = null;
    this.timeoutId = null;
    this.onIdle = null;
  }

  showSelect(request: DialogRequest) {
    this.clearCurrentDialog();

    const { id, title, options, timeout, sessionId } = request;

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || 'Select an option')}</div>
      <div class="dialog-options" id="dialog-options"></div>
      <div class="dialog-actions">
        <button id="dialog-cancel">Cancel</button>
      </div>
    `;

    const optionsContainer = dialog.querySelector('#dialog-options')!;
    
    (options || []).forEach((option: string) => {
      const optionDiv = document.createElement('div');
      optionDiv.className = 'dialog-option';
      optionDiv.textContent = option;
      optionDiv.onclick = () => {
        this.respond(id, { value: option }, sessionId);
      };
      optionsContainer.appendChild(optionDiv);
    });

    dialog.querySelector('#dialog-cancel')!.onclick = () => {
      this.respond(id, { cancelled: true }, sessionId);
    };

    this.showDialog(dialog, timeout, id, sessionId, request);
  }

  showConfirm(request: DialogRequest) {
    this.clearCurrentDialog();

    const { id, title, message, timeout, sessionId } = request;

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || 'Confirm')}</div>
      ${message ? `<div class="dialog-message">${this.escapeHtml(message)}</div>` : ''}
      <div class="dialog-actions">
        <button id="dialog-no">No</button>
        <button id="dialog-yes">Yes</button>
      </div>
    `;

    dialog.querySelector('#dialog-yes')!.onclick = () => {
      this.respond(id, { confirmed: true }, sessionId);
    };

    dialog.querySelector('#dialog-no')!.onclick = () => {
      this.respond(id, { confirmed: false }, sessionId);
    };

    this.showDialog(dialog, timeout, id, sessionId, request);
  }

  showInput(request: DialogRequest) {
    this.clearCurrentDialog();

    const { id, title, placeholder, timeout, sessionId } = request;

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || 'Input')}</div>
      <input type="text" class="dialog-input" id="dialog-input" placeholder="${this.escapeHtml(placeholder || '')}" />
      <div class="dialog-actions">
        <button id="dialog-cancel">Cancel</button>
        <button id="dialog-submit">Submit</button>
      </div>
    `;

    const input = dialog.querySelector<HTMLInputElement>('#dialog-input');
    if (!input) return;
    
    const submit = () => {
      const value = input.value.trim();
      this.respond(id, value ? { value } : { cancelled: true }, sessionId);
    };

    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (isImeComposition(e)) return;
      if (e.key === 'Enter') submit();
    });

    dialog.querySelector('#dialog-submit')!.onclick = submit;
    dialog.querySelector('#dialog-cancel')!.onclick = () => {
      this.respond(id, { cancelled: true }, sessionId);
    };

    this.showDialog(dialog, timeout, id, sessionId, request);
    
    // Focus input after a short delay
    setTimeout(() => input.focus(), 100);
  }

  showEditor(request: DialogRequest) {
    this.clearCurrentDialog();

    const { id, title, prefill, timeout, sessionId } = request;

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || 'Editor')}</div>
      <textarea class="dialog-textarea" id="dialog-textarea">${this.escapeHtml(prefill || '')}</textarea>
      <div class="dialog-actions">
        <button id="dialog-cancel">Cancel</button>
        <button id="dialog-save">Save</button>
      </div>
    `;

    const textarea = dialog.querySelector<HTMLTextAreaElement>('#dialog-textarea');
    if (!textarea) return;

    dialog.querySelector('#dialog-save')!.onclick = () => {
      const value = textarea.value;
      this.respond(id, value ? { value } : { cancelled: true }, sessionId);
    };

    dialog.querySelector('#dialog-cancel')!.onclick = () => {
      this.respond(id, { cancelled: true }, sessionId);
    };

    this.showDialog(dialog, timeout, id, sessionId, request);
    
    // Focus textarea after a short delay
    setTimeout(() => textarea.focus(), 100);
  }

  showNotification(request: DialogRequest) {
    const { message, notifyType } = request;
    
    // Create a temporary notification element
    const notification = document.createElement('div');
    notification.className = 'error-message';
    notification.textContent = `${notifyType === 'error' ? '⚠️' : notifyType === 'warning' ? '⚠️' : 'ℹ️'} ${message}`;
    
    // Add to messages container temporarily
    const messagesContainer = document.getElementById('messages');
    if (messagesContainer) {
      messagesContainer.appendChild(notification);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
      
      // Remove after 5 seconds
      setTimeout(() => {
        notification.remove();
      }, 5000);
    }
  }

  showDialog(dialogElement: HTMLElement, timeout: number | undefined, requestId: string | undefined, sessionId: string | null = null, request: DialogRequest | null = null) {
    dialogElement.style.pointerEvents = 'auto';
    dialogElement.setAttribute('role', 'dialog');
    this.currentDialog = dialogElement;
    this.currentRequest = { id: requestId, sessionId, request };
    this.container.innerHTML = '';
    this.container.appendChild(dialogElement);
    this.container.classList.remove('hidden');

    // Pi and Tau own expiry. Use the original absolute deadline, never a
    // fresh timeout when a snapshot or tab switch renders the request again.
    const expiresAt = request?.expiresAt;
    if (expiresAt !== undefined) {
      this.timeoutId = setTimeout(() => {
        this.clearCurrentDialog();
        this.onIdle?.();
      }, Math.max(0, expiresAt - Date.now()));
    }
  }

  clearCurrentDialog() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    
    this.container.innerHTML = '';
    this.container.classList.add('hidden');
    this.currentDialog = null;
    this.currentRequest = null;
  }

  async respond(id: string | undefined, response: Record<string, unknown>, sessionId: string | null = null) {
    const current = this.currentRequest;
    if (!current || current.id !== id || current.responding) return;
    current.responding = true;
    const dialog = this.currentDialog!;
    const controls = dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>('button, input, textarea');
    controls.forEach(control => { control.disabled = true; });
    dialog.setAttribute('aria-busy', 'true');
    try {
      await this.transport.send({
        type: 'extension_ui_response', id,
        sessionId: sessionId || this.getSessionId?.(),
        ...response,
      });
      // A successful write is not operation completion. The full server
      // registry, not this transport acknowledgement, dismisses the dialog.
      // That update travels over the WebSocket, so with the socket down the
      // sheet stays until the reconnect snapshot. Say so rather than freeze.
      if (this.currentRequest !== current) return;
      this.notice(dialog, 'status', 'Response sent. Waiting for the server to confirm…');
    } catch (error) {
      if (this.currentRequest !== current) return;
      current.responding = false;
      controls.forEach(control => { control.disabled = false; });
      dialog.removeAttribute('aria-busy');
      this.notice(dialog, 'alert', error instanceof Error ? error.message : 'Could not send response. Please retry.');
    }
  }

  private notice(dialog: HTMLElement, role: 'status' | 'alert', text: string) {
    let notice = dialog.querySelector<HTMLElement>('.dialog-response-notice');
    if (!notice) {
      notice = document.createElement('div');
      dialog.appendChild(notice);
    }
    notice.className = role === 'alert' ? 'dialog-response-notice dialog-response-error' : 'dialog-response-notice';
    notice.setAttribute('role', role);
    notice.textContent = text;
  }

  escapeHtml(text: string) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
