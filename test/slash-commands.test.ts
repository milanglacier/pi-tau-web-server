import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseCompactCommand } = (await import('../public/slash-commands.js')) as any;

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

const { resolveSlashCommand, matchCommands, blockedCommandNote, slashCommandName, isTauHandledName, TAU_COMMANDS } = (await import('../public/slash-commands.js')) as any;

const NONE = new Set<string>();

test('the command name is the first word after the slash', () => {
  assert.equal(slashCommandName('/review src/app.ts'), 'review');
  assert.equal(slashCommandName('  /skill:tdd  '), 'skill:tdd');
  assert.equal(slashCommandName('hello /review'), null);
  assert.equal(slashCommandName('/'), null);
  assert.equal(slashCommandName(''), null);
});

test('/tree, /export, /session and /model on their own run Tau\'s own feature', () => {
  for (const name of ['tree', 'export', 'session', 'model']) {
    assert.deepEqual(resolveSlashCommand(`/${name}`, NONE), { kind: 'tau', name });
    assert.deepEqual(resolveSlashCommand(`  /${name}  `, NONE), { kind: 'tau', name });
  }
});

test('a Tau command given text it does not take is refused', () => {
  assert.deepEqual(resolveSlashCommand('/model gpt-5', NONE), { kind: 'blocked', name: 'model', reason: 'arguments' });
  assert.deepEqual(resolveSlashCommand('/export out.html', NONE), { kind: 'blocked', name: 'export', reason: 'arguments' });
  assert.match(blockedCommandNote({ kind: 'blocked', name: 'model', reason: 'arguments' }), /\/model does not take extra text/);
});

test('terminal-only commands are refused with a note', () => {
  for (const name of ['settings', 'thinking', 'scoped-models', 'login', 'logout', 'new', 'resume', 'name', 'fork', 'clone', 'import', 'copy', 'share', 'bug', 'trust', 'reload', 'hotkeys', 'changelog', 'quit']) {
    assert.deepEqual(resolveSlashCommand(`/${name}`, NONE), { kind: 'blocked', name, reason: 'terminal-only' });
  }
  assert.deepEqual(resolveSlashCommand('/name my session', NONE), { kind: 'blocked', name: 'name', reason: 'terminal-only' });
  assert.equal(blockedCommandNote({ kind: 'blocked', name: 'settings', reason: 'terminal-only' }), '/settings only works in Pi\'s terminal, so Tau did not send it.');
});

test('a name that Pi lists is never refused or taken over', () => {
  const pi = new Set(['settings', 'reload', 'model', 'mcp', 'review']);
  assert.deepEqual(resolveSlashCommand('/settings', pi), { kind: 'prompt' });
  assert.deepEqual(resolveSlashCommand('/reload now', pi), { kind: 'prompt' });
  assert.deepEqual(resolveSlashCommand('/model', pi), { kind: 'prompt' });
  assert.deepEqual(resolveSlashCommand('/mcp', pi), { kind: 'prompt' });
});

test('every other message goes to Pi unchanged', () => {
  assert.deepEqual(resolveSlashCommand('/review src/app.ts', NONE), { kind: 'prompt' });
  assert.deepEqual(resolveSlashCommand('/skill:tdd', NONE), { kind: 'prompt' });
  assert.deepEqual(resolveSlashCommand('/mcp', NONE), { kind: 'prompt' });
  assert.deepEqual(resolveSlashCommand('/usr/bin/env is a path', NONE), { kind: 'prompt' });
  assert.deepEqual(resolveSlashCommand('please run /settings', NONE), { kind: 'prompt' });
  assert.deepEqual(resolveSlashCommand('hello', NONE), { kind: 'prompt' });
});

test('only names Tau acts on or refuses need Pi\'s list to be read first', () => {
  assert.equal(isTauHandledName('settings'), true);
  assert.equal(isTauHandledName('tree'), true);
  assert.equal(isTauHandledName('review'), false);
  assert.equal(isTauHandledName('compact'), false);
});

const PI_COMMANDS = [
  { name: 'session-model', description: 'Pick a model for this session', source: 'extension' },
  { name: 'review', description: 'Review the changes', source: 'prompt' },
  { name: 'skill:tdd', description: 'Test-driven development', source: 'skill' },
  { name: 'skill:grilling', description: 'Interview me', source: 'skill' },
];

test('an empty query lists Tau\'s commands first and then Pi\'s, in Pi\'s order', () => {
  const names = matchCommands(PI_COMMANDS, '').map((entry: { name: string }) => entry.name);
  assert.deepEqual(names, [...TAU_COMMANDS.map((command: { name: string }) => command.name), 'session-model', 'review', 'skill:tdd', 'skill:grilling']);
});

test('each row says where its command comes from', () => {
  const byName = Object.fromEntries(matchCommands(PI_COMMANDS, '').map((entry: { name: string; badge: string; description: string }) => [entry.name, entry]));
  assert.equal(byName.tree.badge, 'tau');
  assert.equal(byName['session-model'].badge, 'extension');
  assert.equal(byName.review.badge, 'prompt');
  assert.equal(byName['skill:tdd'].badge, 'skill');
  assert.equal(byName.review.description, 'Review the changes');
});

test('names are matched loosely', () => {
  assert.deepEqual(matchCommands(PI_COMMANDS, 'rev').map((entry: { name: string }) => entry.name), ['review']);
  assert.ok(matchCommands(PI_COMMANDS, 'smod').some((entry: { name: string }) => entry.name === 'session-model'));
  assert.deepEqual(matchCommands(PI_COMMANDS, 'zzzz'), []);
});

test('a skill is found by its bare name, and bare-name matches come first', () => {
  assert.deepEqual(matchCommands(PI_COMMANDS, 'tdd').map((entry: { name: string }) => entry.name), ['skill:tdd']);
  assert.deepEqual(matchCommands(PI_COMMANDS, 'grill').map((entry: { name: string }) => entry.name), ['skill:grilling']);
  // "skill:" only appears in the full name.
  const names = matchCommands(PI_COMMANDS, 'skill:').map((entry: { name: string }) => entry.name);
  assert.deepEqual(names, ['skill:tdd', 'skill:grilling']);
});

test('a command that Pi lists hides the Tau command with the same name', () => {
  const entries = matchCommands([{ name: 'model', description: 'From an extension', source: 'extension' }], 'model');
  assert.deepEqual(entries.map((entry: { badge: string }) => entry.badge), ['extension']);
});
