import fs from 'node:fs';
import path from 'node:path';

import { USER_HOME } from './config.js';

export const DIRECTORY_COMPLETION_LIMIT = 50;

export type DirectoryCompletion = { name: string; path: string };

function isDirectory(dir: string, entry: fs.Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try { return fs.statSync(path.join(dir, entry.name)).isDirectory(); } catch { return false; }
}

/**
 * Suggest directories for text typed into a path field.
 *
 * Everything up to the last `/` names the directory to list; the rest is the
 * start of the child name to match. A leading `~` means the home directory,
 * and a path that is not absolute is resolved against `baseDir`.
 */
export function completeDirectories(prefix: string, baseDir: string): DirectoryCompletion[] {
  let text = String(prefix || '');
  if (text === '~') text = '~/';
  if (text.startsWith('~/')) text = path.join(USER_HOME, text.slice(1)) + (text.endsWith('/') ? '/' : '');

  const slash = text.lastIndexOf('/');
  const dirPart = slash === -1 ? '' : text.slice(0, slash + 1);
  const partial = text.slice(slash + 1).toLowerCase();
  const dir = path.resolve(baseDir, dirPart || '.');

  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }

  return entries
    .filter((entry) => isDirectory(dir, entry))
    .map((entry) => entry.name)
    .filter((name) => (partial.startsWith('.') || !name.startsWith('.')) && name.toLowerCase().startsWith(partial))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, DIRECTORY_COMPLETION_LIMIT)
    .map((name) => ({ name, path: path.join(dir, name) }));
}
