const { execFile } = require('node:child_process');

import type { JsonRecord, ModelIdentity, ParsedModelSpec, StatusError } from './types.js';

type ExecFileCallback = (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;
type ExecFileFn = (file: string, args: string[], opts: JsonRecord, callback: ExecFileCallback) => void;

export function modelLabel(model: ModelIdentity | string | null | undefined, fallback = '') {
  if (!model) return fallback || '';
  if (typeof model === 'string') return model;
  if (model.provider && model.id) return `${model.provider}/${model.id}`;
  return model.id || model.name || fallback || '';
}

// Normalize any model value into the canonical form: null or a full
// {provider, id, ...} object. Bare `provider/id` strings (and "id" strings
// with no slash) are parsed into objects; anything unrecognizable becomes null.
export function normalizeModel(value: unknown): ModelIdentity | null {
  if (!value) return null;
  if (typeof value === 'object') {
    const record = value as ModelIdentity;
    if (record.provider && record.id) return { ...record };
    if (record.id) return { ...record, provider: record.provider || '' };
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
export function parseModelSpecToModel(spec: unknown): ParsedModelSpec {
  const trimmed = String(spec || '').trim();
  if (!trimmed) return { model: null, level: null };
  let level = null;
  const colonIdx = trimmed.lastIndexOf(':');
  if (colonIdx !== -1) {
    const candidate = trimmed.slice(colonIdx + 1).toLowerCase();
    if (['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(candidate)) {
      level = candidate;
    }
  }
  const core = (colonIdx !== -1 && level) ? trimmed.slice(0, colonIdx) : trimmed;
  return { model: normalizeModel(core), level };
}

export function parseYesNo(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'yes') return true;
  if (normalized === 'no') return false;
  return value;
}

export function parsePiListModels(output: string) {
  const lines = String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const models = [];
  for (const line of lines) {
    if (/^provider\s+model\s+/i.test(line)) continue;
    const parts = line.split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const [provider, id, context, maxOutput, thinking, images] = parts;
    if (!provider || !id) continue;
    models.push({
      provider,
      id,
      ...(context !== undefined ? { context } : {}),
      ...(maxOutput !== undefined ? { maxOutput } : {}),
      ...(thinking !== undefined ? { thinking: parseYesNo(thinking) } : {}),
      ...(images !== undefined ? { images: parseYesNo(images) } : {}),
    });
  }
  return models;
}

const MODEL_LIST_CACHE_MS = 5 * 60 * 1000;
let modelListCache: { at: number; models: ModelIdentity[] } = { at: 0, models: [] };
let _execFileForTest: ExecFileFn | null = null;

export function execFileAsync(file: string, args: string[], opts: JsonRecord): Promise<{ stdout: string; stderr: string }> {
  const runner: ExecFileFn = _execFileForTest || execFile;
  return new Promise((resolve, reject) => {
    runner(file, args, opts, (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => {
      if (err) {
        (err as StatusError).stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export async function getAvailableModels() {
  const now = Date.now();
  if (modelListCache.at && now - modelListCache.at < MODEL_LIST_CACHE_MS) {
    return modelListCache.models;
  }
  try {
    const { stdout } = await execFileAsync('pi', ['--list-models'], { timeout: 30000, encoding: 'utf8' });
    const models = parsePiListModels(stdout);
    modelListCache = { at: now, models };
    return models;
  } catch (err) {
    console.warn('[Tau] Failed to list Pi models:', err instanceof Error ? err.message : err);
    modelListCache = { at: now, models: modelListCache.models || [] };
    return modelListCache.models;
  }
}


export function _setExecFileForTest(fn: ExecFileFn | null | undefined) { _execFileForTest = fn || null; modelListCache = { at: 0, models: [] }; }
export function _clearModelListCacheForTest() { modelListCache = { at: 0, models: [] }; }
