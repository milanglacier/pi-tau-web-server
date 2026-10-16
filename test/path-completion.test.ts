import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-path-completion-'));
process.env.HOME = home;
const { completeDirectories } = await import('../bin/path-completion.js');

for (const name of ['.hidden', '..cache', 'visible', 'nested/.config']) {
  fs.mkdirSync(path.join(home, name), { recursive: true });
}
after(() => fs.rmSync(home, { recursive: true, force: true }));

test('~/. lists hidden directories inside the home directory', () => {
  assert.deepEqual(completeDirectories('~/.', '/'), [
    { name: '..cache', path: path.join(home, '..cache') },
    { name: '.hidden', path: path.join(home, '.hidden') },
  ]);
});

test('a tilde path preserves a final dot inside a nested directory', () => {
  assert.deepEqual(completeDirectories('~/nested/.', '/'), [
    { name: '.config', path: path.join(home, 'nested', '.config') },
  ]);
});

test('~/.. matches names starting with two dots inside the home directory', () => {
  assert.deepEqual(completeDirectories('~/..', '/'), [
    { name: '..cache', path: path.join(home, '..cache') },
  ]);
});

test('a tilde path with a trailing slash lists visible children', () => {
  assert.deepEqual(completeDirectories('~/', '/'), [
    { name: 'nested', path: path.join(home, 'nested') },
    { name: 'visible', path: path.join(home, 'visible') },
  ]);
  assert.deepEqual(completeDirectories('~/nested/', '/'), []);
});
