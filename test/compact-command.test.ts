import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseCompactCommand } = (await import('../public/compact-command.js')) as any;

test('plain /compact is recognized without instructions', () => {
  assert.deepEqual(parseCompactCommand('/compact'), {});
});

test('text after /compact becomes the instructions for the summary', () => {
  assert.deepEqual(parseCompactCommand('/compact focus on the API changes'), { customInstructions: 'focus on the API changes' });
});

test('extra spaces and lines around /compact and its instructions are ignored', () => {
  assert.deepEqual(parseCompactCommand('  /compact  '), {});
  assert.deepEqual(parseCompactCommand('/compact    keep the API notes   '), { customInstructions: 'keep the API notes' });
  assert.deepEqual(parseCompactCommand('/compact\nfirst line\nsecond line'), { customInstructions: 'first line\nsecond line' });
});

test('a longer word that starts with /compact is not recognized', () => {
  assert.equal(parseCompactCommand('/compactor'), null);
  assert.equal(parseCompactCommand('/compact-foo'), null);
  assert.equal(parseCompactCommand('/compact:now'), null);
});

test('other slash commands and plain text are left for Pi', () => {
  assert.equal(parseCompactCommand('/skill:review'), null);
  assert.equal(parseCompactCommand('/session-model openai/gpt-5'), null);
  assert.equal(parseCompactCommand('please /compact the context'), null);
  assert.equal(parseCompactCommand('compact'), null);
});
