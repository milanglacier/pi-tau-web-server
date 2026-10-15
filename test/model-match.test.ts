import { test } from 'node:test';
import assert from 'node:assert/strict';

const { normalizeModelList, searchModels, modelRef, modelMeta } = (await import('../public/model-match.js')) as any;

const models = normalizeModelList([
  { provider: 'openai', id: 'gpt-5.5', context: '400K', thinking: true },
  { provider: 'openrouter', id: 'z-ai/glm-5.2' },
  { provider: 'anthropic', id: 'claude-sonnet' },
  { provider: 'openai', id: 'gpt-5.5' },
  'google/gemini-pro',
  'no-slash',
  { id: 'missing-provider' },
]);

test('normalizeModelList drops duplicates and entries without a provider and id', () => {
  assert.deepEqual(models.map(modelRef), ['openai/gpt-5.5', 'openrouter/z-ai/glm-5.2', 'anthropic/claude-sonnet', 'google/gemini-pro']);
});

test('a model id that contains slashes stays one id', () => {
  const glm = models.find((m: { id: string }) => m.id.includes('glm'));
  assert.equal(glm.provider, 'openrouter');
  assert.equal(glm.id, 'z-ai/glm-5.2');
});

test('searchModels matches on the model id or the provider name', () => {
  assert.deepEqual(searchModels(models, 'glm').map(modelRef), ['openrouter/z-ai/glm-5.2']);
  assert.deepEqual(searchModels(models, 'anthropic').map(modelRef), ['anthropic/claude-sonnet']);
});

test('searchModels returns everything for an empty query, up to 50', () => {
  assert.equal(searchModels(models, '').length, 4);
  const many = Array.from({ length: 80 }, (_, i) => ({ provider: 'p', id: `m${i}` }));
  assert.equal(searchModels(many, '').length, 50);
});

test('modelMeta describes context window and capabilities', () => {
  assert.equal(modelMeta({ context: '400K', thinking: true }), '400K · thinking');
});
