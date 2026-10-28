import { test } from 'node:test';
import assert from 'node:assert/strict';

const { arrangeProjects, SESSION_LIMIT } = (await import('../public/session-order.js')) as any;

type Session = { filePath: string };
type Project = { path: string; sessions: Session[] };

const project = (name: string, n: number): Project => ({
  path: `/p/${name}`,
  sessions: Array.from({ length: n }, (_, i) => ({ filePath: `/s/${name}/${i}.jsonl` })),
});
const tab = (id: string, filePath: string | null, cwd: string, openedAt: number, name: string | null = null) =>
  ({ id, filePath, cwd, openedAt, name });
const arrange = (projects: Project[], openTabs: unknown[] = [], extra: object = {}) =>
  arrangeProjects({ projects, openTabs, isExpanded: () => false, searching: false, ...extra });
const files = (sessions: Session[]) => sessions.map((s) => s.filePath);
const openFiles = (entry: { open: { tab: { filePath: string | null } }[] }) => entry.open.map((row) => row.tab.filePath);

test('the limit is 10', () => {
  assert.equal(SESSION_LIMIT, 10);
});

test('with no open tabs, projects keep their order and show their 10 newest sessions', () => {
  const big = project('big', 23);
  const small = project('small', 3);
  const result = arrange([big, small]);
  assert.deepEqual(result.map((e: any) => e.path), ['/p/big', '/p/small']);
  assert.deepEqual(result[0].visible, big.sessions.slice(0, 10));
  assert.equal(result[0].hiddenCount, 13);
  assert.equal(result[0].limited, true);
  assert.equal(result[0].total, 23);
  assert.deepEqual(result[1].visible, small.sessions);
  assert.equal(result[1].hiddenCount, 0);
  assert.equal(result[1].limited, false);
});

test('a project with exactly 10 sessions is not limited', () => {
  const result = arrange([project('ten', 10)]);
  assert.equal(result[0].visible.length, 10);
  assert.equal(result[0].limited, false);
});

test('projects with open tabs come first, ordered by their most recently opened tab, and the rest keep their order', () => {
  const a = project('a', 2);
  const b = project('b', 2);
  const c = project('c', 2);
  const d = project('d', 2);
  const result = arrange([a, b, c, d], [
    tab('1', '/s/c/1.jsonl', '/p/c', 100),
    tab('2', '/s/d/0.jsonl', '/p/d', 300),
    tab('3', '/s/c/0.jsonl', '/p/c', 200),
  ]);
  assert.deepEqual(result.map((e: any) => e.path), ['/p/d', '/p/c', '/p/a', '/p/b']);
});

test('inside a project, open sessions come first, most recently opened first, then the rest newest first', () => {
  const p = project('p', 5);
  const [entry] = arrange([p], [
    tab('1', '/s/p/3.jsonl', '/p/p', 100),
    tab('2', '/s/p/1.jsonl', '/p/p', 200),
  ]);
  assert.deepEqual(openFiles(entry), ['/s/p/1.jsonl', '/s/p/3.jsonl']);
  assert.equal(entry.open[0].session, p.sessions[1]);
  assert.deepEqual(files(entry.visible), ['/s/p/0.jsonl', '/s/p/2.jsonl', '/s/p/4.jsonl']);
});

test('every open session older than the 10 newest is shown, and the other sessions are still cut at 10', () => {
  const p = project('p', 23);
  const [entry] = arrange([p], [
    tab('1', '/s/p/15.jsonl', '/p/p', 100),
    tab('2', '/s/p/20.jsonl', '/p/p', 200),
    tab('3', '/s/p/4.jsonl', '/p/p', 50),
  ]);
  assert.deepEqual(openFiles(entry), ['/s/p/20.jsonl', '/s/p/15.jsonl', '/s/p/4.jsonl']);
  const rest = p.sessions.filter((_, i) => ![4, 15, 20].includes(i));
  assert.deepEqual(entry.visible, rest.slice(0, 10));
  assert.equal(entry.hiddenCount, 10);
  assert.equal(entry.limited, true);
  assert.equal(entry.total, 23);
});

test('open sessions do not count against the limit', () => {
  const p = project('p', 11);
  const [entry] = arrange([p], [tab('1', '/s/p/0.jsonl', '/p/p', 1)]);
  assert.equal(entry.open.length, 1);
  assert.equal(entry.visible.length, 10);
  assert.equal(entry.limited, false);
});

test('an expanded project and an active search show every session in the same order', () => {
  const p = project('p', 23);
  const tabs = [tab('1', '/s/p/15.jsonl', '/p/p', 100)];
  const rest = p.sessions.filter((_, i) => i !== 15);
  for (const extra of [{ isExpanded: () => true }, { searching: true }]) {
    const [entry] = arrange([p], tabs, extra);
    assert.deepEqual(openFiles(entry), ['/s/p/15.jsonl']);
    assert.deepEqual(entry.visible, rest);
    assert.equal(entry.hiddenCount, 0);
  }
});

test('an open tab with no row is placed in the project for its directory', () => {
  const p = project('p', 2);
  const other = project('other', 2);
  const result = arrange([other, p], [
    tab('new', null, '/p/p', 500, 'Fresh'),
    tab('old', '/s/p/1.jsonl', '/p/p', 100),
  ]);
  assert.deepEqual(result.map((e: any) => e.path), ['/p/p', '/p/other']);
  assert.deepEqual(result[0].open.map((row: any) => row.tab.id), ['new', 'old']);
  assert.equal(result[0].open[0].session, null);
  assert.deepEqual(files(result[0].visible), ['/s/p/0.jsonl']);
  assert.equal(result[0].total, 3);
});

test('an open tab with a file the list does not have yet is placed by its directory', () => {
  const [entry] = arrange([project('p', 1)], [tab('new', '/s/p/new.jsonl', '/p/p', 1)]);
  assert.equal(entry.open[0].session, null);
  assert.equal(entry.open[0].tab.id, 'new');
});

test('open tabs in a directory with no project get a new entry at the top', () => {
  const p = project('p', 2);
  const result = arrange([p], [
    tab('1', null, '/p/fresh', 300),
    tab('2', '/s/p/0.jsonl', '/p/p', 200),
    tab('3', null, '/p/fresh', 100),
  ]);
  assert.deepEqual(result.map((e: any) => e.path), ['/p/fresh', '/p/p']);
  assert.equal(result[0].project, null);
  assert.deepEqual(result[0].open.map((row: any) => row.tab.id), ['1', '3']);
  assert.deepEqual(result[0].visible, []);
  assert.equal(result[0].total, 2);
});

test('with no projects at all, open tabs still get entries', () => {
  const result = arrange([], [tab('1', null, '/p/fresh', 1)]);
  assert.equal(result.length, 1);
  assert.equal(result[0].path, '/p/fresh');
});
