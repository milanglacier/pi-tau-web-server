import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-file-completion-'));
const home = path.join(tmp, 'home');
const cwd = path.join(tmp, 'project');
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = path.join(tmp, 'agent');
const { searchFiles, locateFd, _resetFdLocationForTest, FILE_COMPLETION_LIMIT, FALLBACK_ENTRY_LIMIT } = await import('../bin/file-completion.js');

function touch(root: string, relative: string) {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), '');
}
for (const file of [
  'src/app.ts', 'src/lib/app-helper.ts', 'src/lib/util.ts', 'docs/guide.md', 'README.md', 'my file.txt', '.env',
  '.hidden/secret.txt', '.git/config',
  ...Array.from({ length: 30 }, (_, i) => `many/item-${String(i).padStart(2, '0')}.txt`),
]) touch(cwd, file);
touch(home, 'notes.txt');
const heavy = path.join(tmp, 'heavy');
for (const file of ['src/app.ts', 'node_modules/pkg/app.js', 'dist/app.js', 'build/app.js', '.cache/app.js']) touch(heavy, file);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const fdPath = locateFd();
// Every search behaves the same with `fd` and with the Node fallback, except
// where a test says otherwise. The `fd` runs are skipped when `fd` is missing.
const searchers = [
  { label: 'Node fallback', fdPath: null as string | null, skip: false },
  { label: 'fd', fdPath, skip: !fdPath },
];

for (const searcher of searchers) {
  const search = (query: string) => searchFiles(query, cwd, { fdPath: searcher.fdPath });
  const paths = async (query: string) => (await search(query)).map((item) => item.path);
  const options = { skip: searcher.skip ? 'fd is not installed' : false };

  test(`${searcher.label}: names that start with the query come before deeper matches`, options, async () => {
    assert.deepEqual(await paths('app'), ['src/app.ts', 'src/lib/app-helper.ts']);
  });

  test(`${searcher.label}: an exact name beats a longer name, and a folder beats a file with the same score`, options, async () => {
    assert.equal((await paths('README.md'))[0], 'README.md');
    const items = await search('src');
    assert.deepEqual(items[0], { name: 'src', path: 'src/', isDirectory: true });
  });

  test(`${searcher.label}: an empty query lists the top level first`, options, async () => {
    const top = (await paths('')).slice(0, 7);
    assert.deepEqual(new Set(top), new Set(['.env', '.hidden/', 'README.md', 'docs/', 'many/', 'my file.txt', 'src/']));
  });

  test(`${searcher.label}: hidden files and folders are suggested, but .git is not`, options, async () => {
    assert.deepEqual(await paths('hid'), ['.hidden/']);
    assert.deepEqual(await paths('env'), ['.env']);
    assert.deepEqual(await paths('config'), []);
  });

  test(`${searcher.label}: a folder query searches inside that folder and keeps the typed form`, options, async () => {
    assert.deepEqual(await paths('src/'), ['src/lib/', 'src/app.ts', 'src/lib/util.ts', 'src/lib/app-helper.ts']);
    assert.equal((await paths('src/l'))[0], 'src/lib/');
    assert.deepEqual(await paths('src/lib/ut'), ['src/lib/util.ts']);
    assert.deepEqual(await paths('./src/ap'), ['./src/app.ts', './src/lib/app-helper.ts']);
  });

  test(`${searcher.label}: ~/ searches the home directory and keeps the ~/ form`, options, async () => {
    assert.deepEqual(await paths('~/no'), ['~/notes.txt']);
  });

  test(`${searcher.label}: an absolute path searches there and keeps the absolute form`, options, async () => {
    assert.deepEqual(await paths(`${cwd}/docs/gu`), [`${cwd}/docs/guide.md`]);
    assert.deepEqual(await paths(`${cwd}/docs/`), [`${cwd}/docs/guide.md`]);
  });

  test(`${searcher.label}: a folder that does not exist gives no suggestions instead of an error`, options, async () => {
    assert.deepEqual(await paths('nowhere/app'), []);
    assert.deepEqual(await paths('/definitely/not/here/x'), []);
  });

  test(`${searcher.label}: names with spaces are returned as they are`, options, async () => {
    assert.deepEqual(await search('my f'), [{ name: 'my file.txt', path: 'my file.txt', isDirectory: false }]);
  });

  test(`${searcher.label}: at most ${FILE_COMPLETION_LIMIT} suggestions are returned`, options, async () => {
    assert.equal((await search('item-')).length, FILE_COMPLETION_LIMIT);
    assert.equal((await search('many/')).length, FILE_COMPLETION_LIMIT);
  });

  test(`${searcher.label}: a search that is already stopped returns nothing`, options, async () => {
    const stopped = new AbortController();
    stopped.abort();
    assert.deepEqual(await searchFiles('app', cwd, { fdPath: searcher.fdPath, signal: stopped.signal }), []);
  });
}

test('the Node fallback skips heavy folders and does not enter them', async () => {
  const items = await searchFiles('app', heavy, { fdPath: null });
  assert.deepEqual(items.map((item) => item.path), ['src/app.ts']);
  assert.equal((await searchFiles('dist', heavy, { fdPath: null })).length, 0);
  // A heavy folder named in the query is still searched.
  assert.deepEqual((await searchFiles('dist/ap', heavy, { fdPath: null })).map((item) => item.path), ['dist/app.js']);
});

test('the Node fallback does not follow symbolic links into folders', async () => {
  const root = fs.mkdtempSync(path.join(tmp, 'links-'));
  touch(root, 'real/inside.txt');
  fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
  fs.symlinkSync(path.join(root, 'missing'), path.join(root, 'broken'));
  const items = await searchFiles('', root, { fdPath: null });
  assert.deepEqual(items.map((item) => item.path).sort(), ['link/', 'real/', 'real/inside.txt']);
});

test('the Node fallback gives up after a fixed number of entries', async () => {
  const root = fs.mkdtempSync(path.join(tmp, 'big-'));
  const crowded = path.join(root, 'crowded');
  fs.mkdirSync(path.join(crowded, 'deeper'), { recursive: true });
  for (let i = 0; i < FALLBACK_ENTRY_LIMIT + 50; i++) fs.writeFileSync(path.join(crowded, `f${i}.txt`), '');
  fs.writeFileSync(path.join(root, 'shallow.txt'), '');
  fs.writeFileSync(path.join(crowded, 'deeper', 'deep.txt'), '');
  // Shallow folders are read first, so the crowded folder uses up the allowance
  // before the folder inside it is read.
  assert.deepEqual((await searchFiles('shallow', root, { fdPath: null })).map((item) => item.path), ['shallow.txt']);
  assert.deepEqual(await searchFiles('deep.txt', root, { fdPath: null }), []);
});

test('fd and the Node fallback agree on ordinary queries', { skip: fdPath ? false : 'fd is not installed' }, async () => {
  for (const query of ['app', 'src/', 'guide', 'item-0']) {
    const viaFd = (await searchFiles(query, cwd, { fdPath })).map((item) => item.path);
    const viaNode = (await searchFiles(query, cwd, { fdPath: null })).map((item) => item.path);
    assert.deepEqual(viaFd, viaNode, `query ${JSON.stringify(query)}`);
  }
});

const unix = process.platform !== 'win32';

test('the fd that Pi installs in its agent directory is used before fd on PATH', { skip: !unix }, () => {
  const installed = path.join(process.env.PI_CODING_AGENT_DIR!, 'bin', 'fd');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  _resetFdLocationForTest();
  try {
    assert.equal(locateFd(), installed);
  } finally {
    fs.rmSync(installed);
    _resetFdLocationForTest();
  }
});

test('stopping a search ends the fd process it started', { skip: !unix }, async () => {
  const marker = path.join(tmp, 'slow-fd.pid');
  const slowFd = path.join(tmp, 'slow-fd');
  fs.writeFileSync(slowFd, `#!/bin/sh\necho $$ > '${marker}'\nexec sleep 30\n`, { mode: 0o755 });
  const stop = new AbortController();
  const search = searchFiles('app', cwd, { fdPath: slowFd, signal: stop.signal });
  while (!fs.existsSync(marker) || !fs.readFileSync(marker, 'utf8').trim()) await new Promise((resolve) => setTimeout(resolve, 10));
  const pid = Number(fs.readFileSync(marker, 'utf8'));
  stop.abort();
  assert.deepEqual(await search, []);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
