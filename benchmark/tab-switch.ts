import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import type { CDPSession, Page } from 'playwright';
import { PRESETS, buildSession } from './fixtures.ts';

// Measures how long the browser takes to show a large session when it opens
// it in a new tab or switches to an open tab. It drives the real UI in
// Chromium against the in-process server, with the pi child process faked
// the same way the end-to-end tests do. Run it with `npm run benchmark`, which
// builds first and provides Playwright browsers through Nix when needed.
//
//   npm run benchmark -- --preset typical,long --runs 5 --cpu 4
//   npm run benchmark -- --json after.json --baseline before.json
//   npm run benchmark -- --profile benchmark-profiles
//
// Each run measures four actions in order:
//   open          open session A from the sidebar on an empty page
//   open-replace  open session B from the sidebar while A is fully shown
//   switch        click A's tab while B is fully shown
//   switch-busy   click B's tab, then click A's tab as soon as B's newest
//                 messages are on screen, while B's older history still fills
//
// For each action it records when the newest message was painted ("tail"),
// when the whole history was in the page ("full"), how the snapshot request
// spent its time, and how long the main thread was blocked.

const { values: options } = parseArgs({
  options: {
    preset: { type: 'string', default: 'typical,long,images' },
    runs: { type: 'string', default: '3' },
    cpu: { type: 'string', default: '1' },
    profile: { type: 'string' },
    json: { type: 'string' },
    baseline: { type: 'string' },
    headed: { type: 'boolean', default: false },
  },
});

const presetNames = options.preset.split(',').map(name => name.trim()).filter(Boolean);
for (const name of presetNames) {
  if (!PRESETS[name]) throw new Error(`Unknown preset "${name}". Known presets: ${Object.keys(PRESETS).join(', ')}`);
}
const runs = Math.max(1, Number(options.runs) || 1);
const cpuRate = Math.max(1, Number(options.cpu) || 1);
const ACTION_TIMEOUT_MS = 180_000;

// Isolate session and settings directories before loading the server, which
// reads them at load time.
process.env.TAU_HOST = '127.0.0.1';
process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-benchmark-'));
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions');
process.env.TAU_PROJECTS_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'projects');

const tau = (await import('../bin/tau.js')) as any;
const { server, computeUrls, SESSIONS_DIR, liveManager, _setSpawnPiForTest, _setExecFileForTest } = tau;
const { buildHistoryItems } = (await import('../public/history-render.js')) as any;

// Keep the server's own logging out of the report.
const print = (line = '') => process.stdout.write(line + '\n');
console.log = () => {};

function makeFakeChild() {
  const child: any = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12345;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {};
  return child;
}

// Ending the fake child closes its tab the same way a real pi exit does,
// without the grace period a normal close waits for.
function closeAllLiveSessions() {
  for (const session of Array.from(liveManager.sessions.values()) as any[]) {
    session.child?.emit('exit', 0, null);
  }
}

type SessionFixture = { file: string; tailMarker: string; expectedItems: number };

function writeSessions(presetName: string) {
  const projectDir = path.join(SESSIONS_DIR, `--tmp--benchmark-${presetName}`);
  fs.mkdirSync(projectDir, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `tau-benchmark-cwd-${presetName}-`));
  const make = (tag: string, seed: number): SessionFixture => {
    const { entries, tailMarker } = buildSession(PRESETS[presetName], `${presetName}-${tag}`, cwd, seed);
    const file = path.join(projectDir, `${tag}.jsonl`);
    fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    return { file, tailMarker, expectedItems: buildHistoryItems(entries).items.length };
  };
  return { a: make('a', 1), b: make('b', 2) };
}

// ── In-page measurement ───────────────────────────────────────────────────

type ActionResult = {
  /** Synchronous work done by the click handler itself. */
  clickMs: number;
  /** When the newest history item had been painted. */
  tailMs: number | null;
  /** When every history item was in the page. Null when stopped at the tail. */
  fullMs: number | null;
  /** History items in the page right before the click. */
  itemsBefore: number;
  items: number;
  timedOut: boolean;
  snapshot: { startMs: number; waitMs: number; downloadMs: number; endMs: number; bytes: number } | null;
  longTasks: { count: number; totalMs: number; maxMs: number; blockingMs: number };
  domNodes: number;
  /** Elements inside collapsed tool card bodies and thinking blocks. */
  hiddenNodes: number;
};

type MeasureArgs = { selector: string; tailMarker: string; expectedItems: number; stopAtTail: boolean; timeoutMs: number };

// Runs in the page. Clicks the element, then checks once per frame. A
// condition seen in one frame is recorded at the next frame, after the
// browser has painted the first one.
function measureInPage({ selector, tailMarker, expectedItems, stopAtTail, timeoutMs }: MeasureArgs): Promise<ActionResult> {
  const container = document.getElementById('messages')!;
  // Walks only the direct children. A selector query here would search the
  // whole conversation every frame and slow the page it is measuring.
  const countItems = () => {
    let count = 0;
    for (const child of container.children) {
      if (child.classList.contains('message') || child.classList.contains('tool-card')) count++;
    }
    return count;
  };
  const tailShown = () => {
    let node = container.lastElementChild;
    for (let i = 0; node && i < 8; i++, node = node.previousElementSibling) {
      if (node.textContent?.includes(tailMarker)) return true;
    }
    return false;
  };
  const target = document.querySelector<HTMLElement>(selector);
  if (!target) throw new Error(`No element matches ${selector}`);
  const itemsBefore = countItems();
  const start = performance.now();
  target.click();
  const clickMs = performance.now() - start;

  return new Promise(resolve => {
    let tailSeen = false;
    let fullSeen = false;
    let tailMs: number | null = null;
    const finish = (fullMs: number | null, timedOut: boolean) => {
      const end = start + (fullMs ?? tailMs ?? performance.now() - start);
      const tasks = ((window as any).__benchmarkLongTasks as Array<{ start: number; duration: number }>)
        .filter(task => task.start >= start && task.start <= end);
      const request = (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
        .find(entry => entry.startTime >= start && entry.name.includes('/snapshot'));
      resolve({
        clickMs,
        tailMs,
        fullMs,
        itemsBefore,
        items: countItems(),
        timedOut,
        snapshot: request ? {
          startMs: request.startTime - start,
          waitMs: request.responseStart - request.requestStart,
          downloadMs: request.responseEnd - request.responseStart,
          endMs: request.responseEnd - start,
          bytes: request.encodedBodySize,
        } : null,
        longTasks: {
          count: tasks.length,
          totalMs: tasks.reduce((sum, task) => sum + task.duration, 0),
          maxMs: tasks.reduce((max, task) => Math.max(max, task.duration), 0),
          blockingMs: tasks.reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0),
        },
        domNodes: document.getElementsByTagName('*').length,
        hiddenNodes: [...container.querySelectorAll('.tool-card-body:not(.expanded), .thinking-content:not(.expanded)')]
          .reduce((sum, element) => sum + 1 + element.getElementsByTagName('*').length, 0),
      });
    };
    const frame = () => {
      const now = performance.now() - start;
      if (tailSeen && tailMs === null) {
        tailMs = now;
        if (stopAtTail) return finish(null, false);
      }
      if (fullSeen) return finish(now, false);
      if (!tailSeen && tailShown()) tailSeen = true;
      if (tailSeen && countItems() === expectedItems) fullSeen = true;
      if (now > timeoutMs) return finish(null, true);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

function recordLongTasks() {
  (window as any).__benchmarkLongTasks = [];
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      (window as any).__benchmarkLongTasks.push({ start: entry.startTime, duration: entry.duration });
    }
  }).observe({ type: 'longtask', buffered: true });
}

// ── Main-thread breakdown and CPU profiles through the DevTools protocol ──

type MainThread = { scriptMs: number; layoutMs: number; styleMs: number; taskMs: number; heapMB: number };

async function mainThreadTotals(cdp: CDPSession): Promise<MainThread> {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const get = (name: string) => metrics.find(metric => metric.name === name)?.value ?? 0;
  return {
    scriptMs: get('ScriptDuration') * 1000,
    layoutMs: get('LayoutDuration') * 1000,
    styleMs: get('RecalcStyleDuration') * 1000,
    taskMs: get('TaskDuration') * 1000,
    heapMB: get('JSHeapUsedSize') / 1e6,
  };
}

type ProfileNode = { id: number; callFrame: { functionName: string; url: string; lineNumber: number } };
type CpuProfile = { nodes: ProfileNode[]; samples?: number[]; timeDeltas?: number[] };

// Self time per function, so the report names what the main thread did.
function topFunctions(profile: CpuProfile, limit = 15) {
  const byId = new Map(profile.nodes.map(node => [node.id, node]));
  const selfMs = new Map<string, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  let total = 0;
  for (let i = 0; i < samples.length; i++) {
    const frame = byId.get(samples[i])?.callFrame;
    if (!frame) continue;
    const where = frame.url ? ` ${frame.url.split('/').pop()}:${frame.lineNumber + 1}` : '';
    const key = `${frame.functionName || '(anonymous)'}${where}`;
    const ms = (deltas[i] ?? 0) / 1000;
    selfMs.set(key, (selfMs.get(key) ?? 0) + ms);
    total += ms;
  }
  return [...selfMs.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, ms]) => ({ name, ms, share: total ? ms / total : 0 }));
}

// ── Running one action and one full run ───────────────────────────────────

type Sample = ActionResult & { preset: string; action: string; mainThread: MainThread };

async function runAction(page: Page, cdp: CDPSession, args: MeasureArgs, profileFile?: string) {
  await cdp.send('HeapProfiler.collectGarbage');
  const before = await mainThreadTotals(cdp);
  if (profileFile) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await cdp.send('Profiler.start');
  }
  const result = await page.evaluate(measureInPage, args);
  let profile: CpuProfile | undefined;
  if (profileFile) {
    profile = (await cdp.send('Profiler.stop')).profile as CpuProfile;
    fs.writeFileSync(profileFile, JSON.stringify(profile));
  }
  const after = await mainThreadTotals(cdp);
  const mainThread: MainThread = {
    scriptMs: after.scriptMs - before.scriptMs,
    layoutMs: after.layoutMs - before.layoutMs,
    styleMs: after.styleMs - before.styleMs,
    taskMs: after.taskMs - before.taskMs,
    heapMB: after.heapMB,
  };
  if (result.timedOut) throw new Error(`Timed out waiting for ${args.selector} to show ${args.tailMarker}`);
  return { result, mainThread, profile };
}

const sidebarItem = (file: string) => `.session-item[data-file-path="${path.resolve(file)}"]`;
const liveTab = (file: string) => `.live-tab[data-session-id="${liveManager.findBySessionFile(file).id}"]`;

async function runOnce(browser: import('playwright').Browser, base: string, preset: string, sessions: { a: SessionFixture; b: SessionFixture }, profileDir?: string) {
  closeAllLiveSessions();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    await context.addInitScript(recordLongTasks);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    if (cpuRate > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
    await page.goto(base);
    await page.waitForSelector(sidebarItem(sessions.a.file), { timeout: 30_000 });

    const { a, b } = sessions;
    const samples: Sample[] = [];
    const profiles: Array<{ action: string; top: ReturnType<typeof topFunctions> }> = [];
    const step = async (action: string, selector: string, session: SessionFixture, stopAtTail = false) => {
      const profileFile = profileDir ? path.join(profileDir, `${preset}-${action}.cpuprofile`) : undefined;
      const args = { selector, tailMarker: session.tailMarker, expectedItems: session.expectedItems, stopAtTail, timeoutMs: ACTION_TIMEOUT_MS };
      const { result, mainThread, profile } = await runAction(page, cdp, args, profileFile);
      samples.push({ preset, action, ...result, mainThread });
      if (profile) profiles.push({ action, top: topFunctions(profile) });
    };

    await step('open', sidebarItem(a.file), a);
    await step('open-replace', sidebarItem(b.file), b);
    await step('switch', liveTab(a.file), a);
    await step('busy-start', liveTab(b.file), b, true);
    await step('switch-busy', liveTab(a.file), a);
    return { samples: samples.filter(sample => sample.action !== 'busy-start'), profiles };
  } finally {
    await context.close();
  }
}

// ── Server-side cost of one snapshot response ─────────────────────────────

function serverCost(file: string) {
  const snapshot = liveManager.findBySessionFile(file).snapshot();
  const time = (fn: () => unknown) => {
    const times: number[] = [];
    let value: unknown;
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      value = fn();
      times.push(performance.now() - start);
    }
    return { ms: median(times), value };
  };
  const stringify = time(() => JSON.stringify(snapshot));
  const body = stringify.value as string;
  const gzip = time(() => zlib.gzipSync(body, { level: 6 }));
  const parse = time(() => JSON.parse(body));
  return {
    bytes: Buffer.byteLength(body),
    stringifyMs: stringify.ms,
    gzipBytes: (gzip.value as Buffer).length,
    gzipMs: gzip.ms,
    nodeParseMs: parse.ms,
  };
}

// ── Reporting ─────────────────────────────────────────────────────────────

function median(values: number[]) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((x, y) => x - y);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const METRICS: Array<{ key: string; label: string; get: (sample: Sample) => number | null | undefined }> = [
  { key: 'tailMs', label: 'tail', get: s => s.tailMs },
  { key: 'fullMs', label: 'full', get: s => s.fullMs },
  { key: 'beforeRequestMs', label: 'pre-req', get: s => s.snapshot?.startMs },
  { key: 'snapshotMs', label: 'snapshot', get: s => s.snapshot ? s.snapshot.endMs - s.snapshot.startMs : null },
  { key: 'tailRenderMs', label: 'tail-render', get: s => s.snapshot && s.tailMs !== null ? s.tailMs - s.snapshot.endMs : null },
  { key: 'maxTaskMs', label: 'max-task', get: s => s.longTasks.maxMs },
  { key: 'blockingMs', label: 'blocking', get: s => s.longTasks.blockingMs },
  { key: 'scriptMs', label: 'script', get: s => s.mainThread.scriptMs },
  { key: 'layoutMs', label: 'layout', get: s => s.mainThread.layoutMs },
  { key: 'styleMs', label: 'style', get: s => s.mainThread.styleMs },
  { key: 'domNodes', label: 'nodes', get: s => s.domNodes },
  { key: 'hiddenNodes', label: 'hidden', get: s => s.hiddenNodes },
  { key: 'heapMB', label: 'heap-MB', get: s => s.mainThread.heapMB },
];

type Summary = Record<string, Record<string, Record<string, number>>>;

function summarize(samples: Sample[]): Summary {
  const summary: Summary = {};
  for (const sample of samples) {
    summary[sample.preset] ??= {};
    summary[sample.preset][sample.action] ??= {};
  }
  for (const [preset, actions] of Object.entries(summary)) {
    for (const action of Object.keys(actions)) {
      const group = samples.filter(s => s.preset === preset && s.action === action);
      for (const metric of METRICS) {
        const values = group.map(metric.get).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
        if (values.length) actions[action][metric.key] = median(values);
      }
    }
  }
  return summary;
}

function table(rows: string[][]) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => row[column].length)));
  for (const [index, row] of rows.entries()) {
    print(row.map((cell, column) => (column < 2 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join('  '));
    if (index === 0) print(widths.map(width => '-'.repeat(width)).join('  '));
  }
}

const formatNumber = (value: number | undefined) =>
  value === undefined ? '-' : value >= 100 ? value.toFixed(0) : value.toFixed(1);

function printSummary(summary: Summary, baseline?: Summary) {
  const rows = [['preset', 'action', ...METRICS.map(metric => metric.label)]];
  for (const [preset, actions] of Object.entries(summary)) {
    for (const [action, values] of Object.entries(actions)) {
      rows.push([preset, action, ...METRICS.map(metric => {
        const now = values[metric.key];
        const before = baseline?.[preset]?.[action]?.[metric.key];
        if (now === undefined || before === undefined || before === 0) return formatNumber(now);
        const change = Math.round(((now - before) / before) * 100);
        return `${formatNumber(now)} (${change > 0 ? '+' : ''}${change}%)`;
      })]);
    }
  }
  table(rows);
}

// ── Main ──────────────────────────────────────────────────────────────────

_setSpawnPiForTest(() => makeFakeChild());
_setExecFileForTest((_file: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string, stderr: string) => void) =>
  cb(null, '', ''));

const fixtures = Object.fromEntries(presetNames.map(name => [name, writeSessions(name)]));
const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
computeUrls(port);
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ headless: !options.headed });

const samples: Sample[] = [];
const servers: Record<string, ReturnType<typeof serverCost>> = {};
const profiles: Record<string, Array<{ action: string; top: ReturnType<typeof topFunctions> }>> = {};
try {
  for (const preset of presetNames) {
    const sessions = fixtures[preset];
    print(`${preset}: ${sessions.a.expectedItems} history items per session, ${runs} run(s), CPU slowdown ${cpuRate}x`);
    for (let run = 0; run < runs; run++) {
      const result = await runOnce(browser, base, preset, sessions);
      samples.push(...result.samples);
      if (run === 0) servers[preset] = serverCost(sessions.a.file);
    }
    if (options.profile) {
      // A separate run, so profiler overhead never reaches the timings above.
      fs.mkdirSync(options.profile, { recursive: true });
      profiles[preset] = (await runOnce(browser, base, preset, sessions, options.profile)).profiles;
    }
  }
} finally {
  await browser.close();
  await liveManager.shutdown();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

print();
print('Snapshot response, measured in the server process (ms, bytes):');
table([
  ['preset', 'session', 'bytes', 'stringify', 'gzip-bytes', 'gzip', 'parse'],
  ...Object.entries(servers).map(([preset, cost]) => [
    preset, 'a', String(cost.bytes), formatNumber(cost.stringifyMs), String(cost.gzipBytes), formatNumber(cost.gzipMs), formatNumber(cost.nodeParseMs),
  ]),
]);

print();
print('Browser timings, median per action (ms unless noted). "tail" is when the newest');
print('message was painted, "full" when all history was in the page. "pre-req" is the');
print('work before the snapshot request started, "snapshot" the request itself, and');
print('"tail-render" the time from the response to the painted tail.');
const baseline = options.baseline ? JSON.parse(fs.readFileSync(options.baseline, 'utf8')).summary as Summary : undefined;
const summary = summarize(samples);
printSummary(summary, baseline);

for (const [preset, list] of Object.entries(profiles)) {
  for (const { action, top } of list) {
    print();
    print(`Top self time, ${preset} ${action} (profile saved in ${options.profile}):`);
    for (const fn of top) print(`  ${fn.ms.toFixed(1).padStart(8)} ms  ${(fn.share * 100).toFixed(1).padStart(5)}%  ${fn.name}`);
  }
}

if (options.json) {
  const gitSha = (() => {
    try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return ''; }
  })();
  fs.writeFileSync(options.json, JSON.stringify({
    meta: { date: new Date().toISOString(), git: gitSha, presets: presetNames, runs, cpuRate },
    server: servers,
    summary,
    samples,
  }, null, 2));
  print();
  print(`Saved results to ${options.json}`);
}
