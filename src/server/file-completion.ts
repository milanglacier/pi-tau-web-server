import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { PI_AGENT_DIR, USER_HOME } from './config.js';

export type FileCompletion = {
  /** The file or folder name alone. */
  name: string;
  /** The text to insert after `@`. Folders end with `/`. */
  path: string;
  isDirectory: boolean;
};

type Candidate = { path: string; isDirectory: boolean };

/** How many suggestions are returned. */
export const FILE_COMPLETION_LIMIT = 20;
const SEARCH_RESULT_LIMIT = 100;

/** Folders the fallback search never lists or enters. */
export const HEAVY_FOLDER_NAMES = new Set([
  'node_modules', '.git', '__pycache__', '.Trash', '.next', '.nuxt', 'dist', 'build', '.cache', '.turbo',
  'venv', '.venv', 'env', '.pi', 'coverage', '.nyc_output', '.parcel-cache',
]);
/** The fallback search stops after looking at this many directory entries. */
export const FALLBACK_ENTRY_LIMIT = 20_000;
/** The fallback search stops after this many milliseconds. */
export const FALLBACK_TIME_LIMIT_MS = 1500;

function toDisplayPath(value: string) {
  return value.replace(/\\/g, '/');
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The pattern passed to `fd`. A query with a slash is matched against the
// whole path, so each segment is joined with a path separator.
function buildFdPattern(query: string) {
  const normalized = toDisplayPath(query);
  if (!normalized.includes('/')) return escapeRegex(normalized);
  const trimmed = normalized.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return normalized;
  let pattern = trimmed.split('/').filter(Boolean).map(escapeRegex).join('[\\\\/]');
  if (normalized.endsWith('/')) pattern += '[\\\\/]';
  return pattern;
}

let fdLocation: string | null | undefined;

/**
 * Find the `fd` program, the same way Pi does: the copy Pi installs in its
 * agent directory first, then `fd`, then `fdfind` (the Debian name) on PATH.
 * The answer is remembered. Returns null when none can run.
 */
export function locateFd(): string | null {
  if (fdLocation !== undefined) return fdLocation;
  const exe = process.platform === 'win32' ? 'fd.exe' : 'fd';
  const candidates = [path.join(PI_AGENT_DIR, 'bin', exe), 'fd', 'fdfind'];
  fdLocation = candidates.find((candidate) => {
    try { return spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0; } catch { return false; }
  }) ?? null;
  return fdLocation;
}

/** Forget the remembered `fd` location. For tests. */
export function _resetFdLocationForTest() {
  fdLocation = undefined;
}

function runFd(baseDir: string, fdPath: string, query: string, maxResults: number, signal: AbortSignal, maxDepth?: number): Promise<Candidate[]> {
  const args = [
    '--base-directory', baseDir,
    '--max-results', String(maxResults),
    '--type', 'f', '--type', 'd',
    '--follow', '--hidden',
    '--exclude', '.git', '--exclude', '.git/*', '--exclude', '.git/**',
  ];
  if (maxDepth !== undefined) args.push('--max-depth', String(maxDepth));
  if (toDisplayPath(query).includes('/')) args.push('--full-path');
  // `--` keeps a pattern that starts with `-` from being read as an option.
  if (query) args.push('--', buildFdPattern(query));

  return new Promise((resolve) => {
    if (signal.aborted) return resolve([]);
    const child = spawn(fdPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    let settled = false;
    const finish = (results: Candidate[]) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(results);
    };
    const onAbort = () => {
      if (child.exitCode === null) child.kill('SIGKILL');
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.on('error', () => finish([]));
    child.on('close', (code) => {
      if (signal.aborted || code !== 0 || !stdout) return finish([]);
      const results: Candidate[] = [];
      // Only line breaks are removed, since spaces can be part of a name.
      for (const line of stdout.split('\n').filter(Boolean)) {
        const display = toDisplayPath(line);
        const normalized = display.endsWith('/') ? display.slice(0, -1) : display;
        if (normalized === '.git' || normalized.startsWith('.git/') || normalized.includes('/.git/')) continue;
        results.push({ path: display, isDirectory: display.endsWith('/') });
      }
      finish(results);
    });
  });
}

/**
 * List files and folders under `baseDir` with plain Node calls, for machines
 * without `fd`. It looks at shallow folders first, skips heavy folders, does
 * not read `.gitignore`, and does not follow symbolic links into folders. Like
 * `fd`, it matches the query against the name, or against the whole path when
 * the query has a slash, and it ignores case unless the query has capitals.
 */
async function walkWithNode(baseDir: string, query: string, maxResults: number, signal: AbortSignal, maxDepth = Infinity): Promise<Candidate[]> {
  const matchWholePath = toDisplayPath(query).includes('/');
  const needle = toDisplayPath(query);
  const caseSensitive = needle !== needle.toLowerCase();
  const matches = (candidate: string, name: string) => {
    if (!needle) return true;
    const haystack = matchWholePath ? candidate : name;
    return (caseSensitive ? haystack : haystack.toLowerCase()).includes(caseSensitive ? needle : needle.toLowerCase());
  };

  const results: Candidate[] = [];
  const deadline = Date.now() + FALLBACK_TIME_LIMIT_MS;
  let seen = 0;
  let level: string[] = [''];
  for (let depth = 1; depth <= maxDepth && level.length; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      if (signal.aborted || Date.now() > deadline) return results;
      let entries: fs.Dirent[];
      try { entries = await fs.promises.readdir(path.join(baseDir, dir), { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (signal.aborted || seen >= FALLBACK_ENTRY_LIMIT || Date.now() > deadline) return results;
        seen++;
        let isDirectory = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try { isDirectory = (await fs.promises.stat(path.join(baseDir, dir, entry.name))).isDirectory(); } catch { continue; }
        } else if (!isDirectory && !entry.isFile()) {
          continue;
        }
        if (entry.name === '.git' || (isDirectory && HEAVY_FOLDER_NAMES.has(entry.name))) continue;
        const relative = dir + entry.name + (isDirectory ? '/' : '');
        if (matches(relative, entry.name)) {
          results.push({ path: relative, isDirectory });
          if (results.length >= maxResults) return results;
        }
        if (entry.isDirectory()) next.push(`${dir}${entry.name}/`);
      }
    }
    level = next;
  }
  return results;
}

// Higher is better. A folder gets a bonus so it sorts above a file that
// matches equally well.
function scoreCandidate(candidatePath: string, query: string, isDirectory: boolean) {
  const lowerName = path.posix.basename(candidatePath).toLowerCase();
  const lowerQuery = query.toLowerCase();
  let score = 0;
  if (lowerName === lowerQuery) score = 100;
  else if (lowerName.startsWith(lowerQuery)) score = 80;
  else if (lowerName.includes(lowerQuery)) score = 50;
  else if (candidatePath.toLowerCase().includes(lowerQuery)) score = 30;
  if (isDirectory && score > 0) score += 10;
  return score;
}

// A query with a slash names a folder to search in, up to the last slash. The
// rest is the text to match inside it. Returns null when the query has no
// slash or the folder does not exist, and then the working directory is
// searched with the whole query.
function resolveScopedQuery(rawQuery: string, cwd: string) {
  const normalized = toDisplayPath(rawQuery);
  const slash = normalized.lastIndexOf('/');
  if (slash === -1) return null;
  const displayBase = normalized.slice(0, slash + 1);
  const query = normalized.slice(slash + 1);
  let baseDir: string;
  if (displayBase.startsWith('~/')) baseDir = path.join(USER_HOME, displayBase.slice(2));
  else if (path.isAbsolute(displayBase)) baseDir = displayBase;
  else baseDir = path.join(cwd, displayBase);
  try {
    if (!fs.statSync(baseDir).isDirectory()) return null;
  } catch {
    return null;
  }
  return { baseDir, query, displayBase };
}

export type SearchFilesOptions = {
  /** Stops the search, and ends any `fd` process it started. */
  signal?: AbortSignal;
  /** The `fd` program to use. `null` forces the Node search. Defaults to `locateFd()`. */
  fdPath?: string | null;
};

/**
 * Suggest files and folders for the text typed after `@` in the chat input.
 *
 * Relative queries search `cwd`, and `~/` and absolute queries search where
 * they point. The best matches come first: exact name, then names that start
 * with the query, then names that contain it, then paths that contain it.
 */
export async function searchFiles(query: string, cwd: string, options: SearchFilesOptions = {}): Promise<FileCompletion[]> {
  const signal = options.signal ?? new AbortController().signal;
  const fdPath = options.fdPath === undefined ? locateFd() : options.fdPath;
  const scoped = resolveScopedQuery(query, cwd);
  const baseDir = scoped?.baseDir ?? cwd;
  const text = scoped?.query ?? query;

  const search = (limit: number, maxDepth?: number) => fdPath
    ? runFd(baseDir, fdPath, text, limit, signal, maxDepth)
    : walkWithNode(baseDir, text, limit, signal, maxDepth);
  const shallow = await search(SEARCH_RESULT_LIMIT, 1);
  const deep = await search(SEARCH_RESULT_LIMIT);
  if (signal.aborted) return [];

  const seenPaths = new Set(shallow.map((candidate) => candidate.path));
  const candidates = [...shallow, ...deep.filter((candidate) => {
    if (seenPaths.has(candidate.path)) return false;
    seenPaths.add(candidate.path);
    return true;
  })];

  const depth = (candidatePath: string) => toDisplayPath(candidatePath).split('/').filter(Boolean).length;
  return candidates
    .map((candidate) => ({ ...candidate, score: text ? scoreCandidate(candidate.path, text, candidate.isDirectory) : 1 }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score
      || depth(a.path) - depth(b.path)
      || a.path.length - b.path.length
      || a.path.localeCompare(b.path))
    .slice(0, FILE_COMPLETION_LIMIT)
    .map(({ path: candidatePath, isDirectory }) => {
      const withoutSlash = isDirectory ? candidatePath.slice(0, -1) : candidatePath;
      const shown = scoped ? scoped.displayBase + withoutSlash : withoutSlash;
      return { name: path.posix.basename(withoutSlash), path: isDirectory ? `${shown}/` : shown, isDirectory };
    });
}
