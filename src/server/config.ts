const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

import type { TauArgs, TauSettings, TauSettingsFile } from './types.js';

export function parseArgs(argv: string[]): TauArgs {
  const out: TauArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'open') { out.open = true; continue; }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; }
  }
  return out;
}

export const ARGS = parseArgs(process.argv.slice(2));
export const USER_HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
export const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(USER_HOME, '.pi', 'agent');
export const SESSIONS_DIR = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(PI_AGENT_DIR, 'sessions');

export function expandHome(p: string) {
  if (!p || typeof p !== 'string') return p;
  return p.startsWith('~') ? path.join(USER_HOME, p.slice(1)) : p;
}

export function loadTauSettings(): TauSettings {
  let settings: TauSettingsFile['tau'] = {};
  try {
    const settingsPath = path.join(PI_AGENT_DIR, 'settings.json');
    settings = ((JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as TauSettingsFile).tau || {});
  } catch {}
  return {
    port: parseInt(String(ARGS.port || process.env.TAU_PORT || settings.port || '3001'), 10),
    host: ARGS.host || process.env.TAU_HOST || settings.host || '0.0.0.0',
    user: process.env.TAU_USER || settings.user || '',
    pass: process.env.TAU_PASS || settings.pass || '',
    authEnabled: settings.authEnabled,
    cookieSecret: process.env.TAU_COOKIE_SECRET || settings.cookieSecret || '',
    projectsDir: expandHome(ARGS['projects-dir'] || process.env.TAU_PROJECTS_DIR || settings.projectsDir || ''),
  };
}

export const TAU_SETTINGS = loadTauSettings();
export const AUTH_CONFIGURED = !!(TAU_SETTINGS.user && TAU_SETTINGS.pass);
export const PORT = TAU_SETTINGS.port;
export const HOST = TAU_SETTINGS.host;
export const STATIC_DIR = process.env.TAU_STATIC_DIR || findPublicDir();

function findPublicDir() {
  const candidates: string[] = [];
  const add = (p: string) => candidates.push(path.resolve(p));
  add(path.join(__dirname, '..', 'public'));
  add(path.join(process.cwd(), 'public'));
  try {
    const pkgPath = require.resolve('pi-tau-web-server/package.json');
    add(path.join(path.dirname(pkgPath), 'public'));
  } catch {}
  add(path.join(process.cwd(), 'node_modules', 'pi-tau-web-server', 'public'));
  return candidates.find((c) => fs.existsSync(path.join(c, 'index.html'))) || candidates[0];
}

export const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function saveTauSetting(key: string, value: unknown): boolean {
  const settingsPath = path.join(PI_AGENT_DIR, 'settings.json');
  try {
    let settings: TauSettingsFile = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as TauSettingsFile; } catch {}
    if (!settings.tau) settings.tau = {};
    settings.tau[key] = value;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return true;
  } catch {
    return false;
  }
}

