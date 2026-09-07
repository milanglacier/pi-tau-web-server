import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

import type { ChildProcess } from 'node:child_process';
import type { AbortState, JsonRecord, LiveClient, ModelIdentity, PendingCommand, PendingDialog, RpcCommand, RpcResponse } from './types.js';
import { expandHome } from './config.js';
import { modelLabel, normalizeModel, parseModelSpecToModel } from './model-utils.js';
import { NAVIGATE_COMMAND } from './tree.js';

type DialogEntry = { request: PendingDialog; timer?: ReturnType<typeof setTimeout>; duringTurn: boolean; responding?: boolean };

type SpawnFn = (cmd: string, args: string[], opts: JsonRecord) => ChildProcess;
type PiMessageContent = string | Array<{ type: string; text?: string }>;
type PiMessage = { role?: string; content?: PiMessageContent; usage?: JsonRecord; model?: string };
type PiRpcPayload = {
  command?: string;
  id?: string;
  provider?: string;
  model?: unknown;
  thinkingLevel?: string;
  level?: string;
  sessionFile?: string;
  sessionName?: string;
  name?: string;
  contextUsage?: JsonRecord;
  tokens?: JsonRecord;
  [key: string]: unknown;
};
type PiRpcMessage = PiRpcPayload & {
  type?: string;
  success?: boolean;
  data?: PiRpcPayload;
  result?: PiRpcPayload;
  message?: PiMessage;
};

export function makeId() {
  return `tau_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

// tau's bundled pi extension (registers the /tau-tree-navigate command used
// by navigate_tree — see src/server/tree.ts). The compiled server runs from
// bin/, while the extension ships as source under src/pi-extension/ because
// pi loads extension .ts files directly.
const TAU_TREE_EXTENSION = path.resolve(import.meta.dirname, '..', 'src', 'pi-extension', 'tau-tree.ts');

export function isGenericSessionName(name: unknown) {
  const normalized = String(name || '').trim().toLowerCase();
  return normalized === 'chat' || normalized === 'new chat' || normalized === 'untitled' || normalized === 'untitled chat' || normalized === 'session';
}

export class PiRpcSession {
  manager: LiveSessionManager;
  id: string;
  cwd: string;
  modelSpec: string;
  child: ChildProcess | null;
  pid: number | null;
  createdAt: string;
  lastActiveAt: string;
  isStreaming: boolean;
  entries: JsonRecord[];
  model: ModelIdentity | null;
  thinkingLevel: string;
  sessionFile: string | null;
  sessionName: string | null;
  contextUsage: JsonRecord | null;
  pending: Map<string, PendingCommand>;
  stdoutBuffer: string;
  terminating: boolean;
  exitCode: number | null;
  titleSet: boolean;
  userMessages: string[];
  /** Last extension_error event from the child; navigate_tree reads this to explain a failed leaf move. */
  lastExtensionError: string | null;
  /** Whether navigateTree has confirmed this child loaded tau's tree extension (reset per spawn). */
  navigateCommandChecked: boolean;
  pendingDialogs = new Map<string, DialogEntry>();
  interactionRevision = 0;
  abortState: AbortState = 'idle';
  private abortPromise: Promise<RpcResponse> | null = null;
  private abortCommandId: string | null = null;
  private operationRevision = 0;
  private abortOperationRevision = 0;

  constructor(manager: LiveSessionManager, opts: { id?: string; cwd: string; modelSpec?: string; sessionFile?: string | null; entries?: JsonRecord[]; sessionName?: string | null }) {
    this.manager = manager;
    this.id = opts.id || makeId();
    this.cwd = opts.cwd;
    this.modelSpec = opts.modelSpec || '';
    this.child = null;
    this.pid = null;
    this.createdAt = new Date().toISOString();
    this.lastActiveAt = this.createdAt;
    this.isStreaming = false;
    this.entries = [];
    const parsed = parseModelSpecToModel(this.modelSpec);
    this.model = parsed.model;
    this.thinkingLevel = parsed.level || 'off';
    this.sessionFile = opts.sessionFile || null;
    this.sessionName = opts.sessionName || null;
    if (opts.entries && opts.entries.length) this.entries = opts.entries;
    this.contextUsage = null;
    this.pending = new Map();
    this.stdoutBuffer = '';
    this.terminating = false;
    this.exitCode = null;
    this.titleSet = false;
    this.userMessages = [];
    this.lastExtensionError = null;
    this.navigateCommandChecked = false;
  }

  metadata() {
    return {
      id: this.id,
      pid: this.pid,
      cwd: this.cwd,
      modelSpec: this.modelSpec,
      model: this.model,
      modelLabel: modelLabel(this.model, this.modelSpec),
      thinkingLevel: this.thinkingLevel,
      sessionFile: this.sessionFile,
      sessionName: this.sessionName,
      isStreaming: this.isStreaming,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      contextUsage: this.contextUsage,
      pendingInteractionCount: this.pendingDialogs.size,
      abortState: this.abortState,
    };
  }

  snapshot() {
    return {
      session: this.metadata(),
      pendingDialogs: this.dialogSnapshot(),
      interactionRevision: this.interactionRevision,
      entries: this.entries,
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      isStreaming: this.isStreaming,
      sessionFile: this.sessionFile,
      sessionName: this.sessionName,
      contextUsage: this.contextUsage,
    };
  }

  dialogSnapshot() {
    return Array.from(this.pendingDialogs.values(), ({ request }) => request);
  }

  private diagnostic(action: string, requestId?: string, reason?: string) {
    if (process.env.TAU_INTERACTION_DIAGNOSTICS !== '1') return;
    console.error(JSON.stringify({ scope: 'tau_interaction', sessionId: this.id, requestId, action, reason, timestamp: new Date().toISOString() }));
  }

  private broadcastDialogs() {
    this.interactionRevision++;
    this.manager.broadcast({ type: 'interaction_state', sessionId: this.id, pendingDialogs: this.dialogSnapshot(), interactionRevision: this.interactionRevision });
    this.manager.broadcastUpdated(this.id);
  }

  private removeDialog(id: string, reason: string) {
    const pending = this.pendingDialogs.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingDialogs.delete(id);
    this.diagnostic('resolved', id, reason);
    this.broadcastDialogs();
  }

  private clearDialogs(reason: string, duringTurnOnly = false) {
    for (const [id, pending] of this.pendingDialogs) {
      if (!duringTurnOnly || pending.duringTurn) this.removeDialog(id, reason);
    }
  }

  private retainDialog(event: PiRpcMessage) {
    if (!event.id || this.pendingDialogs.has(event.id)) return;
    const createdAt = Date.now();
    const timeout = typeof event.timeout === 'number' && Number.isFinite(event.timeout) && event.timeout > 0 ? event.timeout : undefined;
    const request = { ...event, id: event.id, method: event.method, createdAt, ...(timeout ? { expiresAt: createdAt + timeout } : {}) } as PendingDialog;
    const pending: DialogEntry = { request, duringTurn: this.isStreaming };
    this.pendingDialogs.set(request.id, pending);
    if (timeout) {
      // Pi owns the actual timeout; this timer only expires Tau's live UI state.
      pending.timer = setTimeout(() => this.removeDialog(request.id, 'timeout'), timeout);
      pending.timer.unref?.();
    }
    this.diagnostic('created', request.id);
    this.broadcastDialogs();
    if (this.abortState !== 'idle') this.cancelPendingDialogs();
  }

  async start() {
    if (!fs.existsSync(this.cwd) || !fs.statSync(this.cwd).isDirectory()) {
      throw new Error(`Directory not found: ${this.cwd}`);
    }
    const args = ['--mode', 'rpc', '--extension', TAU_TREE_EXTENSION];
    if (this.sessionFile) args.push('--session', this.sessionFile);
    if (this.modelSpec) args.push('--model', this.modelSpec);
    this.navigateCommandChecked = false;
    const spawnFn: SpawnFn = _spawnPiForTest || spawn;
    const child = spawnFn('pi', args, {
      cwd: this.cwd,
      env: { ...process.env, TAU_DISABLED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.pid = child.pid || null;

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => this.handleStdout(chunk));
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) console.error(`[Pi ${this.id}] ${line}`);
    });
    child.on('error', (err: Error) => this.handleExit(null, null, err));
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => this.handleExit(code, signal));

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        child.off('error', onError);
        child.off('exit', onExit);
      };
      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Pi RPC process exited during startup (${signal || code})`));
      };
      child.once('error', onError);
      child.once('exit', onExit);
      setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      }, 100);
    });

    // Give Pi a moment to enter RPC mode, then probe its state. get_state
    // populates model/thinkingLevel (and sessionFile/sessionName) via
    // updateStateFromResponse so the tab shows the real model immediately on
    // create/resume instead of a placeholder until the first message.
    // get_session_stats fills in context usage. Both are fire-and-forget: do
    // not fail session creation if unavailable, and a response landing after
    // the 5s ack timeout is still applied (handleResponse processes every
    // response regardless of pending state).
    setTimeout(() => {
      this.send({ type: 'get_state' }, { timeoutMs: 5000 }).catch(() => {});
      this.send({ type: 'get_session_stats' }, { timeoutMs: 5000 }).catch(() => {});
    }, 250);
  }

  send(command: RpcCommand, opts: { timeoutMs?: number } = {}) {
    const child = this.child;
    if (!child || !child.stdin!.writable || this.terminating) {
      return Promise.reject(new Error('Pi RPC session is not running'));
    }
    const id = command.id || `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const outbound = { ...command, id };
    delete outbound.sessionId;
    const timeoutMs = opts.timeoutMs ?? 60000;
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC command timed out: ${outbound.type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, command: outbound.type });
      try {
        child.stdin!.write(JSON.stringify(outbound) + '\n', (err: Error | null | undefined) => {
          if (err) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(err);
          }
        });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  /** Pi never acknowledges UI replies. Success means stdin delivery only. */
  private writeDialogResponse(command: RpcCommand) {
    const child = this.child;
    if (!child?.stdin?.writable || this.terminating) return Promise.reject(new Error('Pi RPC session is not running'));
    return new Promise<void>((resolve, reject) => {
      try {
        child.stdin!.write(JSON.stringify(command) + '\n', (err) => err ? reject(err) : resolve());
      } catch (error) { reject(error); }
    });
  }

  async respondToDialog(command: RpcCommand): Promise<RpcResponse> {
    const id = command.id;
    const pending = id ? this.pendingDialogs.get(id) : undefined;
    if (!id || !pending) throw new Error('No pending dialog with that ID in this session');
    if (command.sessionId && command.sessionId !== this.id) throw new Error('Dialog belongs to another session');
    if (pending.responding) throw new Error('Dialog response is already being delivered');
    if (pending.request.expiresAt && pending.request.expiresAt <= Date.now()) {
      this.removeDialog(id, 'timeout');
      throw new Error('Dialog has expired');
    }
    const outbound: RpcCommand = { type: 'extension_ui_response', id };
    if (command.cancelled === true || this.abortState !== 'idle') outbound.cancelled = true;
    else if (pending.request.method === 'confirm' && typeof command.confirmed === 'boolean') outbound.confirmed = command.confirmed;
    else if (pending.request.method !== 'confirm' && typeof command.value === 'string') {
      if (pending.request.method === 'select' && (!Array.isArray(pending.request.options) || !pending.request.options.includes(command.value))) throw new Error('Invalid dialog selection');
      outbound.value = command.value;
    } else throw new Error('Invalid dialog response');
    pending.responding = true; // Claim synchronously before yielding to another browser.
    try {
      await this.writeDialogResponse(outbound);
      if (this.pendingDialogs.get(id) === pending) this.removeDialog(id, outbound.cancelled === true ? 'cancelled' : 'answered');
      return { type: 'response', command: 'extension_ui_response', id, success: true, data: { delivered: true } };
    } catch (error) {
      pending.responding = false;
      this.diagnostic('delivery_failed', id);
      throw error;
    }
  }

  private cancelPendingDialogs() {
    for (const [id, pending] of this.pendingDialogs) {
      if (!pending.responding) {
        void this.respondToDialog({ type: 'extension_ui_response', id, cancelled: true }).catch(() => {
          // Retain a failed delivery for recovery/retry; never claim it resolved.
          this.diagnostic('cancellation_delivery_failed', id);
        });
      }
    }
  }

  private completeAbort(id: string | undefined) {
    if (!id || id !== this.abortCommandId) return;
    this.abortCommandId = null;
    this.abortState = 'idle';
    // A delayed acknowledgement belongs to the operation it stopped, not a
    // newer turn that may already have started after agent_settled.
    if (this.operationRevision === this.abortOperationRevision) this.isStreaming = false;
    this.diagnostic('abort_acknowledged');
    this.manager.broadcastUpdated(this.id);
  }

  abort(command: RpcCommand = {}, opts: { timeoutMs?: number } = {}): Promise<RpcResponse> {
    if (!this.abortPromise) {
      this.abortState = 'stopping';
      this.abortCommandId = command.id || makeId();
      this.abortOperationRevision = this.operationRevision;
      this.manager.broadcastUpdated(this.id);
      this.diagnostic('abort_sent');
      // send() writes synchronously. Never wait for its acknowledgement before
      // releasing hooks whose extensions forgot to pass the turn signal.
      const native = this.send({ type: 'abort', id: this.abortCommandId }, opts);
      this.cancelPendingDialogs();
      this.abortPromise = native.then(resp => {
        if (resp.success === true) this.completeAbort(this.abortCommandId ?? undefined);
        else {
          this.abortState = 'failed';
          this.diagnostic('abort_failed');
          this.manager.broadcastUpdated(this.id);
        }
        return resp;
      }, error => {
        this.abortState = /^RPC command timed out:/.test(String(error instanceof Error ? error.message : error)) ? 'timed_out' : 'failed';
        this.diagnostic(this.abortState === 'timed_out' ? 'abort_timed_out' : 'abort_failed');
        this.manager.broadcastUpdated(this.id);
        throw error;
      }).finally(() => { this.abortPromise = null; });
    }
    // Coalesced callers still receive their own command correlation ID.
    return this.abortPromise.then(resp => ({ ...resp, ...(command.id ? { id: command.id } : {}) }));
  }

  handleStdout(chunk: string) {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || '';
    for (const line of lines) this.handleLine(line);
  }

  handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { console.log(`[Pi ${this.id}] ${trimmed}`); return; }
    if (msg.type === 'response') {
      this.handleResponse(msg);
      return;
    }
    this.handleEvent(msg);
  }

  handleResponse(resp: PiRpcMessage) {
    const id = resp.id;
    if (id && this.pending.has(id)) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.resolve(resp);
      }
    }
    if (resp.command === 'abort' && resp.success === true) this.completeAbort(resp.id);
    this.updateStateFromResponse(resp);
    this.manager.broadcast({ type: 'event', sessionId: this.id, event: resp });
  }

  updateStateFromResponse(resp: PiRpcMessage) {
    const data: PiRpcPayload = resp.data || resp.result || resp;
    const command = resp.command || data.command;
    if (data.sessionFile) this.sessionFile = data.sessionFile;
    if (data.sessionName) this.setSessionName(data.sessionName);
    if (data.contextUsage) this.contextUsage = data.contextUsage;
    if (data.model) this.model = normalizeModel(data.model);
    if (data.thinkingLevel) this.thinkingLevel = data.thinkingLevel;
    if (data.level) this.thinkingLevel = data.level;
    if (data.tokens) this.contextUsage = { ...(this.contextUsage || {}), tokens: data.tokens };
    if (command === 'set_model' || command === 'cycle_model') {
      if (data.model) this.model = normalizeModel(data.model);
      else if (data.provider && data.id) this.model = normalizeModel(data);
    }
    this.touch(true);
  }

  handleEvent(event: PiRpcMessage) {
    this.touch(false);
    const type = event.type;
    if (type === 'extension_ui_request' && ['confirm', 'select', 'input', 'editor'].includes(String(event.method))) {
      this.retainDialog(event);
      return;
    }
    // Only agent_settled confirms completion after retries/compaction and
    // queued continuations; neither turn_end nor agent_end establishes idle.
    if (type === 'agent_settled') {
      this.clearDialogs('operation_completed', true);
      if (!this.abortPromise) this.abortState = 'idle';
      this.isStreaming = false;
    }
    if (type === 'agent_start') this.operationRevision++;
    if (type === 'agent_start' || type === 'turn_start') this.isStreaming = true;
    // Extension command handlers report their errors as extension_error
    // events while the triggering prompt still acks with success. Keep the
    // last one so navigate_tree can explain WHY a leaf verification failed
    // (stdout is ordered, so the event lands before the prompt's response).
    // Only tau's own command qualifies — pi tags command errors with
    // extensionPath `command:<name>` — so a failure is never blamed on an
    // unrelated extension that happened to error in the same window.
    if (type === 'extension_error' && event.error && event.extensionPath === `command:${NAVIGATE_COMMAND}`) {
      this.lastExtensionError = String(event.error);
    }
    if (event.contextUsage) this.contextUsage = event.contextUsage;
    if (event.sessionFile) this.sessionFile = event.sessionFile;
    if (type === 'session_name' && event.name) {
      if (!this.setSessionName(event.name)) return;
      event.name = this.sessionName || event.name;
    }

    if ((type === 'message_start' || type === 'message_end') && event.message) {
      this.trackMessage(event.message, type);
    }
    // NOTE: the assistant `message_end` event carries `event.message.model` as
    // a bare id describing WHICH model produced that message, not a selection
    // change. Overwriting `this.model` with it downgraded the canonical
    // {provider,id} object to a bare string and propagated to all clients via
    // broadcastUpdated. Do NOT touch model identity here — only record usage.
    if (type === 'message_end' && event.message?.role === 'assistant') {
      if (event.message.usage) this.contextUsage = { ...(this.contextUsage || {}), usage: event.message.usage };
    }

    this.manager.broadcast({ type: 'event', sessionId: this.id, event });
    this.manager.broadcastUpdated(this.id);
  }

  trackMessage(message: PiMessage, eventType: string) {
    if (message.role === 'user' && eventType === 'message_start') {
      const text = this.messageText(message);
      if (text) this.userMessages.push(text.slice(0, 300));
      this.entries.push({ type: 'message', message });
      this.maybeTitle();
    } else if (message.role !== 'user' && eventType === 'message_end') {
      this.entries.push({ type: 'message', message });
    }
  }

  messageText(message: PiMessage) {
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return '';
  }

  setSessionName(name: unknown) {
    const trimmed = String(name || '').trim();
    if (!trimmed || isGenericSessionName(trimmed)) return false;
    this.sessionName = trimmed;
    return true;
  }

  maybeTitle() {
    if (this.titleSet || (this.sessionName && !isGenericSessionName(this.sessionName)) || this.userMessages.length < 1) return;
    const msg = this.userMessages.find((m) => m.trim().length > 8) || this.userMessages[0];
    if (!msg) return;
    let title = msg.replace(/^(ok |okay |so |actually |hey |please |can you |could you |i want(ed)? to |i wanna |let'?s )/i, '').replace(/\n.*/s, '').trim();
    const sentenceEnd = title.search(/[.!?]\s/);
    if (sentenceEnd > 10 && sentenceEnd < 80) title = title.slice(0, sentenceEnd);
    if (title.length > 60) title = title.slice(0, 57).replace(/\s+\S*$/, '') + '…';
    title = title.charAt(0).toUpperCase() + title.slice(1);
    this.sessionName = title || null;
    this.titleSet = true;
    this.manager.broadcast({ type: 'event', sessionId: this.id, event: { type: 'session_name', name: this.sessionName } });
  }

  touch(broadcast: boolean) {
    this.lastActiveAt = new Date().toISOString();
    if (broadcast) this.manager.broadcastUpdated(this.id);
  }

  async terminate(reason = 'closed') {
    if (this.terminating) return;
    this.terminating = true;
    this.clearDialogs('terminated');
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Session terminated: ${reason}`));
    }
    this.pending.clear();
    if (!this.child || this.child.exitCode !== null) return;
    try { this.child.kill('SIGTERM'); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      try { this.child.kill('SIGKILL'); } catch {}
    }
  }

  handleExit(code: number | null, signal: string | null, err?: { message?: string }) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.clearDialogs('process_exit');
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err || new Error(`Pi process exited (${signal || code})`));
    }
    this.pending.clear();
    this.manager.removeExited(this.id, err?.message || `process_exit:${signal || code}`);
  }
}

export class LiveSessionManager {
  sessions: Map<string, PiRpcSession>;
  clients: Set<LiveClient>;
  pendingResumes: Map<string, Promise<PiRpcSession>>;
  terminatingResumes: Map<string, Promise<void>>;

  constructor() {
    this.sessions = new Map();
    this.clients = new Set();
    this.pendingResumes = new Map();
    this.terminatingResumes = new Map();
  }
  addClient(ws: LiveClient) { this.clients.add(ws); }
  removeClient(ws: LiveClient) { this.clients.delete(ws); }
  broadcast(data: unknown) {
    const payload = JSON.stringify(data);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }
  broadcastUpdated(id: string) {
    const s = this.sessions.get(id);
    if (s) this.broadcast({ type: 'live_session_updated', session: s.metadata() });
  }
  list() { return Array.from(this.sessions.values()).map((s) => s.metadata()); }
  get(id: string) { return this.sessions.get(id); }
  findBySessionFile(sessionFile: string) {
    const resolved = path.resolve(sessionFile);
    return Array.from(this.sessions.values()).find((s) => s.sessionFile && path.resolve(s.sessionFile) === resolved);
  }
  hasPendingResume(sessionFile: string) { return this.pendingResumes.has(path.resolve(sessionFile)); }
  hasTerminatingResume(sessionFile: string) { return this.terminatingResumes.has(path.resolve(sessionFile)); }
  async create({ cwd, model }: { cwd?: string; model?: string }) {
    const resolved = path.resolve(expandHome(cwd || process.cwd()));
    const session = new PiRpcSession(this, { cwd: resolved, modelSpec: (model || '').trim() });
    await session.start();
    this.sessions.set(session.id, session);
    this.broadcast({ type: 'live_session_created', session: session.metadata() });
    return session;
  }
  async resume({ sessionFile, cwd, model, entries, sessionName }: { sessionFile: string; cwd: string; model?: string; entries?: JsonRecord[]; sessionName?: string | null }) {
    const resolved = path.resolve(sessionFile);
    const existing = this.findBySessionFile(resolved);
    if (existing) return existing;
    const pending = this.pendingResumes.get(resolved);
    if (pending) return pending;
    const resumePromise = (async () => {
      try {
        const terminating = this.terminatingResumes.get(resolved);
        if (terminating) await terminating.catch(() => {});
        const afterTerminationExisting = this.findBySessionFile(resolved);
        if (afterTerminationExisting) return afterTerminationExisting;
        const session = new PiRpcSession(this, { cwd, modelSpec: (model || '').trim(), sessionFile: resolved, entries, sessionName });
        await session.start();
        this.sessions.set(session.id, session);
        this.broadcast({ type: 'live_session_created', session: session.metadata() });
        return session;
      } finally {
        this.pendingResumes.delete(resolved);
      }
    })();
    this.pendingResumes.set(resolved, resumePromise);
    return resumePromise;
  }
  async delete(id: string, reason = 'closed_by_user') {
    const session = this.sessions.get(id);
    if (!session) return false;
    const resolvedFile = session.sessionFile ? path.resolve(session.sessionFile) : null;
    const termination = session.terminate(reason).then(() => undefined, () => undefined).finally(() => {
      if (resolvedFile && this.terminatingResumes.get(resolvedFile) === termination) this.terminatingResumes.delete(resolvedFile);
    });
    if (resolvedFile) this.terminatingResumes.set(resolvedFile, termination);
    this.sessions.delete(id);
    this.broadcast({ type: 'live_session_closed', sessionId: id, reason });
    await termination;
    return true;
  }
  removeExited(id: string, reason: string) {
    if (!this.sessions.has(id)) return;
    this.sessions.delete(id);
    this.broadcast({ type: 'live_session_closed', sessionId: id, reason });
  }
  async shutdown() {
    const sessions = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.allSettled(sessions.map((s) => s.terminate('server_shutdown')));
  }
}


export const liveManager = new LiveSessionManager();
let _spawnPiForTest: SpawnFn | null = null;
export function _setSpawnPiForTest(fn: SpawnFn | null | undefined) { _spawnPiForTest = fn || null; }
