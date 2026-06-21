#!/usr/bin/env node
/*
 * Tau standalone server.
 *
 * Serves the Tau web UI and manages backend-owned `pi --mode rpc` child
 * sessions. Browser connections are views only; explicit live-session DELETE or
 * server shutdown terminates child Pi processes.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const readline = require('node:readline');
const { WebSocketServer, WebSocket } = require('ws');
const QRCode = require('qrcode');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'open') { out.open = true; continue; }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; }
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));
const USER_HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(USER_HOME, '.pi', 'agent');
const SESSIONS_DIR = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(PI_AGENT_DIR, 'sessions');

function expandHome(p) {
  if (!p || typeof p !== 'string') return p;
  return p.startsWith('~') ? path.join(USER_HOME, p.slice(1)) : p;
}

function loadTauSettings() {
  let settings = {};
  try {
    const settingsPath = path.join(PI_AGENT_DIR, 'settings.json');
    settings = (JSON.parse(fs.readFileSync(settingsPath, 'utf8')).tau || {});
  } catch {}
  return {
    port: parseInt(ARGS.port || process.env.TAU_MIRROR_PORT || process.env.TAU_PORT || settings.port || '3001', 10),
    host: ARGS.host || process.env.TAU_HOST || settings.host || '0.0.0.0',
    user: process.env.TAU_USER || settings.user || '',
    pass: process.env.TAU_PASS || settings.pass || '',
    authEnabled: settings.authEnabled,
    projectsDir: expandHome(ARGS['projects-dir'] || process.env.TAU_PROJECTS_DIR || settings.projectsDir || ''),
  };
}

const TAU_SETTINGS = loadTauSettings();
let authEnabled = !!(TAU_SETTINGS.user && TAU_SETTINGS.pass) && TAU_SETTINGS.authEnabled !== false;
const AUTH_CONFIGURED = !!(TAU_SETTINGS.user && TAU_SETTINGS.pass);
const PORT = TAU_SETTINGS.port;
const HOST = TAU_SETTINGS.host;
const STATIC_DIR = process.env.TAU_STATIC_DIR || findPublicDir();

function findPublicDir() {
  const candidates = [];
  const add = (p) => candidates.push(path.resolve(p));
  add(path.join(__dirname, '..', 'public'));
  add(path.join(process.cwd(), 'public'));
  try {
    const pkgPath = require.resolve('tau-mirror/package.json');
    add(path.join(path.dirname(pkgPath), 'public'));
  } catch {}
  add(path.join(process.cwd(), 'node_modules', 'tau-mirror', 'public'));
  return candidates.find((c) => fs.existsSync(path.join(c, 'index.html'))) || candidates[0];
}

const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function saveTauSetting(key, value) {
  const settingsPath = path.join(PI_AGENT_DIR, 'settings.json');
  try {
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
    if (!settings.tau) settings.tau = {};
    settings.tau[key] = value;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch {}
}

function checkBasicAuth(req) {
  if (!authEnabled) return true;
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  const colon = decoded.indexOf(':');
  if (colon === -1) return false;
  return decoded.slice(0, colon) === TAU_SETTINGS.user && decoded.slice(colon + 1) === TAU_SETTINGS.pass;
}

function sendAuthRequired(res) {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Tau"', 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
}

function json(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
      if (body.length > 20 * 1024 * 1024) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function modelLabel(model, fallback = '') {
  if (!model) return fallback || '';
  if (typeof model === 'string') return model;
  if (model.provider && model.id) return `${model.provider}/${model.id}`;
  return model.id || model.name || fallback || '';
}

// Normalize any model value into the canonical form: null or a full
// {provider, id, ...} object. Bare `provider/id` strings (and "id" strings
// with no slash) are parsed into objects; anything unrecognizable becomes null.
function normalizeModel(value) {
  if (!value) return null;
  if (typeof value === 'object') {
    if (value.provider && value.id) return { ...value };
    if (value.id) return { ...value, provider: value.provider || '' };
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const slashIdx = trimmed.indexOf('/');
    if (slashIdx === -1) return { provider: '', id: trimmed };
    const provider = trimmed.slice(0, slashIdx);
    const id = trimmed.slice(slashIdx + 1);
    if (!id) return null;
    return { provider, id };
  }
  return null;
}

// Parse a `provider/id[:level]` spec string (as passed on session creation or
// the model-input box) into a canonical {provider, id} object plus an optional
// thinking level. Returns {model, level} where `model` is null when unparseable.
function parseModelSpecToModel(spec) {
  const trimmed = String(spec || '').trim();
  if (!trimmed) return { model: null, level: null };
  let level = null;
  const colonIdx = trimmed.lastIndexOf(':');
  if (colonIdx !== -1) {
    const candidate = trimmed.slice(colonIdx + 1).toLowerCase();
    if (['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(candidate)) {
      level = candidate;
    }
  }
  const core = (colonIdx !== -1 && level) ? trimmed.slice(0, colonIdx) : trimmed;
  return { model: normalizeModel(core), level };
}

function makeId() {
  return `tau_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

class PiRpcSession {
  constructor(manager, opts) {
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

    await new Promise((resolve, reject) => {
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

  send(command, opts = {}) {
    if (!this.child || !this.child.stdin.writable || this.terminating) {
      return Promise.reject(new Error('Pi RPC session is not running'));
    }
    const id = command.id || `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const outbound = { ...command, id };
    delete outbound.sessionId;
    const timeoutMs = opts.timeoutMs ?? 60000;
    return new Promise((resolve, reject) => {
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

  handleExit(code, signal, err) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err || new Error(`Pi process exited (${signal || code})`));
    }
    this.pending.clear();
    this.manager.removeExited(this.id, err ? err.message : `process_exit:${signal || code}`);
  }
}

class LiveSessionManager {
  constructor() {
    this.sessions = new Map();
    this.clients = new Set();
  }
  addClient(ws) { this.clients.add(ws); }
  removeClient(ws) { this.clients.delete(ws); }
  broadcast(data) {
    const payload = JSON.stringify(data);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }
  broadcastUpdated(id) {
    const s = this.sessions.get(id);
    if (s) this.broadcast({ type: 'live_session_updated', session: s.metadata() });
  }
  list() { return Array.from(this.sessions.values()).map((s) => s.metadata()); }
  get(id) { return this.sessions.get(id); }
  async create({ cwd, model }) {
    const resolved = path.resolve(expandHome(cwd || process.cwd()));
    const session = new PiRpcSession(this, { cwd: resolved, modelSpec: (model || '').trim() });
    await session.start();
    this.sessions.set(session.id, session);
    this.broadcast({ type: 'live_session_created', session: session.metadata() });
    return session;
  }
  async delete(id, reason = 'closed_by_user') {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    this.broadcast({ type: 'live_session_closed', sessionId: id, reason });
    await session.terminate(reason);
    return true;
  }
  removeExited(id, reason) {
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

const liveManager = new LiveSessionManager();
let mirrorUrl = '';
let tailscaleUrl = '';

function resolveSessionFile(filePath) {
  if (!filePath || typeof filePath !== 'string') throw new Error('filePath required');
  const resolved = path.resolve(filePath);
  const root = path.resolve(SESSIONS_DIR);
  if (!resolved.startsWith(root + path.sep) || !resolved.endsWith('.jsonl')) {
    throw new Error('Invalid session file');
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error('Session not found');
  return resolved;
}

function appendSessionName(filePath, name) {
  const resolved = resolveSessionFile(filePath);
  fs.appendFileSync(resolved, JSON.stringify({ type: 'session_info', name, timestamp: new Date().toISOString() }) + '\n');
  return resolved;
}

function updateLiveSessionName(session, name) {
  if (!session) return;
  session.sessionName = name;
  session.titleSet = true;
  liveManager.broadcast({ type: 'event', sessionId: session.id, event: { type: 'session_name', name } });
  liveManager.broadcastUpdated(session.id);
}

function isWithinPath(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveLiveSessionPath(session, requestedPath) {
  if (!session) {
    const err = new Error('Live session not found');
    err.status = 404;
    throw err;
  }
  const root = fs.realpathSync(path.resolve(session.cwd));
  const candidate = path.resolve(expandHome(requestedPath || session.cwd));
  let resolved = candidate;
  try { resolved = fs.realpathSync(candidate); } catch {}
  if (!isWithinPath(root, resolved)) {
    const err = new Error('Path is outside the active session directory');
    err.status = 403;
    throw err;
  }
  return resolved;
}

function openUrl(url) {
  if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error('Invalid URL'));
  if (process.platform === 'win32') {
    spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref();
    return Promise.resolve();
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  return new Promise((resolve, reject) => {
    execFile(opener, [url], (err) => err ? reject(err) : resolve());
  });
}

// Fire-and-forget: refresh session.model/thinkingLevel from pi's get_state.
// Used after prompt/steer/follow_up acks so extension-driven model/thinking
// changes (e.g. pi-session-model's /session-model) propagate to tau and all
// clients. Silently skips on failure — the next user input or snapshot resyncs.
async function refreshSessionModel(session) {
  if (!session || session.terminating) return;
  const resp = await session.send({ type: 'get_state' }, { timeoutMs: 5000 });
  const data = resp && (resp.data || resp.result || resp);
  if (!data) return;
  if (data.model !== undefined) session.model = normalizeModel(data.model);
  if (data.thinkingLevel) session.thinkingLevel = data.thinkingLevel;
  liveManager.broadcastUpdated(session.id);
}

async function handleRpcCommand(command) {
  const id = command.id;
  const cmd = command.type;
  const success = (data) => ({ type: 'response', command: cmd, success: true, id, ...(data !== undefined ? { data } : {}) });
  const error = (message) => ({ type: 'response', command: cmd, success: false, error: message, id });

  // Backend-local commands do not require a live Pi child.
  if (cmd === 'get_auth') return success({ configured: AUTH_CONFIGURED, enabled: authEnabled });
  if (cmd === 'set_auth') {
    if (!AUTH_CONFIGURED) return error('No credentials configured. Set tau.user and tau.pass in settings.json');
    const wasEnabled = authEnabled;
    authEnabled = !!command.enabled;
    saveTauSetting('authEnabled', authEnabled);
    liveManager.broadcast({ type: 'event', event: { type: 'auth_changed', enabled: authEnabled } });
    if (!wasEnabled && authEnabled) {
      const timer = setTimeout(() => {
        for (const client of Array.from(liveManager.clients)) {
          try { client.close(4001, 'Authentication enabled'); } catch {}
        }
      }, 25);
      timer.unref?.();
    }
    return success({ enabled: authEnabled });
  }
  if (cmd === 'get_available_models') return success({ models: [] });
  if (cmd === 'set_session_name') {
    const name = (command.name || '').trim();
    if (!name) return error('Name cannot be empty');
    const session = command.sessionId ? liveManager.get(command.sessionId) : null;
    let resolvedFile = null;
    const targetFile = command.filePath || session?.sessionFile;
    if (targetFile) {
      try { resolvedFile = appendSessionName(targetFile, name); } catch (e) { return error(e.message); }
    }
    const matchingLive = resolvedFile
      ? Array.from(liveManager.sessions.values()).find((s) => s.sessionFile && path.resolve(s.sessionFile) === resolvedFile)
      : null;
    if (session) updateLiveSessionName(session, name);
    else if (matchingLive) updateLiveSessionName(matchingLive, name);
    else if (!resolvedFile) return error('sessionId or filePath required');
    return success({ name });
  }

  const session = command.sessionId ? liveManager.get(command.sessionId) : null;
  if (cmd === 'export_html') {
    try {
      if (command.sessionId && !session) throw new Error('Live session not found');
      const sf = command.filePath ? resolveSessionFile(command.filePath) : session?.sessionFile;
      if (!sf) throw new Error('No session file to export yet');
      const args = ['--export', sf];
      if (command.outputPath) args.push(resolveExportOutputPath(command.outputPath, sf));
      const output = await new Promise((resolve, reject) => {
        execFile('pi', args, { cwd: session?.cwd || path.dirname(sf), timeout: 30000, encoding: 'utf8' }, (err, stdout, stderr) => {
          if (err) reject(new Error(stderr || err.message)); else resolve(stdout);
        });
      });
      let result = output.trim().split('\n').pop() || sf.replace(/\.jsonl$/, '.html');
      result = path.resolve(expandHome(result));
      if (!fs.existsSync(result)) result = sf.replace(/\.jsonl$/, '.html');
      return success({ path: result });
    } catch (e) { return error(e.message); }
  }

  if (!session) return error('No active Tau session. Create or select an in-page Tau tab first.');

  if (cmd === 'get_state') {
    return success({
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      sessionFile: session.sessionFile,
      sessionName: session.sessionName,
      autoCompactionEnabled: true,
    });
  }
  if (cmd === 'get_messages') return success({ entries: session.entries });
  if (cmd === 'mirror_sync_request') return { type: 'mirror_sync', sessionId: session.id, ...session.snapshot() };
  if (cmd === 'set_auto_compaction') return success({ enabled: !!command.enabled });

  const native = new Set(['prompt', 'steer', 'follow_up', 'abort', 'compact', 'set_model', 'cycle_model', 'set_thinking_level', 'cycle_thinking_level', 'get_session_stats', 'extension_ui_response']);
  if (!native.has(cmd)) return error(`Unknown command: ${cmd}`);

  // `set_thinking_level` is forwarded to pi but pi's response carries no
  // level/thinkingLevel field, so updateStateFromResponse would never update
  // session.thinkingLevel — yet touch(true)->broadcastUpdated would echo the
  // stale level to all clients (reverting a client's just-set optimistic
  // level). Record the level optimistically here and restore on pi failure.
  const isSetThinkingLevel = cmd === 'set_thinking_level';
  let prevThinkingLevel = null;
  if (isSetThinkingLevel) {
    prevThinkingLevel = session.thinkingLevel;
    if (command.level) session.thinkingLevel = command.level;
  }

  try {
    const resp = await session.send(command, { timeoutMs: cmd === 'prompt' ? 10000 : 60000 });
    if (isSetThinkingLevel && resp.success === false) {
      session.thinkingLevel = prevThinkingLevel;
    }
    // Extension-driven model/thinking changes (e.g. the pi-session-model
    // `/session-model` slash command) call pi.setModel/pi.setThinkingLevel
    // inside a prompt/steer/follow_up. Those acks carry no model data and emit
    // no runtime stream event, so tau would stay stale. Fire-and-forget a
    // get_state refresh so tau and all clients learn the new model/level. Do
    // NOT block this HTTP response — return the original ack first.
    if (resp.success !== false && (cmd === 'prompt' || cmd === 'steer' || cmd === 'follow_up')) {
      refreshSessionModel(session).catch(() => {});
    }
    return { ...resp, success: resp.success !== false };
  } catch (e) {
    if (isSetThinkingLevel) session.thinkingLevel = prevThinkingLevel;
    // Some commands are ack-less fire-and-forget in practice; keep UX moving
    // only when the write succeeded and the child simply did not acknowledge.
    const isAckTimeout = /^RPC command timed out:/.test(e.message || '');
    if (isAckTimeout && (cmd === 'prompt' || cmd === 'abort' || cmd === 'extension_ui_response')) return success();
    return error(e.message);
  }
}

function serveStaticFile(req, res) {
  let urlPath = req.url || '/';
  if (authEnabled && !urlPath.startsWith('/api/health') && !checkBasicAuth(req)) return sendAuthRequired(res);
  if (urlPath.startsWith('/api/')) return handleApiRoute(req, res, urlPath);
  urlPath = urlPath.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  const staticRoot = path.resolve(STATIC_DIR);
  const filePath = path.resolve(path.join(staticRoot, decodedPath));
  if (filePath !== staticRoot && !filePath.startsWith(staticRoot + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

function isAllowedApiOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function setCorsForAllowedOrigin(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!isAllowedApiOrigin(req)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return true;
}

function handleApiRoute(req, res, urlPath) {
  const originAllowed = setCorsForAllowedOrigin(req, res);
  if (req.method === 'OPTIONS') {
    if (!originAllowed) return json(res, 403, { error: 'Origin not allowed' });
    res.writeHead(200);
    res.end();
    return;
  }
  if (!originAllowed) return json(res, 403, { error: 'Origin not allowed' });

  const parsed = new URL(`http://localhost${req.url}`);
  const cleanPath = parsed.pathname;

  if (cleanPath === '/api/health') return json(res, 200, { status: 'ok', mode: 'standalone', liveSessionCount: liveManager.sessions.size, mirrorUrl, tailscaleUrl: tailscaleUrl || undefined, platform: process.platform });
  if (cleanPath === '/api/qr') return serveQr(res);
  if (cleanPath === '/api/live-sessions' && req.method === 'GET') return json(res, 200, { sessions: liveManager.list() });
  if (cleanPath === '/api/live-sessions' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      if (!body.cwd) return json(res, 400, { error: 'cwd required' });
      try {
        const session = await liveManager.create({ cwd: body.cwd, model: body.model || '' });
        json(res, 200, { session: session.metadata() });
      } catch (e) { json(res, 400, { error: e.message }); }
    }).catch((e) => json(res, 400, { error: e.message }));
    return;
  }
  const liveMatch = cleanPath.match(/^\/api\/live-sessions\/([^/]+)(?:\/snapshot)?$/);
  if (liveMatch) {
    let id;
    try {
      id = decodeURIComponent(liveMatch[1]);
    } catch {
      return json(res, 400, { error: 'Malformed live session id' });
    }
    const session = liveManager.get(id);
    if (!session) return json(res, 404, { error: 'Live session not found' });
    const isSnapshotRoute = cleanPath.endsWith('/snapshot');
    if (isSnapshotRoute && req.method === 'GET') return json(res, 200, session.snapshot());
    if (!isSnapshotRoute && req.method === 'DELETE') { liveManager.delete(id, 'closed_by_user').then(() => json(res, 200, { success: true })); return; }
  }

  if (cleanPath === '/api/projects' && req.method === 'GET') return serveProjectsList(res);
  if (cleanPath === '/api/sessions' && req.method === 'GET') return serveSessionsList(res);
  if (cleanPath.startsWith('/api/search') && req.method === 'GET') return serveSearch(res, parsed.searchParams.get('q') || '');
  if ((cleanPath === '/api/files') && req.method === 'GET') {
    const explicitPath = parsed.searchParams.get('path');
    const sessionId = parsed.searchParams.get('sessionId');
    if (!sessionId) return json(res, 400, { error: 'No live session selected' });
    const session = liveManager.get(sessionId);
    if (!session) return json(res, 404, { error: 'Live session not found' });
    try {
      const dirPath = resolveLiveSessionPath(session, explicitPath || session.cwd);
      return serveFileList(res, dirPath);
    } catch (e) { return json(res, e.status || 400, { error: e.message }); }
  }
  if (cleanPath === '/api/file/preview' && req.method === 'GET') {
    const sessionId = parsed.searchParams.get('sessionId');
    if (!sessionId) return json(res, 400, { error: 'No live session selected' });
    const session = liveManager.get(sessionId);
    if (!session) return json(res, 404, { error: 'Live session not found' });
    try {
      const filePath = resolveLiveSessionPath(session, parsed.searchParams.get('path'));
      return serveFilePreview(res, filePath);
    } catch (e) { return json(res, e.status || 400, { error: e.message }); }
  }
  if (cleanPath === '/api/open' && req.method === 'POST') {
    readBody(req).then((body) => {
      try {
        const filePath = resolveOpenPath(body);
        return openNative(filePath)
          .then(() => json(res, 200, { ok: true }))
          .catch((e) => json(res, 500, { error: e.message }));
      } catch (e) {
        return json(res, e.status || 400, { error: e.message });
      }
    }).catch((e) => json(res, 400, { error: e.message }));
    return;
  }
  if (cleanPath === '/api/rpc' && req.method === 'POST') {
    readBody(req).then((body) => handleRpcCommand(body).then((resp) => json(res, 200, resp))).catch((e) => json(res, 400, { error: e.message }));
    return;
  }
  if (cleanPath === '/api/sessions/switch' && req.method === 'POST') return json(res, 200, { success: true, standalone: true, note: 'Historical sessions are read-only in standalone Tau' });
  if (cleanPath === '/api/sessions/delete' && req.method === 'POST') {
    readBody(req).then((body) => {
      if (!body.filePath || typeof body.filePath !== 'string') return json(res, 400, { error: 'filePath required' });
      const sessionFile = resolveSessionFile(body.filePath);
      fs.unlinkSync(sessionFile);
      json(res, 200, { success: true });
    }).catch((e) => json(res, 400, { error: e.message }));
    return;
  }
  const sessionMatch = cleanPath.match(/^\/api\/sessions\/([^/]+)\/([^/]+)$/);
  if (sessionMatch && req.method === 'GET') return serveSessionFile(res, sessionMatch[1], sessionMatch[2]);

  json(res, 404, { error: 'Not found' });
}

function serveQr(res) {
  if (!mirrorUrl) return json(res, 503, { error: 'Server not ready' });
  Promise.all([QRCode.toDataURL(mirrorUrl, { width: 256, margin: 2 }), tailscaleUrl ? QRCode.toDataURL(tailscaleUrl, { width: 256, margin: 2 }) : null])
    .then(([lan, ts]) => {
      const tsSection = tailscaleUrl && ts ? `<p style="margin-top:24px;color:rgba(255,255,255,0.3);font-size:11px">TAILSCALE</p><img src="${ts}" width="256" height="256" alt="Tailscale QR"><a href="${tailscaleUrl}">${tailscaleUrl}</a>` : '';
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width"><title>Tau — Connect</title><style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#131316;color:#fff;font-family:-apple-system,sans-serif}img{border-radius:12px}a{color:#b87a5c;font-size:18px;margin-top:16px}p{color:rgba(255,255,255,0.5);font-size:13px;margin-top:8px}</style></head><body><p style="color:rgba(255,255,255,0.3);font-size:11px">LAN</p><img src="${lan}" width="256" height="256" alt="QR Code"><a href="${mirrorUrl}">${mirrorUrl}</a>${tsSection}<p style="margin-top:16px">Scan to open Tau on your phone</p></body></html>`);
    }).catch((e) => json(res, 500, { error: e.message }));
}

function liveFilesSet() {
  return new Set(liveManager.list().map((s) => s.sessionFile).filter(Boolean));
}

function serveProjectsList(res) {
  const projectsDir = TAU_SETTINGS.projectsDir;
  if (!projectsDir || !fs.existsSync(projectsDir)) return json(res, 200, { projects: [], ...(projectsDir ? { error: 'Directory not found' } : {}) });
  try {
    const sessionInfo = new Map();
    if (fs.existsSync(SESSIONS_DIR)) {
      for (const dir of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const decodedPath = dir.name.replace(/^--/, '/').replace(/--$/, '').replace(/-/g, '/');
        if (!decodedPath.startsWith(projectsDir)) continue;
        const files = fs.readdirSync(path.join(SESSIONS_DIR, dir.name)).filter((f) => f.endsWith('.jsonl'));
        let lastActive = 0;
        for (const f of files) { try { lastActive = Math.max(lastActive, fs.statSync(path.join(SESSIONS_DIR, dir.name, f)).mtimeMs); } catch {} }
        sessionInfo.set(decodedPath, { count: files.length, lastActive });
      }
    }
    const liveCwds = new Set(liveManager.list().map((s) => s.cwd));
    const projects = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => {
        const fullPath = path.join(projectsDir, e.name);
        const info = sessionInfo.get(fullPath) || { count: 0, lastActive: 0 };
        return { name: e.name, path: fullPath, sessionCount: info.count, lastActive: info.lastActive || null, active: liveCwds.has(fullPath) };
      });
    json(res, 200, { projects });
  } catch (e) { json(res, 500, { error: e.message }); }
}

async function serveSessionsList(res) {
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return json(res, 200, { projects: [] });
    const projects = [];
    const liveFiles = liveFilesSet();
    for (const dir of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const projectDir = path.join(SESSIONS_DIR, dir.name);
      const decodedPath = dir.name.replace(/^--/, '/').replace(/--$/, '').replace(/-/g, '/');
      const sessions = [];
      for (const file of fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'))) {
        try {
          const filePath = path.join(projectDir, file);
          const parsed = await parseSessionFile(filePath);
          if (parsed) sessions.push({ ...parsed, file, filePath, mtime: fs.statSync(filePath).mtimeMs, live: liveFiles.has(filePath) });
        } catch {}
      }
      sessions.sort((a, b) => b.mtime - a.mtime);
      if (sessions.length) projects.push({ path: decodedPath, dirName: dir.name, sessions });
    }
    projects.sort((a, b) => (b.sessions[0]?.mtime || 0) - (a.sessions[0]?.mtime || 0));
    json(res, 200, { projects });
  } catch (e) { json(res, 500, { error: e.message }); }
}

async function parseSessionFile(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let header = null, firstMessage = null, sessionName = null, userMessageCount = 0, lineCount = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    lineCount++;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'session') header = entry;
      else if (entry.type === 'session_info' && entry.name) sessionName = entry.name;
      else if (entry.type === 'message' && entry.message?.role === 'user') {
        userMessageCount++;
        if (!firstMessage) {
          const c = entry.message.content;
          firstMessage = typeof c === 'string' ? c.slice(0, 120) : (Array.isArray(c) ? (c.find((b) => b.type === 'text')?.text || '').slice(0, 120) : null);
        }
      }
    } catch {}
  }
  rl.close(); stream.destroy();
  if (!header?.id || (userMessageCount <= 1 && lineCount <= 8)) return null;
  return { id: header.id, timestamp: header.timestamp || '', name: sessionName, firstMessage, cwd: header.cwd || null };
}

function serveSessionFile(res, dirName, file) {
  const filePath = path.join(SESSIONS_DIR, dirName, file);
  if (!fs.existsSync(filePath)) return json(res, 404, { error: 'Session not found' });
  const entries = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n'); buffer = lines.pop() || '';
    for (const line of lines) if (line.trim()) { try { entries.push(JSON.parse(line)); } catch {} }
  });
  stream.on('end', () => { if (buffer.trim()) { try { entries.push(JSON.parse(buffer)); } catch {} } json(res, 200, { entries }); });
  stream.on('error', (e) => json(res, 500, { error: e.message }));
}

const IGNORED_NAMES = new Set(['node_modules', '.git', '__pycache__', '.DS_Store', '.Trash', '.next', '.nuxt', 'dist', 'build', '.cache', '.turbo', 'venv', '.venv', 'env', '.env.local', '.pi', 'coverage', '.nyc_output', '.parcel-cache']);
function serveFileList(res, dirPath) {
  try {
    dirPath = path.resolve(expandHome(dirPath));
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return json(res, 400, { error: 'Not a directory' });
    const items = [];
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.env') continue;
      if (IGNORED_NAMES.has(entry.name)) continue;
      try {
        const fullPath = path.join(dirPath, entry.name);
        const stat = fs.statSync(fullPath);
        items.push({ name: entry.name, path: fullPath, isDirectory: entry.isDirectory(), size: entry.isDirectory() ? null : stat.size, mtime: stat.mtimeMs });
      } catch {}
    }
    items.sort((a, b) => a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name));
    json(res, 200, { path: dirPath, items });
  } catch (e) { json(res, 500, { error: e.message }); }
}

function serveFilePreview(res, filePath) {
  if (!filePath) return json(res, 400, { error: 'path required' });
  const mimes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon' };
  const mime = mimes[path.extname(filePath).toLowerCase().slice(1)];
  if (!mime) return json(res, 415, { error: 'Not a previewable image' });
  try {
    if (!fs.statSync(filePath).isFile()) throw new Error('Not a file');
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'max-age=60' });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) { json(res, 404, { error: e.message }); }
}

function resolveExportedSessionPath(filePath) {
  const resolved = path.resolve(expandHome(filePath || ''));
  const root = path.resolve(SESSIONS_DIR);
  if (!resolved.startsWith(root + path.sep) || path.extname(resolved).toLowerCase() !== '.html') {
    const err = new Error('Can only open exported session HTML without a live session');
    err.status = 403;
    throw err;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    const err = new Error('File not found');
    err.status = 404;
    throw err;
  }
  return resolved;
}

function resolveExportOutputPath(outputPath, sessionFile) {
  if (!outputPath || typeof outputPath !== 'string') throw new Error('outputPath required');
  const sessionDir = path.dirname(path.resolve(sessionFile));
  const sessionDirReal = fs.realpathSync(sessionDir);
  const expanded = expandHome(outputPath);
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(sessionDir, expanded);
  if (!isWithinPath(sessionDir, resolved) || path.extname(resolved).toLowerCase() !== '.html') {
    const err = new Error('Export outputPath must be an .html file in the session directory');
    err.status = 403;
    throw err;
  }
  const parentDir = path.dirname(resolved);
  let parentReal;
  try { parentReal = fs.realpathSync(parentDir); } catch {
    const err = new Error('Export output directory not found');
    err.status = 404;
    throw err;
  }
  if (!isWithinPath(sessionDirReal, parentReal) || (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink())) {
    const err = new Error('Export outputPath must stay inside the session directory');
    err.status = 403;
    throw err;
  }
  return resolved;
}

function resolveOpenPath(body) {
  if (!body?.filePath || typeof body.filePath !== 'string') throw new Error('filePath required');
  if (body.sessionId) {
    const session = liveManager.get(body.sessionId);
    const resolved = resolveLiveSessionPath(session, body.filePath);
    if (!fs.existsSync(resolved)) {
      const err = new Error('File not found');
      err.status = 404;
      throw err;
    }
    return resolved;
  }
  return resolveExportedSessionPath(body.filePath);
}

async function openNative(fp) {
  if (!fp || typeof fp !== 'string') throw new Error('filePath required');
  const resolved = path.resolve(expandHome(fp));
  if (!fs.existsSync(resolved)) throw new Error('File not found');
  if (process.platform === 'win32') {
    spawn('explorer.exe', [resolved], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    execFile('open', [resolved], () => {});
  } else {
    execFile('xdg-open', [resolved], () => {});
  }
}

async function serveSearch(res, query) {
  try {
    if (!query || query.length < 2 || !fs.existsSync(SESSIONS_DIR)) return json(res, 200, { results: [] });
    const q = query.toLowerCase();
    const results = [];
    for (const dir of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
      if (!dir.isDirectory() || results.length >= 30) continue;
      const projectDir = path.join(SESSIONS_DIR, dir.name);
      const decodedPath = dir.name.replace(/^--/, '/').replace(/--$/, '').replace(/-/g, '/');
      for (const file of fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'))) {
        if (results.length >= 30) break;
        const filePath = path.join(projectDir, file);
        const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        let sessionId = '', sessionName = '', sessionTimestamp = '', firstMessage = '';
        const matches = [];
        for await (const line of rl) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'session') { sessionId = entry.id; sessionTimestamp = entry.timestamp || ''; }
            if (entry.type === 'session_info' && entry.name) sessionName = entry.name;
            if (entry.type === 'message') {
              const c = entry.message?.content;
              const text = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '');
              if (!firstMessage && entry.message?.role === 'user' && text) firstMessage = text.slice(0, 120);
              const idx = text.toLowerCase().indexOf(q);
              if (idx >= 0) {
                matches.push({ role: entry.message?.role || 'unknown', snippet: `${idx > 0 ? '…' : ''}${text.slice(Math.max(0, idx - 60), Math.min(text.length, idx + q.length + 60)).replace(/\n/g, ' ')}${idx + q.length + 60 < text.length ? '…' : ''}` });
                if (matches.length >= 3) break;
              }
            }
          } catch {}
        }
        rl.close(); stream.destroy();
        if (matches.length) results.push({ filePath, project: decodedPath, sessionId, sessionName, sessionTimestamp, firstMessage, matches });
      }
    }
    json(res, 200, { results });
  } catch (e) { json(res, 500, { error: e.message }); }
}

function computeUrls(port) {
  const isLoopback = HOST === '127.0.0.1' || HOST === '::1' || HOST === 'localhost';
  let localIp = 'localhost';
  let tailscaleIp = '';
  if (!isLoopback) {
    const nets = os.networkInterfaces();
    for (const name of ['en0', 'en1', 'wlan0', 'eth0']) {
      for (const net of nets[name] || []) if (net.family === 'IPv4' && !net.internal) { localIp = net.address; break; }
      if (localIp !== 'localhost') break;
    }
    if (localIp === 'localhost') {
      outer: for (const name of Object.keys(nets)) {
        if (/^(bridge|utun|lo)/.test(name)) continue;
        for (const net of nets[name] || []) if (net.family === 'IPv4' && !net.internal) { localIp = net.address; break outer; }
      }
    }
    for (const name of Object.keys(nets)) for (const net of nets[name] || []) if (net.family === 'IPv4' && !net.internal && net.address.startsWith('100.')) tailscaleIp = net.address;
  }
  mirrorUrl = `http://${localIp}:${port}`;
  tailscaleUrl = tailscaleIp ? `http://${tailscaleIp}:${port}` : '';
}

const server = http.createServer(serveStaticFile);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  if (!isAllowedApiOrigin(request)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  if (authEnabled && !checkBasicAuth(request)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Tau"\r\n\r\n');
    socket.destroy();
    return;
  }
  if (request.url === '/ws') wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  else socket.destroy();
});

wss.on('connection', (ws) => {
  liveManager.addClient(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ type: 'state', mode: 'standalone', liveSessions: liveManager.list() }));
  ws.on('message', async (data) => {
    try {
      const command = JSON.parse(data.toString());
      const resp = await handleRpcCommand(command);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(resp));
    } catch (e) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
  });
  ws.on('close', () => liveManager.removeClient(ws));
  ws.on('error', () => liveManager.removeClient(ws));
});

setInterval(() => {
  for (const client of liveManager.clients) {
    if (client.readyState !== WebSocket.OPEN) { liveManager.removeClient(client); continue; }
    if (!client.isAlive) { try { client.terminate(); } catch {} liveManager.removeClient(client); continue; }
    client.isAlive = false;
    try { client.ping(); } catch {}
  }
}, 20000).unref();

function listen(port, attemptsLeft = 10) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`[Tau] Port ${port} in use, trying ${port + 1}...`);
      server.removeAllListeners('error');
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error(`[Tau] Failed to start: ${err.message}`);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    computeUrls(port);
    console.log(`[Tau] Standalone server running on ${mirrorUrl}${tailscaleUrl ? `  •  Tailscale: ${tailscaleUrl}` : ''}`);
    console.log(`[Tau] Static assets: ${STATIC_DIR}`);
    if (ARGS.open) openUrl(mirrorUrl).catch(() => {});
  });
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Tau] Shutting down (${signal}); terminating ${liveManager.sessions.size} Pi session(s)...`);
  try { wss.close(); } catch {}
  await liveManager.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2500).unref();
}
if (require.main === module) {
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', () => {
    for (const session of liveManager.sessions.values()) {
      try { session.child?.kill('SIGTERM'); } catch {}
    }
  });
  process.on('uncaughtException', (err) => { console.error(err); shutdown('uncaughtException'); });
  process.on('unhandledRejection', (err) => { console.error(err); });
  listen(PORT);
}

// Test-only helper to reset module-level auth state between cases.
function _setAuthForTest(enabled) { authEnabled = !!enabled; }

// Test-only hook to substitute the `pi` spawn so LiveSessionManager.create()
// can be exercised without launching a real Pi process.
let _spawnPiForTest = null;
function _setSpawnPiForTest(fn) { _spawnPiForTest = fn || null; }

module.exports = {
  parseArgs,
  expandHome,
  loadTauSettings,
  modelLabel,
  normalizeModel,
  parseModelSpecToModel,
  makeId,
  PiRpcSession,
  LiveSessionManager,
  liveManager,
  resolveSessionFile,
  appendSessionName,
  updateLiveSessionName,
  isWithinPath,
  resolveLiveSessionPath,
  resolveExportOutputPath,
  resolveExportedSessionPath,
  resolveOpenPath,
  openUrl,
  handleRpcCommand,
  isAllowedApiOrigin,
  setCorsForAllowedOrigin,
  handleApiRoute,
  serveStaticFile,
  server,
  wss,
  computeUrls,
  listen,
  SESSIONS_DIR,
  PI_AGENT_DIR,
  _setAuthForTest,
  _setSpawnPiForTest,
};
