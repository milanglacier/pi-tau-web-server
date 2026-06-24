/**
 * WebSocket Client - Handles connection to backend WebSocket server
 */

export class WebSocketClient extends EventTarget {
  url: string;
  ws: WebSocket | null;
  reconnectAttempts: number;
  maxReconnectAttempts: number;
  reconnectDelay: number;
  maxReconnectDelay: number;
  isIntentionallyClosed: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  connectionState: 'idle' | 'connecting' | 'open' | 'closed';

  constructor(url: string) {
    super();
    this.url = url;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = Infinity;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 10000;
    this.isIntentionallyClosed = false;
    this.reconnectTimer = null;
    this.connectionState = 'idle';
  }

  connect() {
    if (this.connectionState === 'connecting') return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;

    this.isIntentionallyClosed = false;
    this.connectionState = 'connecting';
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Close only fully stale sockets before reconnecting
    if (this.ws && (this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED)) {
      this.ws = null;
    }
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log('[WS] Connected');
      this.reconnectAttempts = 0;
      this.connectionState = 'open';
      this.dispatchEvent(new CustomEvent('connected'));
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        this.handleMessage(message);
      } catch (error) {
        console.error('[WS] Failed to parse message:', error);
      }
    };

    this.ws.onerror = (error) => {
      console.error('[WS] Error:', error);
      this.dispatchEvent(new CustomEvent('error', { detail: error }));
    };

    this.ws.onclose = (event) => {
      console.log(`[WS] Disconnected (code=${event.code}, reason=${event.reason || 'n/a'})`);
      this.connectionState = 'closed';
      this.dispatchEvent(new CustomEvent('disconnected'));

      if (!this.isIntentionallyClosed) {
        this.attemptReconnect();
      }
    };
  }

  disconnect() {
    this.isIntentionallyClosed = true;
    this.connectionState = 'closed';
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
    }
  }

  // Force reconnect — resets attempt counter and connects fresh
  forceReconnect() {
    this.reconnectAttempts = 0;
    this.isIntentionallyClosed = false;
    this.connectionState = 'closed';
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.close(1000, 'force reconnect'); } catch (e) {}
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connect();
  }

  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WS] Max reconnection attempts reached');
      this.dispatchEvent(new CustomEvent('reconnectFailed'));
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.maxReconnectDelay, this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1));
    
    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  send(data: unknown) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      console.error('[WS] Cannot send, not connected');
    }
  }

  handleMessage(message: { type?: string; [key: string]: unknown }) {
    // Emit events based on message type
    switch (message.type) {
      case 'event':
        this.dispatchEvent(new CustomEvent('rpcEvent', { detail: { sessionId: message.sessionId, event: message.event } }));
        break;
      case 'state':
        this.dispatchEvent(new CustomEvent('stateUpdate', { detail: message }));
        break;
      case 'error':
        this.dispatchEvent(new CustomEvent('serverError', { detail: message }));
        break;
      case 'session_switch':
        this.dispatchEvent(new CustomEvent('sessionSwitch'));
        break;
      case 'live_session_snapshot':
        this.dispatchEvent(new CustomEvent('liveSessionSnapshot', { detail: message }));
        break;
      case 'response':
        this.dispatchEvent(new CustomEvent('rpcResponse', { detail: message }));
        break;
      case 'live_session_created':
        this.dispatchEvent(new CustomEvent('liveSessionCreated', { detail: message.session }));
        break;
      case 'live_session_updated':
        this.dispatchEvent(new CustomEvent('liveSessionUpdated', { detail: message.session }));
        break;
      case 'live_session_closed':
        this.dispatchEvent(new CustomEvent('liveSessionClosed', { detail: message }));
        break;
      default:
        console.warn('[WS] Unknown message type:', message.type);
    }
  }
}
