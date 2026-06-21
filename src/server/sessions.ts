const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WebSocket } = require('ws');

import type { JsonRecord, LiveClient, ModelIdentity, PendingCommand, RpcCommand, RpcResponse } from './types.js';
import { expandHome } from './config.js';
import { modelLabel, normalizeModel, parseModelSpecToModel } from './model-utils.js';

export function makeId() {
  return `tau_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export class PiRpcSession {
  manager: LiveSessionManager;
  id: string;
  cwd: string;
  modelSpec: string;
  child: ReturnType<typeof spawn> | null;
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

  constructor(manager: LiveSessionManager, opts: { id?: string; cwd: string; modelSpec?: string }) {
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
    this.sessionFile = null;
    this.sessionName = null;
    this.contextUsage = null;
    this.pending = new Map();
    this.stdoutBuffer = '';
    this.terminating = false;
    this.exitCode = null;
    this.titleSet = false;
    this.userMessages = [];
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
    };
  }

  snapshot() {
    return {
      session: this.metadata(),
      entries: this.entries,
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      isStreaming: this.isStreaming,
      sessionFile: this.sessionFile,
      sessionName: this.sessionName,
      contextUsage: this.contextUsage,
    };
  }

  async start() {
    if (!fs.existsSync(this.cwd) || !fs.statSync(this.cwd).isDirectory()) {
      throw new Error(`Directory not found: ${this.cwd}`);
    }
    const args = ['--mode', 'rpc'];
    if (this.modelSpec) args.push('--model', this.modelSpec);
    const spawnFn = _spawnPiForTest || spawn;
    this.child = spawnFn('pi', args, {
      cwd: this.cwd,
      env: { ...process.env, TAU_DISABLED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pid = this.child.pid || null;

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.handleStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) console.error(`[Pi ${this.id}] ${line}`);
    });
    this.child.on('error', (err) => this.handleExit(null, null, err));
    this.child.on('exit', (code, signal) => this.handleExit(code, signal));

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.child.off('error', onError);
        this.child.off('exit', onExit);
      };
      const onError = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const onExit = (code, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Pi RPC process exited during startup (${signal || code})`));
      };
      this.child.once('error', onError);
      this.child.once('exit', onExit);
      setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      }, 100);
    });

    // Give Pi a moment to enter RPC mode, then ask for stats. Do not fail session
    // creation if this convenience command is unavailable.
    setTimeout(() => {
      this.send({ type: 'get_session_stats' }, { timeoutMs: 5000 }).catch(() => {});
    }, 250);
  }

  send(command: RpcCommand, opts: { timeoutMs?: number } = {}) {
    if (!this.child || !this.child.stdin.writable || this.terminating) {
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
        this.child.stdin.write(JSON.stringify(outbound) + '\n', (err) => {
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

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || '';
    for (const line of lines) this.handleLine(line);
  }

  handleLine(line) {
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

  handleResponse(resp) {
    const id = resp.id;
    if (id && this.pending.has(id)) {
      const pending = this.pending.get(id);
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.resolve(resp);
    }
    this.updateStateFromResponse(resp);
    this.manager.broadcast({ type: 'event', sessionId: this.id, event: resp });
  }

  updateStateFromResponse(resp) {
    const data = resp.data || resp.result || resp;
    const command = resp.command || data.command;
    if (data.sessionFile) this.sessionFile = data.sessionFile;
    if (data.sessionName) this.sessionName = data.sessionName;
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

  handleEvent(event) {
    this.touch(false);
    const type = event.type;
    if (type === 'agent_start' || type === 'turn_start') this.isStreaming = true;
    if (type === 'agent_end' || type === 'turn_end') this.isStreaming = false;
    if (event.contextUsage) this.contextUsage = event.contextUsage;
    if (event.sessionFile) this.sessionFile = event.sessionFile;
    if (type === 'session_name' && event.name) this.sessionName = event.name;

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

  trackMessage(message, eventType) {
    if (message.role === 'user' && eventType === 'message_start') {
      const text = this.messageText(message);
      if (text) this.userMessages.push(text.slice(0, 300));
      this.entries.push({ type: 'message', message });
      this.maybeTitle();
    } else if (message.role !== 'user' && eventType === 'message_end') {
      this.entries.push({ type: 'message', message });
    }
  }

  messageText(message) {
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return '';
  }

  maybeTitle() {
    if (this.titleSet || this.sessionName || this.userMessages.length < 1) return;
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

  touch(broadcast) {
    this.lastActiveAt = new Date().toISOString();
    if (broadcast) this.manager.broadcastUpdated(this.id);
  }

  async terminate(reason = 'closed') {
    if (this.terminating) return;
    this.terminating = true;
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

  constructor() {
    this.sessions = new Map();
    this.clients = new Set();
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
  async create({ cwd, model }: { cwd?: string; model?: string }) {
    const resolved = path.resolve(expandHome(cwd || process.cwd()));
    const session = new PiRpcSession(this, { cwd: resolved, modelSpec: (model || '').trim() });
    await session.start();
    this.sessions.set(session.id, session);
    this.broadcast({ type: 'live_session_created', session: session.metadata() });
    return session;
  }
  async delete(id: string, reason = 'closed_by_user') {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    this.broadcast({ type: 'live_session_closed', sessionId: id, reason });
    await session.terminate(reason);
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
let _spawnPiForTest = null;
export function _setSpawnPiForTest(fn) { _spawnPiForTest = fn || null; }
