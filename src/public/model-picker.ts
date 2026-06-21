import type { ModelRecord, RpcCommand } from './app-types.js';

type ModelPickerOptions = {
  getActiveLiveSessionId(): string | null;
  isViewingActiveSession(): boolean;
  rpcCommand(cmd: RpcCommand, statusMsg?: string): Promise<{ success?: boolean; data?: Record<string, unknown>; error?: string }>;
  flashStatusError(message: string, ms?: number): void;
  escapeHtml(text: string): string;
  setContextWindowSize(value: number): void;
  updateTokenUsage(): void;
};

export function setupModelPicker(options: ModelPickerOptions) {
  const { getActiveLiveSessionId, isViewingActiveSession, rpcCommand, flashStatusError, escapeHtml, setContextWindowSize, updateTokenUsage } = options;

// ═══════════════════════════════════════
// Model Picker
// ═══════════════════════════════════════

const modelInput = document.getElementById('model-input');
const modelPickerOverlay = document.getElementById('model-picker-overlay');
const modelPicker = document.getElementById('model-picker');
const modelPickerInput = document.getElementById('model-picker-input');
const modelPickerList = document.getElementById('model-picker-list');
const modelPickerMessage = document.getElementById('model-picker-message');
const modelPickerClose = document.getElementById('model-picker-close');
const modelPickerCancel = document.getElementById('model-picker-cancel');
const modelPickerSave = document.getElementById('model-picker-save');
const VALID_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const MODEL_PICKER_HELP = 'Type provider or model name; optional :off|minimal|low|medium|high|xhigh';
let currentModelId: ModelRecord | string = '';
let availableModels: Array<ModelRecord | string> = [];
let currentThinkingLevel = 'off';
let modelPickerMatches: ModelRecord[] = [];
let modelPickerActiveIndex = -1;
let modelPickerJustSelected = false;

function modelDisplayString() {
  if (!currentModelId) return '';
  let provider, modelId;
  if (typeof currentModelId === 'object' && currentModelId) {
    provider = currentModelId.provider || '';
    modelId = currentModelId.id || '';
  } else {
    // Legacy fallback: a bare string is ambiguous when model names contain
    // slashes (e.g. openrouter/z-ai/glm-5.2). Split ONCE on the first slash
    // to separate provider from the rest, because the server normalizes
    // everything into {provider, id} objects before it reaches us.
    const str = String(currentModelId);
    const slashIdx = str.indexOf('/');
    if (slashIdx === -1) {
      provider = '';
      modelId = str;
    } else {
      provider = str.slice(0, slashIdx);
      modelId = str.slice(slashIdx + 1);
    }
  }
  const level = currentThinkingLevel || 'off';
  if (provider && modelId) return `${provider}/${modelId}:${level}`;
  if (modelId) return `${modelId}:${level}`;
  return '';
}

function updateModelDisplay() {
  const display = modelDisplayString() || 'Model';
  modelInput.textContent = display;
  modelInput.title = display === 'Model' ? 'Choose model and (optionally) thinking level for this session' : display;
  modelInput.classList.remove('invalid');
}

function parseModelSpec(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return { error: 'Use format provider/model[:thinking], e.g. opencode-go/deepseek-v4-pro:xhigh' };
  }
  // Model IDs can contain slashes (e.g. OpenRouter "z-ai/glm-5.2"), so the
  // input format is provider/<rest...>[:level]. Split on the FIRST slash to
  // separate provider, then split off the optional :level suffix from the end.
  const firstSlash = trimmed.indexOf('/');
  if (firstSlash === -1) {
    return { error: 'Use format provider/model[:thinking], e.g. opencode-go/deepseek-v4-pro:xhigh' };
  }
  const provider = trimmed.slice(0, firstSlash);
  const rest = trimmed.slice(firstSlash + 1);
  if (!provider || !rest) {
    return { error: 'Use format provider/model[:thinking], e.g. opencode-go/deepseek-v4-pro:xhigh' };
  }
  let modelId = rest;
  let thinking = null;
  const lastColon = rest.lastIndexOf(':');
  if (lastColon !== -1) {
    const candidate = rest.slice(lastColon + 1).toLowerCase();
    if (VALID_THINKING_LEVELS.has(candidate)) {
      thinking = candidate;
      modelId = rest.slice(0, lastColon);
    }
  }
  if (!modelId) {
    return { error: 'Use format provider/model[:thinking], e.g. opencode-go/deepseek-v4-pro:xhigh' };
  }
  return { provider, modelId, thinking };
}

function normalizeAvailableModel(model) {
  if (!model) return null;
  if (typeof model === 'string') {
    const slashIdx = model.indexOf('/');
    if (slashIdx === -1) return null;
    return { provider: model.slice(0, slashIdx), id: model.slice(slashIdx + 1), label: model };
  }
  const provider = model.provider || '';
  const id = model.id || model.model || model.name || '';
  if (!provider || !id) return null;
  return {
    provider,
    id,
    label: `${provider}/${id}`,
    contextWindow: model.contextWindow || model.context || model.context_window || '',
    maxOutput: model.maxOutput || model.max_output || model.maxOut || '',
    thinking: model.thinking,
    images: model.images,
  };
}

function normalizedAvailableModels() {
  const seen = new Set();
  const out = [];
  for (const item of availableModels || []) {
    const normalized = normalizeAvailableModel(item);
    if (!normalized) continue;
    const key = `${normalized.provider}/${normalized.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function modelRef(model) {
  return `${model.provider}/${model.id}`;
}

function fuzzyCharsEquivalent(a, b) {
  if (a === b) return true;
  const groups = ['o0', 'i1l', 's5', 'b8', 'g9', 'z2'];
  return groups.some((group) => group.includes(a) && group.includes(b));
}

function fuzzyMatch(query, text) {
  const q = String(query || '').toLowerCase();
  const t = String(text || '').toLowerCase();
  if (!q) return { score: 0 };
  if (!t) return null;
  const compactQ = q.replace(/[\W_]+/g, '');
  const compactT = t.replace(/[\W_]+/g, '');
  if (compactQ && compactT.includes(compactQ)) {
    return { score: 1200 - compactT.indexOf(compactQ) };
  }

  let qi = 0;
  let lastMatch = -1;
  let score = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    const qc = q[qi];
    const tc = t[ti];
    const direct = qc === tc;
    const swap = fuzzyCharsEquivalent(qc, tc);
    if (!direct && !swap) continue;
    score += direct ? 20 : 8;
    if (ti === 0 || /[\s/_:.-]/.test(t[ti - 1])) score += 12;
    if (lastMatch === ti - 1) score += 18;
    if (lastMatch !== -1) score -= Math.max(0, ti - lastMatch - 1);
    lastMatch = ti;
    qi++;
  }
  if (qi !== q.length) return null;
  if (t === q) score += 500;
  if (t.startsWith(q)) score += 250;
  return { score };
}

function fuzzyFilter(items, query, getText) {
  const tokens = String(query || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return items.map((item, index) => ({ item, score: -index }));
  const scored = [];
  items.forEach((item, index) => {
    const text = getText(item);
    let total = 0;
    for (const token of tokens) {
      const match = fuzzyMatch(token, text);
      if (!match) return;
      total += match.score;
    }
    scored.push({ item, score: total - index * 0.01 });
  });
  return scored.sort((a, b) => b.score - a.score);
}

function validThinkingSuffix(raw) {
  const text = String(raw || '').trim();
  const colonIdx = text.lastIndexOf(':');
  if (colonIdx === -1) return '';
  const candidate = text.slice(colonIdx + 1).toLowerCase();
  return VALID_THINKING_LEVELS.has(candidate) ? `:${candidate}` : '';
}

function setModelPickerMessage(message = MODEL_PICKER_HELP, isError = false) {
  modelPickerMessage.textContent = message;
  modelPickerMessage.classList.toggle('error', isError);
  modelPickerInput.classList.toggle('invalid', isError);
}

function updateModelPickerActiveItem() {
  modelPickerList.querySelectorAll('.model-item').forEach((item, index) => {
    const active = index === modelPickerActiveIndex;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function renderModelPickerSuggestions() {
  const raw = modelPickerInput.value || '';
  modelPickerSave.disabled = !raw.trim();
  modelPickerList.innerHTML = '';
  modelPickerJustSelected = false;
  if (raw.includes(':')) {
    modelPickerMatches = [];
    modelPickerActiveIndex = -1;
    setModelPickerMessage(MODEL_PICKER_HELP, false);
    return;
  }

  const models = normalizedAvailableModels();
  const query = raw.trim();
  modelPickerMatches = fuzzyFilter(models, query, (model) => `${model.id} ${model.provider}`).slice(0, 50).map((m) => m.item);
  if (modelPickerActiveIndex >= modelPickerMatches.length) modelPickerActiveIndex = modelPickerMatches.length - 1;
  if (modelPickerActiveIndex < 0 && modelPickerMatches.length) modelPickerActiveIndex = 0;

  if (!modelPickerMatches.length) {
    const empty = document.createElement('div');
    empty.className = 'model-item-context';
    empty.textContent = models.length ? 'No matching models. You can still save a manual provider/model value.' : 'No model list available. You can still save a manual provider/model value.';
    empty.style.padding = '10px 12px';
    modelPickerList.appendChild(empty);
    return;
  }

  modelPickerMatches.forEach((model, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `model-item${index === modelPickerActiveIndex ? ' active' : ''}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', index === modelPickerActiveIndex ? 'true' : 'false');
    const meta = [
      model.contextWindow || model.context,
      model.maxOutput ? `out ${model.maxOutput}` : '',
      model.thinking === true ? 'thinking' : '',
      model.images === true ? 'images' : '',
    ].filter(Boolean).join(' · ');
    item.innerHTML = `
      <span class="model-item-name">${escapeHtml(model.id)}<span class="model-item-provider">${escapeHtml(model.provider)}</span></span>
      <span class="model-item-context">${escapeHtml(meta)}</span>
    `;
    item.addEventListener('mouseenter', () => {
      modelPickerActiveIndex = index;
      updateModelPickerActiveItem();
    });
    item.addEventListener('click', () => selectModelSuggestion(index));
    modelPickerList.appendChild(item);
  });
}

function selectModelSuggestion(index) {
  const model = modelPickerMatches[index];
  if (!model) return;
  const suffix = validThinkingSuffix(modelPickerInput.value);
  modelPickerInput.value = `${modelRef(model)}${suffix}`;
  modelPickerInput.focus();
  modelPickerInput.setSelectionRange(modelPickerInput.value.length, modelPickerInput.value.length);
  modelPickerMatches = [];
  modelPickerActiveIndex = -1;
  modelPickerList.innerHTML = '';
  modelPickerSave.disabled = false;
  modelPickerJustSelected = true;
}

function openModelPicker() {
  // The model button is disabled by updateMirrorInputState when there is no
  // active live session, so this handler is only reachable via click when a
  // session exists.
  modelPickerInput.value = modelDisplayString();
  modelPickerActiveIndex = -1;
  modelPickerJustSelected = false;
  setModelPickerMessage(MODEL_PICKER_HELP, false);
  renderModelPickerSuggestions();
  modelPicker.classList.remove('hidden');
  modelPickerOverlay.classList.remove('hidden');
  requestAnimationFrame(() => {
    modelPickerInput.focus();
    modelPickerInput.select();
  });
  fetchModelInfo().then(() => {
    if (!modelPicker.classList.contains('hidden')) renderModelPickerSuggestions();
  }).catch(() => {});
}

function closeModelPicker() {
  modelPicker.classList.add('hidden');
  modelPickerOverlay.classList.add('hidden');
  modelPickerMatches = [];
  modelPickerActiveIndex = -1;
  modelPickerJustSelected = false;
  modelPickerList.innerHTML = '';
  setModelPickerMessage(MODEL_PICKER_HELP, false);
}

async function applyModelSpec(rawSpec) {
  const raw = String(rawSpec || '').trim();
  // No-op when the user didn't actually edit anything. Avoids spurious
  // set_model/set_thinking_level RPCs and false validation errors on the
  // current display string.
  if (raw === modelDisplayString()) {
    modelInput.classList.remove('invalid');
    return { success: true };
  }
  if (!isViewingActiveSession() || !getActiveLiveSessionId()) {
    const error = 'Select a live Tau tab first.';
    flashStatusError(error);
    return { success: false, error };
  }
  const parsed = parseModelSpec(raw);
  if (parsed.error) {
    flashStatusError(parsed.error);
    return { success: false, error: parsed.error };
  }
  const r = await rpcCommand({ type: 'set_model', provider: parsed.provider, modelId: parsed.modelId }, `Switching to ${parsed.provider}/${parsed.modelId}...`);
  if (r && r.success) {
    const data = r.data || {};
    // Always retain the provider so modelDisplayString() can render the
    // full `provider/model:thinking` form. The server sometimes omits
    // `provider` in its response; fall back to the user-typed value.
    const responseModel = (typeof data.model === 'object' && data.model ? data.model : data) as ModelRecord;
    const provider = responseModel.provider || parsed.provider;
    const id = responseModel.id || parsed.modelId;
    currentModelId = (provider && id) ? { ...responseModel, provider, id } : (id || parsed.modelId);
    const responseContextWindow = responseModel.contextWindow || data.contextWindow;
    if (responseContextWindow) {
      setContextWindowSize(Number(responseContextWindow) || 0);
      updateTokenUsage();
    }
    if (parsed.thinking !== null) {
      const t = await rpcCommand({ type: 'set_thinking_level', level: parsed.thinking }, 'Setting thinking...');
      if (t && t.success) {
        currentThinkingLevel = parsed.thinking;
      } else {
        // Non-fatal: the model was already changed on the server.
        // Show the error but still consider the model update successful
        // so the popup closes and the user can retry thinking separately.
        flashStatusError((t && t.error) ? t.error : 'Failed to set thinking level');
      }
    }
    modelInput.classList.remove('invalid');
    updateModelDisplay();
    return { success: true };
  }
  const error = (r && r.error) ? r.error : 'Unknown model';
  flashStatusError(error);
  modelInput.classList.add('invalid');
  setTimeout(() => modelInput.classList.remove('invalid'), 1200);
  return { success: false, error };
}

async function saveModelPicker() {
  const result = await applyModelSpec(modelPickerInput.value);
  if (result.success) {
    closeModelPicker();
  } else {
    setModelPickerMessage(result.error || 'Failed to update model', true);
    modelPickerInput.focus();
  }
}

modelInput.addEventListener('click', openModelPicker);
modelPickerOverlay.addEventListener('click', closeModelPicker);
modelPickerClose.addEventListener('click', closeModelPicker);
modelPickerCancel.addEventListener('click', closeModelPicker);
modelPickerSave.addEventListener('click', saveModelPicker);
modelPickerInput.addEventListener('input', () => {
  modelPickerActiveIndex = -1;
  modelPickerJustSelected = false;
  setModelPickerMessage(MODEL_PICKER_HELP, false);
  renderModelPickerSuggestions();
});
modelPickerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeModelPicker();
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (modelPickerMatches.length) {
      modelPickerActiveIndex = (modelPickerActiveIndex + 1) % modelPickerMatches.length;
      renderModelPickerSuggestions();
    }
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (modelPickerMatches.length) {
      modelPickerActiveIndex = (modelPickerActiveIndex - 1 + modelPickerMatches.length) % modelPickerMatches.length;
      renderModelPickerSuggestions();
    }
    return;
  }
  if (e.key === 'Tab' && modelPickerMatches.length && modelPickerActiveIndex >= 0) {
    e.preventDefault();
    selectModelSuggestion(modelPickerActiveIndex);
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (!modelPickerJustSelected && modelPickerMatches.length && modelPickerActiveIndex >= 0) {
      selectModelSuggestion(modelPickerActiveIndex);
    } else {
      saveModelPicker();
    }
  }
});

async function fetchModelInfo() {
  try {
    const [modelsResp, stateResp] = await Promise.all([
      fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'get_available_models', sessionId: getActiveLiveSessionId() }) }),
      fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'get_state', sessionId: getActiveLiveSessionId() }) }),
    ]);
    const modelsData = await modelsResp.json();
    const stateData = await stateResp.json();

    if (modelsData.success && modelsData.data?.models) {
      availableModels = modelsData.data.models;
    }
    if (stateData.success && stateData.data?.model !== undefined) {
      // Server is canonical: stateData.data.model is null or a full
      // {provider,id} object. Assign directly — no string fallback.
      currentModelId = stateData.data.model || '';
      if (stateData.data.model?.contextWindow) {
        setContextWindowSize(Number(stateData.data.model.contextWindow) || 0);
        updateTokenUsage();
      }
    }
    if (stateData.success && stateData.data?.thinkingLevel) {
      currentThinkingLevel = stateData.data.thinkingLevel || 'off';
    }
    updateModelDisplay();
  } catch (e) {
    // ignore
  }
}

  function setModelState(model: ModelRecord | string | null, thinkingLevel = 'off') {
    currentModelId = model || '';
    currentThinkingLevel = thinkingLevel || 'off';
    updateModelDisplay();
  }

  function setThinkingLevel(level: string) {
    currentThinkingLevel = level || 'off';
    updateModelDisplay();
  }

  function setEnabled(enabled: boolean) {
    modelInput.disabled = !enabled;
  }

  function closeIfOpen() {
    if (modelPicker.classList.contains('hidden')) return false;
    closeModelPicker();
    return true;
  }

  return { applyModelSpec, closeIfOpen, fetchModelInfo, setEnabled, setModelState, setThinkingLevel, updateModelDisplay };
}
