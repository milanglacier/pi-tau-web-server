import { test } from 'node:test';
import assert from 'node:assert/strict';

const { findAtToken, findSlashToken, formatFileInsertion } = (await import('../public/composer-tokens.js')) as any;

test('@ at the start of the input starts a file reference', () => {
  assert.deepEqual(findAtToken('@'), { start: 0, query: '', quoted: false });
  assert.deepEqual(findAtToken('@src/ap'), { start: 0, query: 'src/ap', quoted: false });
});

test('@ after a space, tab, equals sign, quote or new line starts a file reference', () => {
  assert.deepEqual(findAtToken('look at @src'), { start: 8, query: 'src', quoted: false });
  assert.deepEqual(findAtToken('look\tat\t@src'), { start: 8, query: 'src', quoted: false });
  assert.deepEqual(findAtToken('file=@src'), { start: 5, query: 'src', quoted: false });
  assert.deepEqual(findAtToken('say "@src'), { start: 5, query: 'src', quoted: false });
  assert.deepEqual(findAtToken('first line\nsecond @src'), { start: 18, query: 'src', quoted: false });
});

test('@ after an opening bracket or backtick starts a file reference', () => {
  assert.deepEqual(findAtToken('see (@src/a'), { start: 5, query: 'src/a', quoted: false });
  assert.deepEqual(findAtToken('see `@src/a'), { start: 5, query: 'src/a', quoted: false });
  assert.deepEqual(findAtToken('see [@src/a'), { start: 5, query: 'src/a', quoted: false });
  assert.deepEqual(findAtToken('see ({@src'), { start: 6, query: 'src', quoted: false });
});

test('@ inside a word is not a file reference', () => {
  assert.equal(findAtToken('mail me at dev@example.com'), null);
  assert.equal(findAtToken('a@b'), null);
  assert.equal(findAtToken('user@'), null);
});

test('text with no @ in the word under the caret has no file reference', () => {
  assert.equal(findAtToken(''), null);
  assert.equal(findAtToken('hello world'), null);
  // The @ belongs to an earlier word.
  assert.equal(findAtToken('@src/app.ts and more'), null);
});

test('@" starts a quoted reference whose name may contain spaces', () => {
  assert.deepEqual(findAtToken('@"my fi'), { start: 0, query: 'my fi', quoted: true });
  assert.deepEqual(findAtToken('open @"my dir/sub'), { start: 5, query: 'my dir/sub', quoted: true });
  assert.deepEqual(findAtToken('@"'), { start: 0, query: '', quoted: true });
});

test('a quoted reference that is already closed is finished', () => {
  assert.equal(findAtToken('@"my file.txt" and'), null);
  assert.deepEqual(findAtToken('@"my file.txt" @sr'), { start: 15, query: 'sr', quoted: false });
});

test('@" inside a word does not start a quoted reference', () => {
  assert.equal(findAtToken('a@"b c'), null);
});

test('a brackets pair that belongs to the path is kept', () => {
  assert.deepEqual(findAtToken('@app/[slug]/pa'), { start: 0, query: 'app/[slug]/pa', quoted: false });
});

test('Chinese punctuation ends a word, but Chinese letters do not', () => {
  assert.deepEqual(findAtToken('请看，@src/a'), { start: 3, query: 'src/a', quoted: false });
  assert.equal(findAtToken('请看@src/a'), null);
});

test('a command is recognized only when the whole text so far is / and a name', () => {
  assert.deepEqual(findSlashToken('/'), { start: 0, query: '' });
  assert.deepEqual(findSlashToken('/rev'), { start: 0, query: 'rev' });
  assert.deepEqual(findSlashToken('/skill:td'), { start: 0, query: 'skill:td' });
});

test('a command is not recognized after the first space or away from the start', () => {
  assert.equal(findSlashToken('/review src'), null);
  assert.equal(findSlashToken('/review '), null);
  assert.equal(findSlashToken(' /rev'), null);
  assert.equal(findSlashToken('look at /tmp'), null);
  assert.equal(findSlashToken('first\n/rev'), null);
  assert.equal(findSlashToken('/rev\n'), null);
  assert.equal(findSlashToken(''), null);
  assert.equal(findSlashToken('rev'), null);
});

test('a file gets @ and a trailing space', () => {
  assert.deepEqual(formatFileInsertion('src/app.ts', false), { text: '@src/app.ts ', caretOffset: 12 });
});

test('a folder gets @ and no trailing space, so the user can keep going', () => {
  assert.deepEqual(formatFileInsertion('src/', false), { text: '@src/', caretOffset: 5 });
});

test('a name with spaces is quoted', () => {
  assert.deepEqual(formatFileInsertion('my file.txt', false), { text: '@"my file.txt" ', caretOffset: 15 });
  assert.deepEqual(formatFileInsertion('my dir/', false), { text: '@"my dir/"', caretOffset: 9 });
});

test('a reference typed as @" stays quoted even without spaces', () => {
  assert.deepEqual(formatFileInsertion('src/app.ts', true), { text: '@"src/app.ts" ', caretOffset: 14 });
  assert.deepEqual(formatFileInsertion('src/', true), { text: '@"src/"', caretOffset: 6 });
});

test('paths outside the project keep the form the user typed', () => {
  assert.deepEqual(formatFileInsertion('~/notes.txt', false), { text: '@~/notes.txt ', caretOffset: 13 });
  assert.deepEqual(formatFileInsertion('/etc/hosts', false), { text: '@/etc/hosts ', caretOffset: 12 });
});
