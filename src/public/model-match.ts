import type { ModelRecord } from './app-types.js';

export type NormalizedModel = {
  provider: string;
  id: string;
  label: string;
  contextWindow?: string | number;
  maxOutput?: string | number;
  thinking?: boolean | string;
  images?: boolean | string;
};

export const MODEL_SUGGESTION_LIMIT = 50;

export function normalizeAvailableModel(model: ModelRecord | string): NormalizedModel | null {
  if (!model) return null;
  if (typeof model === 'string') {
    const slashIdx = model.indexOf('/');
    if (slashIdx === -1) return null;
    return { provider: model.slice(0, slashIdx), id: model.slice(slashIdx + 1), label: model, contextWindow: '', maxOutput: '' };
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

export function normalizeModelList(availableModels: Array<ModelRecord | string>): NormalizedModel[] {
  const seen = new Set<string>();
  const out: NormalizedModel[] = [];
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

export function modelRef(model: { provider?: string; id?: string }) {
  return `${model.provider}/${model.id}`;
}

function fuzzyCharsEquivalent(a: string, b: string) {
  if (a === b) return true;
  const groups = ['o0', 'i1l', 's5', 'b8', 'g9', 'z2'];
  return groups.some((group) => group.includes(a) && group.includes(b));
}

function fuzzyMatch(query: string, text: string) {
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

export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string) {
  const tokens = String(query || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return items.map((item, index) => ({ item, score: -index }));
  const scored: { item: T; score: number }[] = [];
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


/** Fuzzy-match models against `id provider` and keep the best matches. */
export function searchModels<T extends { id?: string; provider?: string }>(models: T[], query: string): T[] {
  return fuzzyFilter(models, query.trim(), (model) => `${model.id} ${model.provider}`)
    .slice(0, MODEL_SUGGESTION_LIMIT)
    .map((m) => m.item);
}

/** Short description line shown next to a model suggestion. */
export function modelMeta(model: { contextWindow?: unknown; context?: unknown; maxOutput?: unknown; thinking?: unknown; images?: unknown }): string {
  return [
    model.contextWindow || model.context,
    model.maxOutput ? `out ${model.maxOutput}` : '',
    model.thinking === true ? 'thinking' : '',
    model.images === true ? 'images' : '',
  ].filter(Boolean).join(' · ');
}
