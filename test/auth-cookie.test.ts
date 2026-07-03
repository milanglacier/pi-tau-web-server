const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { WebSocket } = require('ws');
import type { TestContext } from 'node:test';
import type { WebSocket as WsWebSocket } from 'ws';

// Session-cookie auth on top of Basic: after a successful Basic request the
// server mints a signed browser-session cookie that is accepted in place of
// the Authorization header on both HTTP requests and WebSocket upgrades.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-auth-cookie-'));
process.env.TAU_HOST = '127.0.0.1';
process.env.PI_CODING_AGENT_DIR = TMP;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(TMP, 'sessions');
fs.mkdirSync(process.env.PI_CODING_AGENT_SESSION_DIR, { recursive: true });
fs.writeFileSync(
  path.join(TMP, 'settings.json'),
  JSON.stringify({ tau: { user: 'admin', pass: 's3cret', authEnabled: false } }),
);

const {
  server, computeUrls, liveManager,
  SESSION_COOKIE_NAME, _setAuthForTest, _setCredentialsForTest, _issueSessionTokenForTest,
} = require('../bin/tau.js');

let base = '';
let wsUrl = '';

before((t: TestContext, done: () => void) => {
  _setAuthForTest(false);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    computeUrls(port);
    base = `http://127.0.0.1:${port}`;
    wsUrl = `ws://127.0.0.1:${port}/ws`;
    done();
  });
});

after((t: TestContext, done: () => void) => {
  server.close(done);
});

beforeEach(() => {
  liveManager.sessions.clear();
  _setAuthForTest(true);
  _setCredentialsForTest('admin', 's3cret');
});

const BASIC = 'Basic ' + Buffer.from('admin:s3cret').toString('base64');

function extractToken(setCookie: string | null): string {
  assert.ok(setCookie, 'expected a Set-Cookie header');
  const match = /tau_session=([^;]*)/.exec(String(setCookie));
  assert.ok(match, `expected a ${SESSION_COOKIE_NAME} cookie in: ${setCookie}`);
  return match![1];
}

function nowSec() { return Math.floor(Date.now() / 1000); }

test('valid Basic request mints a browser-session cookie', async () => {
  const res = await fetch(`${base}/api/live-sessions`, { headers: { Authorization: BASIC } });
  assert.equal(res.status, 200);
  const setCookie = res.headers.get('set-cookie');
  const token = extractToken(setCookie);
  assert.ok(token.startsWith('v1.'), 'token must be a v1 signed token');
  assert.match(String(setCookie), /HttpOnly/);
  assert.match(String(setCookie), /SameSite=Lax/);
  assert.match(String(setCookie), /Path=\//);
  // a browser-session cookie: dropped when the browser session ends
  assert.doesNotMatch(String(setCookie), /Max-Age/i);
  assert.doesNotMatch(String(setCookie), /Expires/i);
  // plain-HTTP request: no Secure flag or the browser would drop the cookie
  assert.doesNotMatch(String(setCookie), /Secure/);
});

test('cookie-only HTTP request succeeds without Authorization', async () => {
  const mint = await fetch(`${base}/api/live-sessions`, { headers: { Authorization: BASIC } });
  const token = extractToken(mint.headers.get('set-cookie'));
  const res = await fetch(`${base}/api/live-sessions`, {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
  assert.equal(res.status, 200);
  // a full-life token is not refreshed on every request
  assert.equal(res.headers.get('set-cookie'), null);
});

test('cookie-only WebSocket upgrade succeeds and receives initial state', async () => {
  const token = _issueSessionTokenForTest();
  const ws = new WebSocket(wsUrl, {
    headers: { Origin: base, Host: new URL(base).host, Cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
  const msg = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for WS message')), 2000);
    ws.once('message', (data: Buffer) => { clearTimeout(timer); resolve(JSON.parse(data.toString())); });
    ws.once('error', (e: Error) => { clearTimeout(timer); reject(e); });
  });
  assert.equal(msg.type, 'state');
  ws.close();
});

test('tampered cookie is rejected with 401, WWW-Authenticate, and a clearing Set-Cookie', async () => {
  const token = _issueSessionTokenForTest();
  const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
  const res = await fetch(`${base}/api/live-sessions`, {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${flipped}` },
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('www-authenticate'), 'Basic realm="Tau"');
  assert.match(String(res.headers.get('set-cookie')), /tau_session=;.*Max-Age=0/);
});

test('expired cookie is rejected with 401 and WWW-Authenticate', async () => {
  const token = _issueSessionTokenForTest(nowSec() - 10);
  const res = await fetch(`${base}/api/live-sessions`, {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('www-authenticate'), 'Basic realm="Tau"');
});

test('garbage cookie is rejected with 401 and WWW-Authenticate', async () => {
  const res = await fetch(`${base}/api/live-sessions`, {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=junk` },
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('www-authenticate'), 'Basic realm="Tau"');
});

test('cookie without credentials on WebSocket upgrade is rejected when invalid', async () => {
  const ws = new WebSocket(wsUrl, {
    headers: { Origin: base, Host: new URL(base).host, Cookie: `${SESSION_COOKIE_NAME}=junk` },
  });
  await assert.rejects(
    () => new Promise((_, reject) => {
      ws.on('error', reject);
      ws.on('open', () => reject(new Error('invalid-cookie upgrade should not succeed')));
    }),
  );
  try { ws.close(); } catch {}
});

test('changing credentials invalidates outstanding cookies', async () => {
  const token = _issueSessionTokenForTest();
  _setCredentialsForTest('admin', 'newpass');
  const stale = await fetch(`${base}/api/live-sessions`, {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
  assert.equal(stale.status, 401);
  // Basic with the new password works and mints a fresh, working cookie
  const newBasic = 'Basic ' + Buffer.from('admin:newpass').toString('base64');
  const mint = await fetch(`${base}/api/live-sessions`, { headers: { Authorization: newBasic } });
  assert.equal(mint.status, 200);
  const fresh = extractToken(mint.headers.get('set-cookie'));
  const res = await fetch(`${base}/api/live-sessions`, {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${fresh}` },
  });
  assert.equal(res.status, 200);
});

test('no cookie is minted while auth is disabled', async () => {
  _setAuthForTest(false);
  const res = await fetch(`${base}/api/live-sessions`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('a cookie nearing expiry is refreshed (sliding session)', async () => {
  const token = _issueSessionTokenForTest(nowSec() + 3600); // under the 6h refresh threshold
  const res = await fetch(`${base}/api/live-sessions`, {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
  assert.equal(res.status, 200);
  const fresh = extractToken(res.headers.get('set-cookie'));
  assert.notEqual(fresh, token);
});

test('Secure flag is set when the request came through a TLS proxy', async () => {
  const res = await fetch(`${base}/api/live-sessions`, {
    headers: { Authorization: BASIC, 'x-forwarded-proto': 'https' },
  });
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('set-cookie')), /; Secure/);
});

test('cookie secret is persisted under the tau key in settings.json', async () => {
  await fetch(`${base}/api/live-sessions`, { headers: { Authorization: BASIC } });
  const settings = JSON.parse(fs.readFileSync(path.join(TMP, 'settings.json'), 'utf8'));
  assert.match(String(settings.tau.cookieSecret), /^[0-9a-f]{64}$/);
  // the entrypoint's first-boot cleanup only strips tau.user/tau.pass, so the
  // secret key must live alongside them, not replace them
  assert.equal(settings.tau.user, 'admin');
});
