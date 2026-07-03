/*
 * Session-cookie auth on top of HTTP Basic.
 *
 * iOS Safari (and the installed PWA) evicts cached Basic credentials when the
 * user switches apps, so Basic alone re-prompts on every return. After a
 * successful Basic request the server mints a signed, stateless session token
 * carried in a browser-session cookie (no Max-Age): it survives app switching
 * but ends with the browser session, and the embedded expiry bounds its life
 * even if the browser restores session cookies with restored tabs.
 */

const crypto = require('node:crypto');

import { TAU_SETTINGS, saveTauSetting } from './config.js';

export const SESSION_COOKIE_NAME = 'tau_session';
export const SESSION_TTL_SECONDS = 12 * 3600;
export const SESSION_REFRESH_THRESHOLD_SECONDS = 6 * 3600;

let cachedSecret = '';

// Lazy so installs that never enable auth never write settings.json.
function getCookieSecret(): string {
  if (cachedSecret) return cachedSecret;
  if (TAU_SETTINGS.cookieSecret) {
    cachedSecret = TAU_SETTINGS.cookieSecret;
    return cachedSecret;
  }
  cachedSecret = crypto.randomBytes(32).toString('hex');
  saveTauSetting('cookieSecret', cachedSecret);
  return cachedSecret;
}

// Recomputed per call so tokens die when the credentials change. The newline
// separator cannot appear in either field, unlike ':' which passwords allow.
function credentialFingerprint(): string {
  return crypto.createHash('sha256').update(TAU_SETTINGS.user + '\n' + TAU_SETTINGS.pass).digest('hex');
}

function signToken(expiresAtSeconds: number): string {
  return crypto.createHmac('sha256', getCookieSecret())
    .update('v1.' + expiresAtSeconds + '.' + credentialFingerprint())
    .digest('base64url');
}

export function issueSessionToken(expiresAtSeconds?: number): string {
  const expires = expiresAtSeconds ?? Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  return 'v1.' + expires + '.' + signToken(expires);
}

export function verifySessionToken(token: string): { valid: boolean; expiresAt: number } {
  const invalid = { valid: false, expiresAt: 0 };
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return invalid;
    const expiresAt = parseInt(parts[1], 10);
    if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return invalid;
    const expected = Buffer.from(signToken(expiresAt));
    const actual = Buffer.from(parts[2]);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return invalid;
    return { valid: true, expiresAt };
  } catch {
    return invalid;
  }
}

// Manual parser because the WebSocket upgrade path has no framework.
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try { out[name] = decodeURIComponent(part.slice(eq + 1).trim()); } catch {}
  }
  return out;
}

// No Max-Age/Expires on purpose: a browser-session cookie is dropped when the
// browser session ends, so killing the browser re-prompts for Basic auth.
export function buildSessionCookie(token: string, opts: { secure: boolean; clear?: boolean }): string {
  if (opts.clear) return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax` + (opts.secure ? '; Secure' : '');
}
