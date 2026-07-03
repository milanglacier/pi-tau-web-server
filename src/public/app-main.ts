/**
 * Main App - Ties everything together
 */

import { WebSocketClient } from './websocket-client.js';
import { StateManager } from './state.js';
import { MessageRenderer } from './message-renderer.js';
import { ToolCardRenderer, type ToolExecution, type ToolResult } from './tool-card.js';
import { DialogHandler, type DialogRequest } from './dialogs.js';
import { SessionSidebar, type SidebarProject, type SidebarSession } from './session-sidebar.js';
import { themes, applyTheme, getCurrentTheme } from './themes.js';
import { FileBrowser, getFileIcon } from './file-browser.js';
import { setupLauncherPanel } from './launcher-panel.js';
import { setupModelPicker } from './model-picker.js';
import { setupVoiceInput } from './voice-input.js';
import { setupCommandPalette } from './command-palette.js';
import { setupSessionStatsCard, type SessionStats } from './session-stats-card.js';

import type { AppEvent, AppMessage, ExtensionUIRequest, LiveInstance, LiveSession, MessageContentBlock, ModelRecord, PendingFilePath, PendingImage, QueuedCommand, RpcCommand, UsageRecord } from './app-types.js';

type SessionHistoryEntry = { type?: string; message?: AppMessage };

type LiveSessionSnapshotData = {
  sessionId?: string;
  sessionFile?: string | null;
  session?: { sessionFile?: string | null };
  isStreaming?: boolean;
  model?: ModelRecord | null;
  thinkingLevel?: string;
  entries?: SessionHistoryEntry[];
};

type RpcEventDetail = { sessionId?: string; event?: AppEvent };

// Initialize components
const wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
const wsClient = new WebSocketClient(wsUrl);
const state = new StateManager();
// All element lookups below query the app's static index.html shell, which is
// present before this module runs (the script is a deferred module at the end
// of <body>). A missing element means the page is structurally broken, so we
// assert non-null at the query site rather than guarding every usage.
const messageRenderer = new MessageRenderer(document.getElementById('messages')!);
const toolCardRenderer = new ToolCardRenderer(document.getElementById('messages')!);
const dialogHandler = new DialogHandler(document.getElementById('dialog-container')!, wsClient, () => activeLiveSessionId);

// Session sidebar
const sidebar = new SessionSidebar(
  document.getElementById('session-list')!,
  handleSessionSelect
);

// UI elements
const messageInput = document.getElementById('message-input')!;
const chatForm = document.getElementById('chat-form')!;
const sendBtn = document.getElementById('send-btn')!;
const abortBtn = document.getElementById('abort-btn')!;
const statusIndicator = document.getElementById('status-indicator')!;
const statusText = document.getElementById('status-text')!;
// Tracks the pending timer that restores statusText after a transient
// status message (rpcCommand success/error). Any new status message must
// clear this so a stale restore cannot overwrite a later, longer-lived
// message (e.g. the red-dot error flash).
let statusRestoreTimer: ReturnType<typeof setTimeout> | null = null;
// Tracks the pending timer that restores the status indicator (dot) and
// text after a red-dot error flash. Kept SEPARATE from statusRestoreTimer
// so a normal setStatusMessage call cannot cancel the only callback that
// would clear the `error` class — otherwise an unrelated status update
// during the 3s flash would strand the dot red with no timer to reset it.
let statusFlashTimer: ReturnType<typeof setTimeout> | null = null;
// Restore the status indicator dot to its real connection/streaming state.
// Only touches the indicator class (not statusText), so callers can set the
// accompanying text themselves.
function restoreStatusIndicator() {
  const open = wsClient.ws?.readyState === WebSocket.OPEN;
  statusIndicator.className = `status-indicator ${
    open && state.isStreaming ? 'streaming' : (open ? 'connected' : 'disconnected')
  }`;
}
// Set a transient statusText message and schedule its restore. Cancels any
// previously scheduled restore so overlapping messages cannot race. A new
// status message also supersedes any active error flash: it cancels the
// flash's restore and returns the dot to its real state so the `error`
// class cannot linger with no timer to clear it.
function setStatusMessage(text: string, restoreText: string | null = null, restoreMs = 3000) {
  if (statusFlashTimer !== null) {
    clearTimeout(statusFlashTimer);
    statusFlashTimer = null;
    restoreStatusIndicator();
  }
  clearTimeout(statusRestoreTimer ?? undefined);
  statusText.textContent = text;
  if (restoreText !== null) {
    statusRestoreTimer = setTimeout(() => {
      statusRestoreTimer = null;
      statusText.textContent = restoreText;
    }, restoreMs);
  }
}
// Turn the status indicator red and show an error message; after `ms`,
// restore the indicator to the real connection state and reset the text.
function flashStatusError(msg: string, ms = 3000) {
  // Reset the class atomically so no stale connected/disconnected/streaming
  // class lingers alongside `error` (matches updateConnectionStatus' style).
  statusIndicator.className = 'status-indicator error';
  // Cancel any pending status-text restore (e.g. rpcCommand's 'Done' ->
  // 'Connected' timer from an earlier successful step in the same flow) so it
  // cannot overwrite this error message while the red dot persists.
  clearTimeout(statusRestoreTimer ?? undefined);
  // Cancel any prior flash restore so overlapping flashes (a second
  // model-save failure within 3s) cannot leak a stray restore that
  // would reset the dot before this flash's own restore fires.
  clearTimeout(statusFlashTimer ?? undefined);
  statusText.textContent = msg;
  // Schedule the dot+text restore on the dedicated statusFlashTimer so a
  // later setStatusMessage (e.g. the user clicking the thinking-level cycle
  // button right after a thinking-level failure) cannot cancel the only
  // callback that clears the `error` class. If a new status message does
  // arrive, setStatusMessage itself retires the flash via restoreStatusIndicator.
  statusFlashTimer = setTimeout(() => {
    statusFlashTimer = null;
    restoreStatusIndicator();
    const open = wsClient.ws?.readyState === WebSocket.OPEN;
    // Preserve an in-progress stream: restore the streaming text too.
    statusText.textContent = (open && state.isStreaming) ? 'Working...'
      : (open ? 'Connected' : 'Disconnected');
  }, ms);
}

const sidebarEl = document.getElementById('sidebar')!;
const sidebarToggle = document.getElementById('sidebar-toggle')!;
const sidebarOverlay = document.getElementById('sidebar-overlay')!;

const refreshSessionsBtn = document.getElementById('refresh-sessions-btn')!;
const sessionSearchInput = document.getElementById('session-search-input')!;
const typingIndicator = document.getElementById('typing-indicator')!;

const contextPillEl = document.getElementById('context-pill')!;
const scrollBottomBtn = document.getElementById('scroll-bottom-btn')!;
const scrollBottomBadge = document.getElementById('scroll-bottom-badge')!;
const messagesContainer = document.getElementById('messages')!;
const launcherPanel = setupLauncherPanel({
  launcherEl: document.getElementById('launcher')!,
  messagesContainer,
  async createSession(projectPath) {
    try {
      const res = await fetch('/api/live-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: projectPath, model: '' }),
      });
      const data = await res.json();
      if (data.session) {
        upsertLiveSession(data.session);
        await selectLiveSession(data.session.id);
      }
    } catch (e) {
      console.error('[Launcher] Failed to create Tau tab:', e);
    }
  },
});

// State tracking
let currentStreamingElement: HTMLElement | null = null;
let currentStreamingText = '';
let sessionTotalCost = 0;
let lastInputTokens = 0;
let contextWindowSize = 0;  // fetched from model info
let originalTitle = document.title;
let hasFocus = true;
let unreadCount = 0;
let isScrolledUp = false;
let hasNewWhileScrolled = false;
let lastSentMessage: string | null = null; // Track to avoid duplicate rendering from backend echo events
let lastUsage: UsageRecord | null = null; // Full usage object for context visualiser
let activeLiveSessionFile: string | null = null; // The active live session file path
let viewingActiveSession = false; // Whether we're viewing a live backend Tau tab or historical read-only session
let hasReceivedInitialServerState = false;
let liveInstances: LiveInstance[] = []; // Sidebar live indicators derived from backend live sessions
let liveSessions: LiveSession[] = [];
let activeLiveSessionId = localStorage.getItem('tau-active-live-session-id') || null;
let hasRestoredInitialLiveSession = false;
let pendingExtensionUIRequests: ExtensionUIRequest[] = []; // background session UI requests waiting for that Tau tab to be selected
dialogHandler.onIdle = () => processQueuedExtensionUIRequest();

// File browser
const fileSidebar = document.getElementById('file-sidebar')!;
const fileSidebarToggle = document.getElementById('file-sidebar-toggle')!;
const fileSidebarClose = document.getElementById('file-sidebar-close')!;
const fileSidebarUp = document.getElementById('file-sidebar-up')!;
const fileList = document.getElementById('file-list')!;
const fileSidebarPath = document.getElementById('file-sidebar-path')!;
const fileBrowser = new FileBrowser(fileList, fileSidebarPath, messageInput, (filePath) => {
  const name = filePath.split(/[/\\]/).pop() || filePath;
  const ext = name.split('.').pop()?.toLowerCase() || '';
  pendingFilePaths.push({ path: filePath, name, ext, sessionId: activeLiveSessionId });
  renderAttachmentPreviews();
}, () => (viewingActiveSession && liveSessions.some(s => s.id === activeLiveSessionId) ? activeLiveSessionId : null));

fileSidebarToggle.addEventListener('click', () => {
  const isCollapsed = fileSidebar.classList.toggle('collapsed');
  if (!isCollapsed && !fileBrowser.currentPath) {
    fileBrowser.load(); // Load session cwd
  }
  localStorage.setItem('tau-file-sidebar', isCollapsed ? 'closed' : 'open');
});

fileSidebarClose.addEventListener('click', () => {
  fileSidebar.classList.add('collapsed');
  localStorage.setItem('tau-file-sidebar', 'closed');
});

fileSidebarUp.addEventListener('click', () => {
  const parent = fileBrowser.getParentPath();
  if (parent) fileBrowser.load(parent);
});

fetch('/api/health').then(r => r.json()).then(data => {
  const names: Record<string, string> = { win32: 'Explorer', darwin: 'Finder', linux: 'file manager' };
  const name = names[data.platform] || 'file manager';
  document.getElementById('file-sidebar-finder')!.title = `Open in ${name}`;
}).catch(() => {});

document.getElementById('file-sidebar-finder')!.addEventListener('click', () => {
  const sessionId = viewingActiveSession && activeLiveSessionId ? activeLiveSessionId : null;
  if (fileBrowser.currentPath && sessionId) {
    fetch('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: fileBrowser.currentPath, sessionId }),
    });
  }
});

// Restore file sidebar state
if (localStorage.getItem('tau-file-sidebar') === 'open') {
  fileSidebar.classList.remove('collapsed');
  fileBrowser.load();
}


// ═══════════════════════════════════════
// Focus tracking for tab title notifications
// ═══════════════════════════════════════

window.addEventListener('focus', () => {
  hasFocus = true;
  unreadCount = 0;
  document.title = originalTitle;
});





window.addEventListener('blur', () => {
  hasFocus = false;
});

// Reconnect WebSocket when returning to the app (iOS suspends WS connections)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wsClient.ws?.readyState !== WebSocket.OPEN) {
    console.log('[App] Returning to app, reconnecting...');
    wsClient.forceReconnect();
  }
});

// ═══════════════════════════════════════
// Scroll-to-bottom button + new message indicator
// ═══════════════════════════════════════

messagesContainer.addEventListener('scroll', () => {
  const threshold = 150;
  const atBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < threshold;
  isScrolledUp = !atBottom;
  
  if (atBottom) {
    scrollBottomBtn.classList.add('hidden');
    scrollBottomBadge.classList.add('hidden');
    hasNewWhileScrolled = false;
  } else {
    scrollBottomBtn.classList.remove('hidden');
  }
});

scrollBottomBtn.addEventListener('click', () => {
  messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
  scrollBottomBtn.classList.add('hidden');
  scrollBottomBadge.classList.add('hidden');
  hasNewWhileScrolled = false;
});

function scrollToBottom() {
  messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
}

function showNewMessageBadge() {
  if (isScrolledUp) {
    hasNewWhileScrolled = true;
    scrollBottomBadge.classList.remove('hidden');
  }
}

// ═══════════════════════════════════════
// WebSocket event handlers
// ═══════════════════════════════════════

wsClient.addEventListener('connected', () => {
  updateConnectionStatus('connected');
  // Fetch model context window size for token % display
  setTimeout(fetchContextWindow, 1000);

});

wsClient.addEventListener('disconnected', () => {
  updateConnectionStatus('disconnected');
});

wsClient.addEventListener('reconnectFailed', () => {
  updateConnectionStatus('disconnected');
  messageRenderer.renderError('Connection lost. Please refresh the page.');
});

wsClient.addEventListener('rpcEvent', (e: Event) => {
  const detail = (e as CustomEvent<RpcEventDetail>).detail || {};
  const event = (detail.event || detail) as AppEvent;
  const sessionId = detail.sessionId;
  if (sessionId) {
    const session = liveSessions.find(s => s.id === sessionId);
    if (session) {
      session.lastActiveAt = new Date().toISOString();
      if (event.type === 'agent_start' || event.type === 'turn_start') session.isStreaming = true;
      if (event.type === 'agent_end' || event.type === 'turn_end') session.isStreaming = false;
      if (event.type === 'session_name' && event.name) session.sessionName = event.name;
      if ((event.message as AppMessage)?.usage) session.contextUsage = { ...(session.contextUsage || {}), usage: (event.message as AppMessage).usage };
      renderLiveTabs();
    }
    if (sessionId !== activeLiveSessionId || !viewingActiveSession) {
      if (event.type === 'extension_ui_request') queueExtensionUIRequest(event, sessionId);
      return;
    }
  }
  handleRPCEvent(event, sessionId);
});

wsClient.addEventListener('serverError', (e: Event) => {
  messageRenderer.renderError((e as CustomEvent<{ message: string }>).detail.message);
});

wsClient.addEventListener('stateUpdate', (e: Event) => {
  const detail = (e as CustomEvent<{ liveSessions?: LiveSession[] }>).detail;
  const wasViewingLive = viewingActiveSession;
  const launcherVisible = launcherPanel.isVisible();
  hasReceivedInitialServerState = true;
  setLiveSessions(detail.liveSessions || []);
  if (!hasRestoredInitialLiveSession || (wasViewingLive && !launcherVisible)) {
    hasRestoredInitialLiveSession = true;
    restoreActiveLiveSession();
  } else {
    if (activeLiveSessionId && !liveSessions.some(s => s.id === activeLiveSessionId)) {
      activeLiveSessionId = null;
      localStorage.removeItem('tau-active-live-session-id');
      renderQueuedMessages();
      renderLiveTabs();
    }
    updateLiveSessionInputState();
    updateLiveSessionIndicators();
  }
});

wsClient.addEventListener('liveSessionCreated', (e: Event) => {
  upsertLiveSession((e as CustomEvent<LiveSession>).detail);
});

wsClient.addEventListener('liveSessionUpdated', (e: Event) => {
  const detail = (e as CustomEvent<LiveSession>).detail;
  upsertLiveSession(detail);
  if (detail?.id === activeLiveSessionId) applyActiveSessionMetadata(detail);
});

wsClient.addEventListener('liveSessionClosed', (e: Event) => {
  handleLiveSessionClosed((e as CustomEvent<{ sessionId: string }>).detail.sessionId);
});

// Receive a full live-session state snapshot.
wsClient.addEventListener('liveSessionSnapshot', (e: Event) => {
  applyLiveSessionSnapshot((e as CustomEvent<LiveSessionSnapshotData>).detail);
});

// ═══════════════════════════════════════
// Live-session tabs
// ═══════════════════════════════════════

const liveTabsList = document.getElementById('live-tabs-list');
const liveTabAddBtn = document.getElementById('live-tab-add');
const newLiveSessionOverlay = document.getElementById('new-live-session-overlay');
const newLiveSessionModal = document.getElementById('new-live-session-modal');
const newLiveSessionForm = document.getElementById('new-live-session-form');
const newLiveSessionCwd = document.getElementById('new-live-session-cwd')!;
const newLiveSessionModel = document.getElementById('new-live-session-model')!;
const newLiveSessionProjects = document.getElementById('new-live-session-projects');
const newLiveSessionSubmit = document.getElementById('new-live-session-submit')!;

function setLiveSessions(sessions: LiveSession[]) {
  liveSessions = sessions || [];
  liveInstances = liveSessions.map(s => ({ sessionFile: s.sessionFile, cwd: s.cwd, port: location.port }));
  renderLiveTabs();
  updateLiveSessionIndicators();
}

function handleLiveSessionClosed(closedId: string) {
  if (!closedId) return;
  liveSessions = liveSessions.filter(s => s.id !== closedId);
  messageQueue = messageQueue.filter(cmd => cmd.sessionId !== closedId);
  pendingExtensionUIRequests = pendingExtensionUIRequests.filter(req => req.sessionId !== closedId);
  if (dialogHandler.currentRequest?.sessionId === closedId) {
    dialogHandler.clearCurrentDialog();
    processQueuedExtensionUIRequest();
  }
  renderQueuedMessages();
  if (activeLiveSessionId === closedId) {
    const wasViewingActive = viewingActiveSession;
    activeLiveSessionId = null;
    localStorage.removeItem('tau-active-live-session-id');
    activeLiveSessionFile = null;
    currentStreamingElement = null;
    currentStreamingThinking = '';
    currentStreamingText = '';
    state.reset();
    showTypingIndicator(false);
    if (wasViewingActive) {
      messageRenderer.clear();
      toolCardRenderer.clear();
      const next = getMostRecentLiveSession();
      if (next) selectLiveSession(next.id);
      else {
        viewingActiveSession = false;
        messageRenderer.renderWelcome();
        updateLiveSessionInputState();
        updateUI();
      }
    } else {
      updateLiveSessionInputState();
      updateUI();
    }
  }
  liveInstances = liveSessions.map(s => ({ sessionFile: s.sessionFile, cwd: s.cwd, port: location.port }));
  renderLiveTabs();
  updateLiveSessionIndicators();
}

function upsertLiveSession(session: LiveSession) {
  if (!session) return;
  const idx = liveSessions.findIndex(s => s.id === session.id);
  let shouldRenderTabs = false;
  if (idx >= 0) {
    const before = liveTabSignature(liveSessions[idx]);
    liveSessions[idx] = { ...liveSessions[idx], ...session };
    shouldRenderTabs = before !== liveTabSignature(liveSessions[idx]);
  } else {
    liveSessions.push(session);
    shouldRenderTabs = true;
  }
  liveInstances = liveSessions.map(s => ({ sessionFile: s.sessionFile, cwd: s.cwd, port: location.port }));
  if (shouldRenderTabs) renderLiveTabs();
  updateLiveSessionIndicators();
}

function getMostRecentLiveSession() {
  return [...liveSessions].sort((a, b) =>
    new Date(b.lastActiveAt || b.createdAt || 0).getTime() - new Date(a.lastActiveAt || a.createdAt || 0).getTime()
  )[0] || null;
}

function basename(p: string) {
  return (p || '').split(/[/\\]/).filter(Boolean).pop() || p || 'session';
}

function compactModelLabel(session: LiveSession) {
  const raw = session.modelLabel || session.modelSpec || (session.model as ModelRecord)?.id || (session.model as ModelRecord)?.name || 'default';
  return String(raw).replace(/^.*\//, '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function liveTabSignature(session: LiveSession) {
  return [
    session.sessionName || basename(session.cwd || ''),
    compactModelLabel(session),
    session.cwd || '',
    session.modelSpec || '',
    session.isStreaming ? 'streaming' : 'idle',
    hasPendingExtensionUIRequest(session.id) ? 'ui' : '',
  ].join('\u001f');
}

function renderLiveTabs() {
  if (!liveTabsList) return;
  const existing = new Map<string, HTMLButtonElement>();
  liveTabsList.querySelectorAll<HTMLButtonElement>('.live-tab').forEach((tab) => {
    if (tab.dataset.sessionId) existing.set(tab.dataset.sessionId, tab);
  });
  const seen = new Set<string>();
  liveSessions.forEach((session, index) => {
    let tab = existing.get(session.id);
    if (!tab) {
      tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'live-tab';
      tab.dataset.sessionId = session.id;
      tab.addEventListener('click', () => selectLiveSession(session.id));
    }
    seen.add(session.id);
    tab.classList.toggle('active', session.id === activeLiveSessionId);
    tab.title = `${session.cwd || ''}${session.modelSpec ? ` • ${session.modelSpec}` : ''}`;
    const signature = liveTabSignature(session);
    if (tab.dataset.signature !== signature) {
      tab.dataset.signature = signature;
      tab.innerHTML = `
        ${session.isStreaming ? '<span class="live-tab-streaming-dot"></span>' : ''}
        ${hasPendingExtensionUIRequest(session.id) ? '<span class="live-tab-ui-dot" title="Waiting for response">?</span>' : ''}
        <span class="live-tab-title">${escapeHtml(session.sessionName || basename(session.cwd || ''))}</span>
        <span class="live-tab-model">${escapeHtml(compactModelLabel(session))}</span>
        <span class="live-tab-close" title="Close Tau tab">×</span>
      `;
      tab.querySelector('.live-tab-close')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeLiveSession(session.id);
      });
    }
    const currentAtIndex = liveTabsList.children[index];
    if (currentAtIndex !== tab) liveTabsList.insertBefore(tab, currentAtIndex || null);
  });
  for (const [id, tab] of existing) {
    if (!seen.has(id)) tab.remove();
  }
}

function restoreActiveLiveSession() {
  const saved = activeLiveSessionId && liveSessions.find(s => s.id === activeLiveSessionId);
  const next = saved || getMostRecentLiveSession();
  if (next) {
    selectLiveSession(next.id);
  } else {
    activeLiveSessionId = null;
    viewingActiveSession = false;
    activeLiveSessionFile = null;
    localStorage.removeItem('tau-active-live-session-id');
    state.reset();
    renderQueuedMessages();
    renderLiveTabs();
    updateLiveSessionInputState();
  }
}

async function selectLiveSession(id: string) {
  const session = liveSessions.find(s => s.id === id);
  if (!session) return;
  suspendCurrentDialogForTabSwitch(id);
  launcherPanel.hide();
  activeLiveSessionId = id;
  localStorage.setItem('tau-active-live-session-id', id);
  viewingActiveSession = true;
  activeLiveSessionFile = session.sessionFile || null;
  renderLiveTabs();
  renderQueuedMessages();
  applyActiveSessionMetadata(session);
  currentStreamingElement = null;
  currentStreamingThinking = '';
  currentStreamingText = '';
  state.reset();
  state.setStreaming(!!session.isStreaming);
  messageRenderer.clear();
  toolCardRenderer.clear();
  try {
    const res = await fetch(`/api/live-sessions/${encodeURIComponent(id)}/snapshot`);
    const data = await res.json();
    if (!res.ok || data.error) {
      handleLiveSessionClosed(id);
      throw new Error(data.error || 'Live session not found');
    }
    applyLiveSessionSnapshot({ ...data, sessionId: id });
  } catch (e) {
    messageRenderer.renderError((e instanceof Error ? e.message : '') || 'Failed to load live session snapshot');
    return;
  }
  if (!fileSidebar.classList.contains('collapsed')) fileBrowser.load();
  updateLiveSessionInputState();
  processQueuedExtensionUIRequest(id);
  flushQueue();
}

function applyActiveSessionMetadata(session: LiveSession) {
  if (!session) return;
  // Server is canonical: session.model is always null or a full {provider,id}
  // object, so assign directly. No modelLabel/modelSpec string fallbacks.
  modelPickerController.setModelState(session.model || '', session.thinkingLevel || 'off');
}

async function closeLiveSession(id: string) {
  const session = liveSessions.find(s => s.id === id);
  if (!session) return;
  const hasQueuedMessages = messageQueue.some(cmd => cmd.sessionId === id);
  if (session.isStreaming || hasQueuedMessages) {
    const reason = session.isStreaming && hasQueuedMessages
      ? 'This Tau tab is streaming and has queued unsent messages. Close it, terminate the Pi session, and discard the queue?'
      : session.isStreaming
        ? 'This Tau tab is streaming. Close it and terminate the Pi session?'
        : 'This Tau tab has queued unsent messages. Close it and discard them?';
    if (!confirm(reason)) return;
  }
  try {
    await fetch(`/api/live-sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (e) {
    messageRenderer.renderError('Failed to close Tau tab');
  }
}

async function loadProjectChips() {
  if (!newLiveSessionProjects) return;
  newLiveSessionProjects.innerHTML = '';
  try {
    const res = await fetch('/api/projects');
    const data = await res.json();
    for (const project of data.projects || []) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'project-chip';
      chip.textContent = project.name;
      chip.title = project.path;
      chip.addEventListener('click', () => { newLiveSessionCwd.value = project.path; });
      newLiveSessionProjects.appendChild(chip);
    }
  } catch {}
}

function openNewLiveSessionModal() {
  newLiveSessionOverlay?.classList.remove('hidden');
  newLiveSessionModal?.classList.remove('hidden');
  newLiveSessionSubmit.disabled = false;
  if (!newLiveSessionCwd.value) newLiveSessionCwd.value = liveSessions.find(s => s.id === activeLiveSessionId)?.cwd || '';
  loadProjectChips();
  requestAnimationFrame(() => newLiveSessionCwd?.focus());
}

function closeNewLiveSessionModal() {
  newLiveSessionOverlay?.classList.add('hidden');
  newLiveSessionModal?.classList.add('hidden');
}

liveTabAddBtn?.addEventListener('click', openNewLiveSessionModal);
document.getElementById('new-live-session-close')?.addEventListener('click', closeNewLiveSessionModal);
document.getElementById('new-live-session-cancel')?.addEventListener('click', closeNewLiveSessionModal);
newLiveSessionOverlay?.addEventListener('click', closeNewLiveSessionModal);
newLiveSessionForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const cwd = newLiveSessionCwd.value.trim();
  if (!cwd) return;
  newLiveSessionSubmit.disabled = true;
  newLiveSessionSubmit.textContent = 'Starting…';
  try {
    const res = await fetch('/api/live-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, model: newLiveSessionModel.value.trim() }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Failed to create Tau tab');
    upsertLiveSession(data.session);
    closeNewLiveSessionModal();
    newLiveSessionModel.value = '';
    await selectLiveSession(data.session.id);
  } catch (err) {
    messageRenderer.renderError((err instanceof Error ? err.message : '') || 'Failed to create Tau tab');
  } finally {
    newLiveSessionSubmit.disabled = false;
    newLiveSessionSubmit.textContent = 'Create tab';
  }
});

// ═══════════════════════════════════════
// RPC event handlers
// ═══════════════════════════════════════

function handleRPCEvent(event: AppEvent, sessionId: string | null = null) {
  switch (event.type) {
    case 'agent_start':
    case 'turn_start':
      handleAgentStart();
      break;
    case 'agent_end':
    case 'turn_end':
      handleAgentEnd();
      break;
    case 'message_start':
      handleMessageStart(event.message as AppMessage);
      break;
    case 'message_update':
      handleMessageUpdate(event);
      break;
    case 'message_end':
      handleMessageEnd(event.message as AppMessage);
      break;
    case 'tool_execution_start':
      handleToolExecutionStart(event);
      break;
    case 'tool_execution_update':
      handleToolExecutionUpdate(event);
      break;
    case 'tool_execution_end':
      handleToolExecutionEnd(event);
      break;
    case 'auto_compaction_start':
      handleCompactionStart();
      break;
    case 'auto_compaction_end':
      handleCompactionEnd(event);
      break;
    case 'extension_ui_request':
      handleExtensionUIRequest(event, sessionId);
      break;
    case 'extension_error':
      messageRenderer.renderError(`Extension error: ${event.error}`);
      break;
    case 'session_name':
      // Auto-title: update sidebar with new session name
      if (event.name) {
        const activeItem = document.querySelector('.session-item.active .session-title');
        if (activeItem) activeItem.textContent = event.name;
      }
      break;
  }
}

function handleCompactionStart() {
  const el = document.createElement('div');
  el.className = 'system-message compaction-message';
  el.id = 'compaction-indicator';
  el.innerHTML = '<span class="compaction-spinner">⟳</span> Compacting context…';
  messagesContainer.appendChild(el);
  scrollToBottom();
}

function handleCompactionEnd(event: AppEvent) {
  const indicator = document.getElementById('compaction-indicator');
  if (indicator) {
    const summary = event.summary ? ` — ${event.summary}` : '';
    indicator.innerHTML = `✓ Context compacted${summary}`;
    indicator.classList.add('compaction-done');
  }
  // Reset token tracking — the stats refresh below and the next message
  // bring in fresh post-compaction numbers.
  lastInputTokens = 0;
  updateContextPill();
  hideCompactButton();
  void sessionStatsCard.refresh();
}

function handleAgentStart() {
  state.setStreaming(true);
  showTypingIndicator(true);
  updateUI();
}

function handleAgentEnd() {
  const wasStreaming = state.isStreaming;
  state.setStreaming(false);
  showTypingIndicator(false);
  currentStreamingElement = null;
  currentStreamingText = '';
  updateUI();

  // A turn just finished — pull authoritative post-turn stats from pi so the
  // context pill and stats card stop relying on incremental usage events.
  // Guard with wasStreaming so paired turn_end/agent_end events do not
  // double-fetch for the same completed turn.
  if (wasStreaming) void sessionStatsCard.refresh();

  // Notify via tab title if unfocused. Guard with wasStreaming so paired
  // turn_end/agent_end events do not double-count the same completed turn.
  if (wasStreaming && !hasFocus) {
    unreadCount++;
    document.title = `(${unreadCount}) ● ${originalTitle}`;

  }
}

let currentStreamingThinking = '';

function handleMessageStart(message: AppMessage) {
  if (message.role === 'assistant') {
    currentStreamingText = '';
    currentStreamingThinking = '';
    currentStreamingElement = messageRenderer.renderAssistantMessage(
      { content: '' },
      true
    );
  } else if (message.role === 'user') {
    // User messages can echo back via backend events; only render if we did
    // not just send this message ourselves.
    if (!lastSentMessage || getMessageText(message) !== lastSentMessage) {
      const content = getMessageText(message);
      if (content) {
        messageRenderer.renderUserMessage({ content });
      }
    }
    lastSentMessage = null;
  }
}

function getMessageText(message: AppMessage) {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  return '';
}

function getMessageThinking(message: AppMessage) {
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter(b => b.type === 'thinking')
    .map(b => b.thinking || b.text || '')
    .filter(Boolean)
    .join('\n');
}

function handleMessageUpdate(event: AppEvent) {
  const { assistantMessageEvent } = event;
  if (!assistantMessageEvent) return;

  if (assistantMessageEvent.type === 'thinking_delta') {
    if (!currentStreamingElement) {
      currentStreamingElement = messageRenderer.renderAssistantMessage({ content: '' }, true);
    }
    currentStreamingThinking += assistantMessageEvent.delta;
    if (currentStreamingElement) {
      messageRenderer.updateStreamingThinking(currentStreamingElement, currentStreamingThinking);
    }
  } else if (assistantMessageEvent.type === 'text_delta') {
    if (!currentStreamingElement) {
      currentStreamingElement = messageRenderer.renderAssistantMessage({ content: '' }, true);
    }
    currentStreamingText += assistantMessageEvent.delta;
    if (currentStreamingElement) {
      messageRenderer.updateStreamingMessage(
        currentStreamingElement,
        currentStreamingText
      );
    }
  }
}

function handleMessageEnd(message: AppMessage) {
  if (!currentStreamingElement && message?.role === 'assistant') {
    messageRenderer.renderAssistantMessage(message, false, true);
  }
  if (currentStreamingElement) {
    // If this client attached mid-stream, local deltas may be incomplete. The
    // message_end payload is authoritative, so refresh the streaming DOM from it
    // before finalizing.
    if (message?.role === 'assistant') {
      const finalText = getMessageText(message);
      const finalThinking = getMessageThinking(message);
      if (finalText && finalText.length >= currentStreamingText.length) {
        currentStreamingText = finalText;
        messageRenderer.updateStreamingMessage(currentStreamingElement, currentStreamingText);
      }
      if (finalThinking && finalThinking.length >= currentStreamingThinking.length) {
        currentStreamingThinking = finalThinking;
        messageRenderer.updateStreamingThinking(currentStreamingElement, currentStreamingThinking);
      }
    }

    // Pass usage info for cost display
    const usage = message?.usage || null;
    // Pass thinking content so finalize can render the thinking block
    messageRenderer.finalizeStreamingMessage(currentStreamingElement, usage, currentStreamingThinking);
    currentStreamingElement = null;
    currentStreamingThinking = '';
    currentStreamingText = '';

    // Track session cost and tokens
    if (usage?.cost?.total) {
      sessionTotalCost += usage.cost.total;
    }
    if (usage?.input) {
      lastInputTokens = usage.input + (usage.cacheRead || 0);
      lastUsage = usage;
    }
    updateContextPill();
    showNewMessageBadge();
  }
}

function handleToolExecutionStart(event: AppEvent) {
  const { toolCallId, toolName, args } = event;
  if (!toolCallId) return;

  state.addToolExecution(toolCallId, {
    toolName,
    args,
    status: 'pending',
  });

  const exec = state.getToolExecution(toolCallId);
  if (exec) toolCardRenderer.createToolCard(exec as ToolExecution);
}

function handleToolExecutionUpdate(event: AppEvent) {
  const { toolCallId, partialResult } = event;
  if (!toolCallId) return;
  const output = formatToolOutput(partialResult);

  state.updateToolExecution(toolCallId, {
    status: 'streaming',
    output,
  });

  const exec = state.getToolExecution(toolCallId);
  if (exec) toolCardRenderer.updateToolCard(exec as ToolExecution);
}

function handleToolExecutionEnd(event: AppEvent) {
  const { toolCallId, result, isError } = event;
  if (!toolCallId) return;
  const output = formatToolOutput(result);

  state.updateToolExecution(toolCallId, {
    status: isError ? 'error' : 'complete',
    output,
    isError,
  });

  toolCardRenderer.finalizeToolCard(toolCallId, result as ToolResult, isError ?? false);
}

function hasPendingExtensionUIRequest(sessionId: string) {
  return pendingExtensionUIRequests.some(req => req.sessionId === sessionId);
}

function queueExtensionUIRequest(event: AppEvent, sessionId: string) {
  if (!sessionId) {
    handleExtensionUIRequest(event, sessionId);
    return;
  }
  if (!pendingExtensionUIRequests.some(req => req.sessionId === sessionId && req.event?.id === event.id)) {
    pendingExtensionUIRequests.push({ sessionId, event });
  }
  renderLiveTabs();
}

function processQueuedExtensionUIRequest(sessionId = activeLiveSessionId) {
  if (!sessionId || !viewingActiveSession || sessionId !== activeLiveSessionId || dialogHandler.currentRequest) return;
  const idx = pendingExtensionUIRequests.findIndex(req => req.sessionId === sessionId);
  if (idx === -1) return;
  const [{ event }] = pendingExtensionUIRequests.splice(idx, 1);
  renderLiveTabs();
  handleExtensionUIRequest(event, sessionId);
}

function suspendCurrentDialogForTabSwitch(nextSessionId: string) {
  const current = dialogHandler.currentRequest;
  if (!current?.sessionId || current.sessionId === nextSessionId) return;
  const event = current.request;
  if (event && !pendingExtensionUIRequests.some(req => req.sessionId === current.sessionId && req.event?.id === event.id)) {
    pendingExtensionUIRequests.unshift({ sessionId: current.sessionId, event });
  }
  dialogHandler.clearCurrentDialog();
  renderLiveTabs();
}

function handleExtensionUIRequest(event: AppEvent, sessionId: string | null = null) {
  const request = (sessionId ? { ...event, sessionId } : event) as DialogRequest;
  switch (event.method) {
    case 'select':
      dialogHandler.showSelect(request);
      break;
    case 'confirm':
      dialogHandler.showConfirm(request);
      break;
    case 'input':
      dialogHandler.showInput(request);
      break;
    case 'editor':
      dialogHandler.showEditor(request);
      break;
    case 'notify':
      dialogHandler.showNotification(request);
      break;
    default:
      console.warn('[App] Unknown extension UI method:', event.method);
  }
}

function formatToolOutput(result: unknown) {
  if (!result) return '';

  const r = result as { content?: MessageContentBlock[] };
  if (r.content && Array.isArray(r.content)) {
    return r.content
      .map((block) => {
        if (block.type === 'text') return block.text;
        return JSON.stringify(block);
      })
      .join('\n');
  }

  return JSON.stringify(result, null, 2);
}

// ═══════════════════════════════════════
// Input handling — textarea with auto-resize
// ═══════════════════════════════════════

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});

messageInput.addEventListener('keydown', (e) => {
  // Enter sends, Shift+Enter inserts newline
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
});

// ═══════════════════════════════════════
// Attachments (images + file browser paths)
// ═══════════════════════════════════════

const attachBtn = document.getElementById('attach-btn')!;
const imageInput = document.getElementById('image-input')!;
const imagePreviews = document.getElementById('image-previews')!;

let pendingImages: PendingImage[] = [];     // { data: base64, mimeType }
let pendingFilePaths: PendingFilePath[] = [];  // { path, name, ext } — from file browser (populated by callback above)

const MAX_IMAGE_DIM = 2048;
const VALID_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico']);

function getFileChipIcon(name: string) {
  return getFileIcon(name || 'file', false);
}

function processImageFile(file: File): Promise<PendingImage> {
  return new Promise((resolve, reject) => {
    const mimeType = VALID_MIME_TYPES.includes(file.type) ? file.type : 'image/png';

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
          const scale = MAX_IMAGE_DIM / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d')?.drawImage(img, 0, 0, width, height);

        const outputMime = (mimeType === 'image/jpeg') ? 'image/jpeg' : 'image/png';
        const quality = (outputMime === 'image/jpeg') ? 0.85 : undefined;
        const dataUrl = canvas.toDataURL(outputMime, quality);
        const base64 = dataUrl.split(',')[1];
        if (!base64) { reject(new Error('Failed to encode image')); return; }
        resolve({ data: base64, mimeType: outputMime });
      };
      img.onerror = () => reject(new Error('Failed to decode image'));
      img.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });
}

async function addAttachments(files: FileList | File[]) {
  const list = Array.from(files);            // snapshot before any await
  for (const file of list) {
    if (!file.type.startsWith('image/')) continue;
    try {
      pendingImages.push(await processImageFile(file));
    } catch (e) {
      console.error('[Tau] Image processing failed:', e);
    }
  }
  renderAttachmentPreviews();
}

attachBtn.addEventListener('click', () => imageInput.click());

imageInput.addEventListener('change', () => {
  addAttachments(imageInput.files ?? []);
  imageInput.value = '';
});

// Drag & drop on input
messageInput.addEventListener('dragover', (e) => { e.preventDefault(); });
messageInput.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.files.length > 0) addAttachments(e.dataTransfer.files);
});

// Paste images
messageInput.addEventListener('paste', (e) => {
  if (!e.clipboardData) return;
  const files: File[] = [];
  for (const item of e.clipboardData.items) {
    if (!item.type.startsWith('image/')) continue;
    files.push(item.getAsFile() as File);
  }
  if (files.length) addAttachments(files);
});

function makeRemoveBtn(onClick: () => void) {
  const btn = document.createElement('button');
  btn.className = 'image-preview-remove';
  btn.setAttribute('aria-label', 'Remove');
  btn.textContent = '✕';
  btn.addEventListener('click', onClick);
  return btn;
}

function renderAttachmentPreviews() {
  imagePreviews.innerHTML = '';
  const hasAny = pendingImages.length > 0 || pendingFilePaths.length > 0;
  if (!hasAny) { imagePreviews.classList.add('hidden'); return; }
  imagePreviews.classList.remove('hidden');

  // Binary image chips
  pendingImages.forEach((img, i) => {
    const el = document.createElement('div');
    el.className = 'image-preview';
    const thumb = document.createElement('img');
    thumb.src = `data:${img.mimeType};base64,${img.data}`;
    el.appendChild(thumb);
    el.appendChild(makeRemoveBtn(() => { pendingImages.splice(i, 1); renderAttachmentPreviews(); }));
    imagePreviews.appendChild(el);
  });

  // File browser path chips
  pendingFilePaths.forEach((fp, i) => {
    const el = document.createElement('div');
    const removeBtn = makeRemoveBtn(() => {
      const withSpace = fp.path + ' ';
      messageInput.value = messageInput.value.includes(withSpace)
        ? messageInput.value.replace(withSpace, '')
        : messageInput.value.replace(fp.path, '');
      messageInput.dispatchEvent(new Event('input'));
      pendingFilePaths.splice(i, 1);
      renderAttachmentPreviews();
    });

    if (IMAGE_EXTS.has(fp.ext)) {
      el.className = 'image-preview';
      el.title = fp.path;
      const thumb = document.createElement('img');
      thumb.style.cssText = 'width:100%;height:100%;object-fit:cover';
      const previewParams = new URLSearchParams({ path: fp.path });
      if (fp.sessionId) previewParams.set('sessionId', fp.sessionId);
      thumb.src = `/api/file/preview?${previewParams.toString()}`;
      thumb.onerror = () => {
        el.classList.add('file-chip');
        thumb.remove();
        const icon = document.createElement('span');
        icon.className = 'file-chip-icon';
        icon.textContent = getFileChipIcon(fp.name);
        const label = document.createElement('span');
        label.className = 'file-chip-name';
        label.textContent = fp.name;
        el.insertBefore(label, removeBtn);
        el.insertBefore(icon, label);
      };
      el.appendChild(thumb);
    } else {
      el.className = 'image-preview file-chip';
      el.title = fp.path;
      const icon = document.createElement('span');
      icon.className = 'file-chip-icon';
      icon.textContent = getFileChipIcon(fp.ext);
      const label = document.createElement('span');
      label.className = 'file-chip-name';
      label.textContent = fp.name;
      el.appendChild(icon);
      el.appendChild(label);
    }

    el.appendChild(removeBtn);
    imagePreviews.appendChild(el);
  });
}

// ═══════════════════════════════════════
// Send message (with images)
// ═══════════════════════════════════════

let messageQueue: QueuedCommand[] = [];

function sendMessage() {
  const message = messageInput.value.trim();
  if (!message && pendingImages.length === 0) return;

  messageInput.value = '';
  messageInput.style.height = 'auto';

  const cmd: QueuedCommand = { type: 'prompt', message: message || '(see attached image)' };

  if (pendingImages.length > 0) {
    cmd.images = pendingImages.map(img => {
      console.log(`[Tau] Sending image: mimeType=${img.mimeType}, dataLen=${img.data?.length}`);
      return { type: 'image', data: img.data, mimeType: img.mimeType || 'image/png' };
    });
    pendingImages = [];
  }

  pendingFilePaths = [];
  renderAttachmentPreviews();

  if (!activeLiveSessionId) {
    messageRenderer.renderError('Create or select a Tau tab first.');
    updateLiveSessionInputState();
    return;
  }

  cmd.sessionId = activeLiveSessionId;

  if (state.isStreaming) {
    // Queue it for the current Tau tab only; do not let tab switches retarget it.
    messageQueue.push(cmd);
    lastSentMessage = message;
    renderQueuedMessages();
    return;
  }

  lastSentMessage = message;
  messageRenderer.renderUserMessage({ content: message, images: cmd.images });
  wsClient.send(cmd);
}

const queuedMessagesEl = document.getElementById('queued-messages')!;

function renderQueuedMessages() {
  queuedMessagesEl.innerHTML = '';
  if (messageQueue.length === 0) {
    queuedMessagesEl.classList.add('hidden');
    return;
  }
  queuedMessagesEl.classList.remove('hidden');
  messageQueue.forEach((cmd, i) => {
    if (cmd.sessionId !== activeLiveSessionId) return;
    const el = document.createElement('div');
    el.className = 'queued-msg';
    el.innerHTML = `
      <span class="queued-msg-label">Queued</span>
      <span class="queued-msg-text">${escapeHtml(cmd.message || '')}</span>
      <button class="queued-msg-cancel" title="Cancel">×</button>
    `;
    el.querySelector('.queued-msg-cancel')?.addEventListener('click', () => {
      messageQueue.splice(i, 1);
      renderQueuedMessages();
    });
    queuedMessagesEl.appendChild(el);
  });
  queuedMessagesEl.classList.toggle('hidden', queuedMessagesEl.children.length === 0);
}

function escapeHtml(text: string) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function flushQueue() {
  if (!activeLiveSessionId || state.isStreaming) return;
  const idx = messageQueue.findIndex(cmd => cmd.sessionId === activeLiveSessionId);
  if (idx >= 0) {
    const [cmd] = messageQueue.splice(idx, 1);
    lastSentMessage = cmd.message ?? null;
    messageRenderer.renderUserMessage({ content: cmd.message, images: cmd.images });
    renderQueuedMessages();
    wsClient.send(cmd);
  }
}

abortBtn.addEventListener('click', () => {
  if (!viewingActiveSession || !activeLiveSessionId) return;
  wsClient.send({ type: 'abort', sessionId: activeLiveSessionId });
  messageRenderer.renderError('Aborted by user');
  showTypingIndicator(false);
});

// Command Palette
const commandPaletteController = setupCommandPalette([
  { icon: '🗜️', label: 'Compact', desc: 'Compact context to save tokens', action: () => rpcCommand({ type: 'compact' }, 'Compacting...') },
  { icon: '📋', label: 'Export HTML', desc: 'Export session as HTML file', action: () => rpcExportHtml() },
  { icon: '📊', label: 'Session Stats', desc: 'Show session statistics', action: () => showSessionStats() },
  { icon: '⬇️', label: 'Expand All Tools', desc: 'Expand all tool cards', action: () => toolCardRenderer.expandAll() },
  { icon: '⬆️', label: 'Collapse All Tools', desc: 'Collapse all tool cards', action: () => toolCardRenderer.collapseAll() },
]);

async function rpcCommand(cmd: RpcCommand, statusMsg = '') {
  try {
    const backendLocalCommands = new Set(['get_auth', 'set_auth', 'get_available_models']);
    const needsLiveSession = !cmd.sessionId && !cmd.filePath && !backendLocalCommands.has(cmd.type);
    if (needsLiveSession && (!viewingActiveSession || !activeLiveSessionId)) {
      const error = 'Select a live Tau tab first.';
      setStatusMessage(error, wsClient.ws?.readyState === WebSocket.OPEN ? 'Connected' : 'Disconnected', 3000);
      return { type: 'response', command: cmd.type, success: false, error };
    }
    if (!cmd.sessionId && viewingActiveSession && activeLiveSessionId) cmd = { ...cmd, sessionId: activeLiveSessionId };
    if (statusMsg) setStatusMessage(statusMsg);
    const resp = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    const data = await resp.json();
    if (data.success) {
      setStatusMessage('Done', 'Connected', 2000);
    } else {
      setStatusMessage(data.error || 'Failed', 'Connected', 3000);
    }
    return data;
  } catch (e) {
    setStatusMessage('Error', 'Connected', 3000);
  }
}

async function rpcExportHtml() {
  const data = await rpcCommand({ type: 'export_html' }, 'Exporting...');
  if (data?.success && data.data?.path) {
    setStatusMessage(`Exported: ${data.data.path}`, 'Connected', 4000);
  }
}

async function showSessionStats() {
  const data = await rpcCommand({ type: 'get_session_stats' }, 'Loading stats...');
  if (data?.success && data.data) {
    const s = data.data;
    const lines = [
      `📊 Session Stats`,
      `Messages: ${s.totalMessages} (${s.userMessages} user, ${s.assistantMessages} assistant)`,
      `Tool calls: ${s.toolCalls}`,
    ];
    if (s.tokens) {
      lines.push(`Context: ~${(s.tokens.input / 1000).toFixed(1)}k tokens`);
    }
    messageRenderer.renderSystemMessage(lines.join('\n'));
  }
}

// Model Picker
const modelPickerController = setupModelPicker({
  getActiveLiveSessionId: () => activeLiveSessionId,
  isViewingActiveSession: () => viewingActiveSession,
  rpcCommand,
  flashStatusError,
  escapeHtml,
  setContextWindowSize(value) { contextWindowSize = value; },
  updateContextPill,
});

// ═══════════════════════════════════════
// Keyboard shortcuts
// ═══════════════════════════════════════

document.addEventListener('keydown', (e) => {
  // Escape — Abort streaming, or close sidebar on mobile
  if (e.key === 'Escape') {
    // Close palettes/panels first
    if (modelPickerController.closeIfOpen()) return;
    if (!settingsPanel.classList.contains('hidden')) {
      closeSettings();
      return;
    }
    if (commandPaletteController.closeIfOpen()) return;

    if (state.isStreaming && viewingActiveSession && activeLiveSessionId) {
      wsClient.send({ type: 'abort', sessionId: activeLiveSessionId });
      messageRenderer.renderError('Aborted by user');
      showTypingIndicator(false);
    } else if (!sidebarEl.classList.contains('collapsed') && window.innerWidth <= 768) {
      toggleSidebar();
    }
  }

  // / — Focus message input (when not already in an input)
  if (e.key === '/' && !isInInput()) {
    e.preventDefault();
    messageInput.focus();
  }
});

function isInInput() {
  const tag = document.activeElement?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;
}

// ═══════════════════════════════════════
// Sidebar
// ═══════════════════════════════════════

function isMobile() {
  return window.innerWidth <= 768;
}

function updateSidebarToggleIcon() {
  sidebarToggle.textContent = '☰';
}

function toggleSidebar() {
  sidebarEl.classList.toggle('collapsed');
  sidebarOverlay.classList.toggle('visible', !sidebarEl.classList.contains('collapsed') && isMobile());
  updateSidebarToggleIcon();
}

sidebarToggle.addEventListener('click', toggleSidebar);

sidebarOverlay.addEventListener('click', () => {
  sidebarEl.classList.add('collapsed');
  sidebarOverlay.classList.remove('visible');
  updateSidebarToggleIcon();
});



const newSessionBtn = document.getElementById('new-session-btn')!;
newSessionBtn.addEventListener('click', openNewLiveSessionModal);

refreshSessionsBtn.addEventListener('click', () => {
  if (isMobile()) {
    location.reload();
    return;
  }
  refreshSessionsBtn.classList.add('spinning');
  sidebar.loadSessions().then(() => {
    setTimeout(() => refreshSessionsBtn.classList.remove('spinning'), 600);
    updateLiveSessionIndicators();
  });
});

// Swipe from left edge to open sidebar on mobile
(function initSwipeGesture() {
  let touchStartX = 0;
  let touchStartY = 0;
  let tracking = false;

  document.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    // Only track swipes starting within 20px of left edge
    if (touch.clientX < 20 && isMobile() && sidebarEl.classList.contains('collapsed')) {
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      tracking = true;
    }
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartX;
    const dy = Math.abs(touch.clientY - touchStartY);
    // If vertical movement dominates, cancel
    if (dy > dx) {
      tracking = false;
    }
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchStartX;
    if (dx > 60) {
      sidebarEl.classList.remove('collapsed');
      sidebarOverlay.classList.add('visible');
    }
  }, { passive: true });
})();

// Session search
sessionSearchInput.addEventListener('input', () => {
  sidebar.setSearchQuery(sessionSearchInput.value);
});

async function newSession() {
  sessionTotalCost = 0;
  lastInputTokens = 0;
  lastUsage = null;
  updateContextPill();
  await switchSession(null);
  sidebar.clearActive();
  if (isMobile()) {
    sidebarEl.classList.add('collapsed');
    sidebarOverlay.classList.remove('visible');
  }
  if (!isMobile()) messageInput.focus();
}

async function handleSessionSelect(session: SidebarSession | null, project: SidebarProject | null) {
  if (session) sidebar.setActive(session.filePath);
  sessionTotalCost = 0;
  lastInputTokens = 0;
  lastUsage = null;
  updateContextPill();
  if (session) await switchSession(session.filePath, session, project);

  // Close sidebar on mobile after selecting
  if (isMobile()) {
    sidebarEl.classList.add('collapsed');
    sidebarOverlay.classList.remove('visible');
  }
}

async function switchSession(sessionFile: string | null | undefined, session: SidebarSession | null = null, project: SidebarProject | null = null) {
  try {
    // Clear any streaming state from previous session to prevent bleed
    currentStreamingElement = null;
    currentStreamingThinking = '';
    currentStreamingText = '';
    viewingActiveSession = false;
    
    state.reset();
    showTypingIndicator(false);
    updateUI();
    messageRenderer.clear();
    toolCardRenderer.clear();

    // Clicking a historical session resumes it as a live backend Tau tab.
    // selectLiveSession() will load the resumed tab snapshot with the same
    // historical entries after the backend has attached to the session file.
    if (sessionFile) {
      const live = liveSessions.find(s => s.sessionFile === sessionFile);
      if (live) {
        await selectLiveSession(live.id);
        return;
      }
      // No live tab yet — ask the server to resume this session.
      messageRenderer.renderSystemMessage('Resuming session…');
      try {
        const resumeBody: Record<string, unknown> = { filePath: sessionFile };
        if (project?.path) resumeBody.cwd = project.path;
        const res = await fetch('/api/live-sessions/resume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(resumeBody),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          messageRenderer.clear();
          messageRenderer.renderError(data.error || 'Failed to resume session');
          viewingActiveSession = false;
          updateLiveSessionInputState();
          updateUI();
          return;
        }
        // If the server found an existing live tab (reused), just focus it.
        if (data.reused && data.session) {
          upsertLiveSession(data.session);
          await selectLiveSession(data.session.id);
          return;
        }
        upsertLiveSession(data.session);
        await selectLiveSession(data.session.id);
      } catch (e) {
        messageRenderer.clear();
        messageRenderer.renderError('Failed to resume session');
        viewingActiveSession = false;
        updateLiveSessionInputState();
        updateUI();
      }
      return;
    }

    messageRenderer.renderWelcome();
  } catch (error) {
    console.error('[App] Failed to switch session:', error);
    messageRenderer.renderError('Failed to switch session');
  }
}

// ═══════════════════════════════════════
// Live-session snapshot sync
// ═══════════════════════════════════════

function applyLiveSessionSnapshot(data: LiveSessionSnapshotData) {
  console.log('[LiveSession] Received state snapshot:', data.entries?.length, 'entries');
  if (data.sessionId && data.sessionId !== activeLiveSessionId) return;
  hasReceivedInitialServerState = true;

  // Track the active session
  activeLiveSessionFile = data.sessionFile || data.session?.sessionFile || null;
  viewingActiveSession = !!activeLiveSessionId;
  state.setStreaming(!!data.isStreaming);
  showTypingIndicator(!!data.isStreaming);
  updateLiveSessionInputState();
  updateUI();
  updateLiveSessionIndicators();

  // Update model display — server is canonical, assign directly.
  if (data.model !== undefined) {
    if (data.model?.contextWindow) {
      contextWindowSize = Number(data.model.contextWindow) || 0;
    }
    modelPickerController.setModelState(data.model || '', data.thinkingLevel || 'off');
  } else if (data.thinkingLevel) {
    modelPickerController.setThinkingLevel(data.thinkingLevel || 'off');
  }

  // Clear and render message history. Reset streaming handles after the
  // snapshot arrives because live deltas may have created a streaming element
  // while the snapshot request was in flight; that element is about to be
  // removed from the DOM.
  currentStreamingElement = null;
  currentStreamingThinking = '';
  currentStreamingText = '';
  messageRenderer.clear();
  sessionTotalCost = 0;
  lastInputTokens = 0;
  lastUsage = null;

  if (data.entries && data.entries.length > 0) {
    renderSessionHistory(data.entries);
  } else {
    messageRenderer.renderWelcome();
  }

  updateContextPill();
  // A live session just loaded — fetch its authoritative stats from pi.
  void sessionStatsCard.refresh();
}

// Mark all live sessions in the sidebar with a green dot
function updateLiveSessionIndicators() {
  const liveFiles = new Set(liveInstances.map(i => i.sessionFile));
  // Also include the current active live session
  if (activeLiveSessionFile) liveFiles.add(activeLiveSessionFile);

  document.querySelectorAll('.session-item').forEach(el => {
    el.classList.toggle('has-live-session', liveFiles.has(el.dataset.filePath));
  });
}

// Refresh live-session list for sidebar indicators if WS missed an update
async function pollInstances() {
  try {
    const res = await fetch('/api/live-sessions');
    if (res.ok) {
      const data = await res.json();
      const wasActive = activeLiveSessionId;
      setLiveSessions(data.sessions || []);
      const activeSession = wasActive ? liveSessions.find(s => s.id === wasActive) : null;
      if (wasActive && !activeSession) {
        handleLiveSessionClosed(wasActive);
      } else if (activeSession && viewingActiveSession) {
        state.setStreaming(!!activeSession.isStreaming);
        showTypingIndicator(!!activeSession.isStreaming);
        applyActiveSessionMetadata(activeSession);
        updateLiveSessionInputState();
        updateUI();
      }
    }
  } catch {}
}

// Poll every 10 seconds
setInterval(pollInstances, 10000);

// Enable/disable input based on whether we're viewing a live backend Tau tab
function updateLiveSessionInputState() {
  const inputArea = document.querySelector('.input-area');
  const hasLiveSession = viewingActiveSession && !!activeLiveSessionId;
  if (hasLiveSession) {
    messageInput.disabled = false;
    sendBtn.disabled = false;
    messageInput.placeholder = 'Message...';
    inputArea?.classList.remove('no-active-live-session');
  } else {
    messageInput.disabled = true;
    sendBtn.disabled = true;
    messageInput.placeholder = hasReceivedInitialServerState ? 'Create or select a Tau tab to chat' : 'Connecting...';
    inputArea?.classList.add('no-active-live-session');
  }
  document.getElementById('command-btn')!.disabled = !hasLiveSession;
  modelPickerController.setEnabled(hasLiveSession);
}

// ═══════════════════════════════════════
// Session history rendering
// ═══════════════════════════════════════

function renderSessionHistory(entries: SessionHistoryEntry[]) {
  console.log(`[History] Rendering ${entries.length} entries`);
  let userCount = 0, assistantCount = 0, toolCardCount = 0, toolResultCount = 0;

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
      // Extract images from content blocks
      const images = Array.isArray(msg.content)
        ? msg.content
            .filter((b) => b.type === 'image')
            .map((b) => ({ data: b.source?.data || b.data || '', mimeType: b.source?.media_type || b.media_type || 'image/png' }))
        : [];
      if (content || images.length > 0) {
        userCount++;
        messageRenderer.renderUserMessage({ content: content || '', images: images.length > 0 ? images : undefined }, true);
      }
    } else if (msg.role === 'assistant') {
      const textBlocks = ((msg.content as MessageContentBlock[]) || []).filter((b) => b.type === 'text');
      const thinkingBlocks = ((msg.content as MessageContentBlock[]) || []).filter((b) => b.type === 'thinking');
      const toolCalls = ((msg.content as MessageContentBlock[]) || []).filter((b) => b.type === 'toolCall');

      // Build content blocks for rendering
      const contentBlocks = [];
      for (const block of (msg.content as MessageContentBlock[]) || []) {
        if (block.type === 'text' || block.type === 'thinking') {
          contentBlocks.push(block);
        }
      }

      const text = textBlocks.map((b) => b.text).join('\n');

      if (text || thinkingBlocks.length > 0) {
        assistantCount++;
        messageRenderer.renderAssistantMessage(
          {
            content: contentBlocks.length > 0 ? contentBlocks : text,
            usage: msg.usage,
          },
          false,
          true
        );

        // Track cost and tokens from history
        if (msg.usage?.cost?.total) {
          sessionTotalCost += msg.usage.cost.total;
        }
        if (msg.usage?.input) {
          lastInputTokens = msg.usage.input + (msg.usage.cacheRead || 0);
          lastUsage = msg.usage;
        }
      }

      // Show tool calls as compact history cards
      for (const tc of toolCalls) {
        toolCardCount++;
        const card = toolCardRenderer.createHistoryCard({
          toolCallId: tc.id,
          toolName: tc.name,
          args: tc.arguments || {},
        });
        console.log(`[History] Tool card created: ${tc.name}`, card?.offsetHeight, card?.innerHTML?.substring(0, 100));
      }
    } else if (msg.role === 'toolResult') {
      toolResultCount++;
      toolCardRenderer.addHistoryResult(
        msg.toolCallId ?? '',
        { content: (msg.content as MessageContentBlock[]) || [] },
        msg.isError ?? false
      );
    }
  }

  console.log(`[History] Done: ${userCount} users, ${assistantCount} assistants, ${toolCardCount} tools, ${toolResultCount} results`);
  console.log(`[History] DOM tool-card count:`, document.querySelectorAll('.tool-card').length);
  console.log(`[History] DOM thinking-block count:`, document.querySelectorAll('.thinking-block').length);

  updateContextPill();
  fetchContextWindow();

  // Jump to bottom instantly (no smooth scroll animation)
  messagesContainer.style.scrollBehavior = 'auto';
  requestAnimationFrame(() => {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    // Restore smooth scrolling after a frame
    requestAnimationFrame(() => {
      messagesContainer.style.scrollBehavior = '';
    });
  });
}

// ═══════════════════════════════════════
// UI helpers
// ═══════════════════════════════════════

function showTypingIndicator(show: boolean) {
  typingIndicator.classList.toggle('hidden', !show);
}

// The single header pill: shows context usage %, falling back to raw tokens
// (no context window info yet) or session cost (no context data yet).
// Clicking it opens the session stats card.
function updateContextPill() {
  if (lastInputTokens > 0 && contextWindowSize > 0) {
    const pct = Math.round((lastInputTokens / contextWindowSize) * 100);
    contextPillEl.textContent = pct === 0 ? '<1%' : `${pct}%`;
    contextPillEl.classList.add('visible');
    contextPillEl.classList.remove('warning', 'critical');
    if (pct >= 80) {
      contextPillEl.classList.add('critical');
    } else if (pct >= 60) {
      contextPillEl.classList.add('warning');
    }
    contextPillEl.title = `Context: ${(lastInputTokens / 1000).toFixed(1)}k / ${(contextWindowSize / 1000).toFixed(0)}k tokens — click for session stats`;
    if (pct >= 80) {
      showCompactButton();
    } else {
      hideCompactButton();
    }
  } else if (lastInputTokens > 0) {
    // No context window info yet, just show raw tokens
    contextPillEl.textContent = `${(lastInputTokens / 1000).toFixed(1)}k`;
    contextPillEl.classList.add('visible');
    contextPillEl.classList.remove('warning', 'critical');
    contextPillEl.title = 'Context tokens — click for session stats';
  } else if (sessionTotalCost > 0) {
    // No context data yet — show the session cost as a fallback.
    contextPillEl.textContent = `$${sessionTotalCost.toFixed(3)} (sub)`;
    contextPillEl.classList.add('visible');
    contextPillEl.classList.remove('warning', 'critical');
    contextPillEl.title = 'Session cost — click for session stats';
  } else {
    contextPillEl.classList.remove('visible', 'warning', 'critical');
  }
}

function showCompactButton() {
  if (document.getElementById('compact-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'compact-btn';
  btn.className = 'compact-btn';
  btn.textContent = 'Compact';
  btn.title = 'Context is over 80% — compact to save tokens';
  btn.addEventListener('click', () => {
    rpcCommand({ type: 'compact' }, 'Compacting...');
    hideCompactButton();
  });
  // Insert next to the context pill in the header
  const pillParent = contextPillEl.parentElement;
  if (pillParent) pillParent.insertBefore(btn, contextPillEl.nextSibling);
}

function hideCompactButton() {
  const btn = document.getElementById('compact-btn');
  if (btn) btn.remove();
}

async function fetchContextWindow() {
  // Delegate to fetchModelInfo which also updates the model button
  await modelPickerController.fetchModelInfo();
}

let tailscaleUrl = '';

function updateConnectionStatus(status: string) {
  statusIndicator.className = `status-indicator ${status}`;

  if (status === 'connected') {
    statusText.textContent = tailscaleUrl ? 'Connected • TS' : 'Connected';
    statusText.title = tailscaleUrl || '';
    // Fetch tailscale info on first connect
    if (!tailscaleUrl) {
      fetch('/api/health').then(r => r.json()).then(data => {
        if (data.tailscaleUrl) {
          tailscaleUrl = data.tailscaleUrl;
          statusText.textContent = 'Connected • TS';
          statusText.title = tailscaleUrl;
        }
      }).catch(() => {});
    }
  } else if (status === 'disconnected') {
    statusText.textContent = 'Disconnected';
  }
}

function updateUI() {
  const hasLiveSession = !!activeLiveSessionId && viewingActiveSession;
  const isStreaming = state.isStreaming && hasLiveSession;

  // Don't clobber an active red-dot error flash: it owns both the indicator
  // class and statusText for its full 3 s. The flash's restore callback
  // re-derives the current connection/streaming state, so skipping here is
  // safe. Other UI updates below (input enabling, abort button, etc.) still
  // run normally.
  if (statusFlashTimer === null) {
    if (isStreaming) {
      statusIndicator.classList.add('streaming');
      statusIndicator.classList.remove('connected');
      statusText.textContent = 'Working...';
    } else {
      statusIndicator.classList.remove('streaming');
      statusIndicator.classList.add('connected');
      statusText.textContent = 'Connected';
    }
  }

  messageInput.disabled = !hasLiveSession;
  sendBtn.disabled = !hasLiveSession;

  if (isStreaming) {
    abortBtn.classList.remove('hidden');
    sendBtn.classList.add('hidden');
  } else {
    abortBtn.classList.add('hidden');
    sendBtn.classList.remove('hidden');
    if (hasLiveSession) flushQueue();
  }
}

// ═══════════════════════════════════════
// WebSocket session switch handler
// ═══════════════════════════════════════

wsClient.addEventListener('sessionSwitch', () => {
  console.log('[App] Session switched');
});

// ═══════════════════════════════════════
// Theme / Settings
// ═══════════════════════════════════════



const settingsBtn = document.getElementById('settings-btn')!;
const settingsPanel = document.getElementById('settings-panel')!;
const settingsOverlay = document.getElementById('settings-overlay')!;
const settingsClose = document.getElementById('settings-close')!;
const themeGrid = document.getElementById('theme-grid')!;


const toggleAutoCompact = document.getElementById('toggle-auto-compact')!;
const btnThinkingLevel = document.getElementById('btn-thinking-level')!;
const toggleShowThinking = document.getElementById('toggle-show-thinking')!;


function buildThemeGrid() {
  themeGrid.innerHTML = '';
  const current = getCurrentTheme();

  for (const [id, theme] of Object.entries(themes)) {
    const btn = document.createElement('button');
    btn.className = `theme-swatch${current === id ? ' active' : ''}`;
    const dots = (theme.colors || []).map(c => 
      `<span class="swatch-dot" style="background:${c}"></span>`
    ).join('');
    btn.innerHTML = `<span class="swatch-colors">${dots}</span>`;
    btn.addEventListener('click', () => {
      applyTheme(id);
      themeGrid.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
    });
    themeGrid.appendChild(btn);
  }
}

async function openSettings() {
  buildThemeGrid();
  settingsPanel.classList.remove('hidden');
  settingsOverlay.classList.remove('hidden');

  // Fetch current state for toggles
  try {
    const resp = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_state', sessionId: activeLiveSessionId }),
    });
    const data = await resp.json();
    if (data.success && data.data) {
      const s = data.data;
      // Auto-compaction toggle
      toggleAutoCompact.className = `settings-toggle${s.autoCompactionEnabled ? ' on' : ''}`;
      // Thinking level
      btnThinkingLevel.textContent = s.thinkingLevel || 'off';
      modelPickerController.setThinkingLevel(s.thinkingLevel || 'off');
      // Session name is managed by Pi session history; no editable field in Tau settings.
    }
  } catch (e) {
    // Silent
  }

  // Fetch auth state
  try {
    const authData = await rpcCommand({ type: 'get_auth' });
    if (authData?.success && authData.data?.configured) {
      authSection.style.display = '';
      toggleAuth.className = `settings-toggle${authData.data.enabled ? ' on' : ''}`;
    } else {
      authSection.style.display = 'none';
    }
  } catch {
    authSection.style.display = 'none';
  }
}

function closeSettings() {
  settingsPanel.classList.add('hidden');
  settingsOverlay.classList.add('hidden');
}

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', closeSettings);

// Auto-compaction toggle
toggleAutoCompact.addEventListener('click', async () => {
  const isOn = toggleAutoCompact.classList.contains('on');
  toggleAutoCompact.className = `settings-toggle${isOn ? '' : ' on'}`;
  await rpcCommand({ type: 'set_auto_compaction', enabled: !isOn });
});

// Thinking level cycle (settings panel button)
btnThinkingLevel.addEventListener('click', async () => {
  const data = await rpcCommand({ type: 'cycle_thinking_level' });
  if (data?.success && data.data?.level) {
    btnThinkingLevel.textContent = data.data.level;
    modelPickerController.setThinkingLevel(data.data.level);
  }
});

// Show thinking toggle (local pref)
const showThinking = localStorage.getItem('tau-show-thinking') !== 'false';
toggleShowThinking.className = `settings-toggle${showThinking ? ' on' : ''}`;
if (!showThinking) document.body.classList.add('hide-thinking');

toggleShowThinking.addEventListener('click', () => {
  const isOn = toggleShowThinking.classList.contains('on');
  toggleShowThinking.className = `settings-toggle${isOn ? '' : ' on'}`;
  document.body.classList.toggle('hide-thinking', isOn);
  localStorage.setItem('tau-show-thinking', String(!isOn));
});

// Auth toggle
const toggleAuth = document.getElementById('toggle-auth')!;
const authSection = document.getElementById('settings-auth-section')!;

toggleAuth.addEventListener('click', async () => {
  const isOn = toggleAuth.classList.contains('on');
  const data = await rpcCommand({ type: 'set_auth', enabled: !isOn });
  if (data?.success) {
    toggleAuth.className = `settings-toggle${!isOn ? ' on' : ''}`;
  }
});





// Restore saved theme
const savedTheme = getCurrentTheme();
applyTheme(savedTheme);

// ═══════════════════════════════════════
// Session stats card (opened from the context pill)
// ═══════════════════════════════════════

// Fetch authoritative session stats from pi's get_session_stats RPC. Uses a
// plain fetch (not rpcCommand) so it never flashes status-bar messages.
// Resolves null when there is no live session or the fetch fails; a stale
// response for a session we already switched away from is discarded, and any
// authoritative numbers are synced into the pill's local state.
async function fetchSessionStats(): Promise<SessionStats | null> {
  if (!viewingActiveSession || !activeLiveSessionId) return null;
  const requestSessionId = activeLiveSessionId;
  try {
    const resp = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_session_stats', sessionId: requestSessionId }),
    });
    const data = await resp.json();
    if (!data?.success || !data.data) return null;
    if (activeLiveSessionId !== requestSessionId || !viewingActiveSession) return null;
    const stats = data.data as SessionStats;

    // Sync authoritative numbers into the locally-tracked pill state so the
    // pill never drifts from what pi reports. contextUsage (and its fields)
    // may be null right after compaction — keep the last known values then.
    if (typeof stats.cost === 'number') sessionTotalCost = stats.cost;
    const cu = stats.contextUsage;
    if (cu && typeof cu.contextWindow === 'number' && cu.contextWindow > 0) {
      contextWindowSize = cu.contextWindow;
    }
    if (cu && typeof cu.tokens === 'number') {
      lastInputTokens = cu.tokens;
    }
    updateContextPill();
    return stats;
  } catch {
    return null;
  }
}

const sessionStatsCard = setupSessionStatsCard({
  pillEl: contextPillEl,
  cardEl: document.getElementById('session-stats-card')!,
  fetchStats: fetchSessionStats,
  getFallback: () => ({
    usage: lastUsage,
    cost: sessionTotalCost,
    contextTokens: lastInputTokens,
    contextWindow: contextWindowSize,
  }),
});

// Voice Input
setupVoiceInput(document.getElementById('mic-btn')!, messageInput);

// ═══════════════════════════════════════
// Initialize
// ═══════════════════════════════════════

// On mobile, start with the sidebar collapsed. The context pill stays in the
// header on all screen sizes.
if (isMobile()) {
  sidebarEl.classList.add('collapsed');
}

wsClient.connect();
messageRenderer.renderWelcome();
updateLiveSessionInputState();
sidebar.loadSessions().then(() => {
  updateLiveSessionIndicators();
});
launcherPanel.init();

// Register service worker for PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Dismiss mobile splash screen
const splash = document.getElementById('mobile-splash');
if (splash) {
  requestAnimationFrame(() => {
    splash.classList.add('hidden');
    setTimeout(() => splash.remove(), 300);
  });
}

console.log('🚀 Tau initialized');
