---
status: COMPLETED
---

# Review — commit `fc7db76` "chore: add tests."

Scope: the commit in full — 10 test files under `test/`, the `bin/tau.js`
`require.main` guard + `module.exports` + two test-only hooks
(`_setAuthForTest`, `_setSpawnPiForTest`), the `package.json`
`"test": "node --test"` script, and the README test section. I re-ran the
suite: **107 tests, all green, ~274 ms**. This file is my own independent
assessment; it overwrites the prior review artifact that was shipped inside
the commit (which described five findings that are *already fixed* in this
same commit — those fixes are present in the code, so I treat them as
existing coverage, not gaps).

## Do the tests make sense?

Yes. The suite drives real production code, not stubs-of-stubs.

- `helpers.test.js` — pure functions (`parseArgs`, `expandHome`, `modelLabel`,
  `makeId`, `isWithinPath`, `isAllowedApiOrigin`) including traversal-escape,
  malformed-origin, and null-input cases. Strong.
- `session-paths.test.js`, `live-session-path.test.js` — path resolvers
  (`resolveSessionFile`, `appendSessionName`, `resolveExportOutputPath`,
  `resolveExportedSessionPath`, `resolveLiveSessionPath`) exercised against
  the real filesystem with outside-root, non-`.jsonl`, missing-file, and
  404/403-status inputs. Strongest files; would catch real regressions.
- `pi-rpc-session.test.js` — drives the real `PiRpcSession` state machine
  through `handleEvent` / `handleResponse` / `handleLine` / `handleExit` /
  `terminate`. Stubs only capture side effects. The SIGTERM→SIGKILL
  escalation, the "no SIGKILL if already exited" branch, and the 1.5 s grace
  wait (advanced with `t.mock.timers`, no wall-clock) are all genuinely
  verified. Title derivation, message tracking, and `updateStateFromResponse`
  are covered too.
- `live-session-manager.test.js` — fake sessions but the real `broadcast`,
  `delete`, `removeExited`, `shutdown` control flow; plus two `create()`
  tests that use the `_setSpawnPiForTest` hook with a `PassThrough`/`EventEmitter`
  fake child and `t.mock.timers` to advance `start()`'s 100 ms startup wait.
  Honest and meaningful.
- `http-routes.test.js` — real HTTP server on an ephemeral port, asserted via
  `fetch`. Covers health, live-session CRUD, files/preview, search, projects,
  sessions/delete, malformed-URL hardening, and same-origin vs cross-origin
  preflight (now asserting all four CORS headers, not just 200).
- `websocket.test.js`, `auth-websocket.test.js` — real `ws` client against the
  real upgrade path. Covers the "client disconnect must not terminate child
  sessions" invariant, the `set_auth` enable → `auth_changed` broadcast + 4001
  client-close, the disable direction (no close), and the auth-enabled 401
  enforcement on both HTTP (no creds / wrong creds / valid creds / health
  exempt) and WS (no-creds upgrade rejected).
- `auth-unconfigured.test.js` — loads the module with credentials unset (env
  deleted, no `settings.json`) so the load-time `AUTH_CONFIGURED` const is
  `false`, exercising the `set_auth` "No credentials configured" branch that
  every credential-configuring file leaves unhit. Clean use of `node --test`'s
  per-file process isolation.

So the bulk is meaningful. The findings below are coverage gaps, not defects
in what is tested.

## Are any tests meaningless / tests-for-tests?

No genuinely vacuous tests. Every assertion either exercises real production
behavior or is an honestly-named characterization pin. Two tests are
constant-echoes and are the weakest in the suite, but both are named to admit
it, which makes them acceptable pins rather than coverage theater:

- `get_available_models response shape is { models: [] }`
  (`test/rpc-command.test.js`) — the handler is a literal `return success({
  models: [] })` (`bin/tau.js:556`). The test asserts the hardcoded value is
  returned. It would only catch someone deleting the handler or changing the
  shape; it does not verify any logic. Weak, but the name says "shape," so it
  is not pretending to be more than it is.
- `set_auto_compaction echoes the enabled flag without persisting state`
  (`test/rpc-command.test.js`) — the handler is a no-op echo
  (`bin/tau.js:609`). The test follows up with a `get_state` call asserting
  `autoCompactionEnabled === true` (the hardcoded default at
  `bin/tau.js:604`), so the "without persisting state" clause is actually
  earned: it pins the no-op contract so a future change that adds
  persistence would break it. Acceptable.

One more worth naming, though I would not call it vacuous:
`makeId produces tau_-prefixed unique ids` (`test/helpers.test.js`) asserts a
regex and `a !== b`. The uniqueness is `Date.now() + Math.random()`, so the
inequality assertion is nearly tautological; the real value is guarding the
`tau_` prefix contract. Fine.

No action needed on any of these.

## Missing tests (remaining gaps)

The five findings from the prior review round — `set_auth` unconfigured
branch, auth-enabled 401 enforcement (HTTP + WS), `LiveSessionManager.create()`
end-to-end, CORS response headers, and the `export_html` sessionId guard —
are **all addressed in this commit** by new tests + the `_setSpawnPiForTest`
hook. They are no longer gaps. The following are gaps I found that the commit
does not cover, roughly in descending order of value:

### 1. Static-file path-traversal escape (`serveStaticFile` 403 branch)

`serveStaticFile` decodes the URL, joins it under `STATIC_DIR`, resolves, and
guards with `if (filePath !== staticRoot && !filePath.startsWith(staticRoot +
path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }`
(`bin/tau.js:627` region). No test exercises this branch. The existing
malformed-URL test (`/%E0%A4%A`) hits the `decodeURIComponent` throw → 400,
not the traversal guard. A request like `GET /%2e%2e%2fetc%2fpasswd` decodes
to `/../etc/passwd`, resolves outside `STATIC_DIR`, and must return 403. This
is security-adjacent and currently has zero coverage — the highest-value gap
here. Add a test that sends an encoded-traversal static path and asserts 403,
and that the server stays up afterward.

Location: `bin/tau.js` `serveStaticFile`; gap in `test/http-routes.test.js`.

### 2. `serveFilePreview` 415 non-image rejection

`serveFilePreview` opens with `if (!mime) return json(res, 415, { error: 'Not
a previewable image' })` (`bin/tau.js`). The one preview test sends a `.png`
and asserts 200; nothing sends a non-image (e.g. `?path=.../a.txt`) to assert
415. A regression that widened the `mimes` map or dropped the guard would not
be caught. Add a case: live session + `path` to a `.txt` inside cwd → 415
with `/Not a previewable image/`.

Location: `bin/tau.js` `serveFilePreview`; gap in `test/http-routes.test.js`.

### 3. Malformed JSON request body → 400

`readBody` rejects on a `JSON.parse` failure, and every `POST` route's
`.catch` turns that into `json(res, 400, { error: e.message })`. No test
sends an invalid JSON body (e.g. `body: '{not json'`) to any POST route. The
body-too-large branch (`> 20 * 1024 * 1024`) is also untested, but that one
is harder to exercise cheaply; the malformed-JSON case is trivial and worth
adding against `/api/rpc` or `/api/live-sessions`.

Location: `bin/tau.js` `readBody` + route handlers; gap in
`test/http-routes.test.js`.

### 4. `saveTauSetting` persistence is never read back

`set_auth` calls `saveTauSetting('authEnabled', authEnabled)`
(`bin/tau.js`), which writes `settings.json`. The `set_auth` tests assert the
in-memory response (`data.enabled`) but never read the file back to confirm
the value was persisted. A regression that made `saveTauSetting` a silent
no-op (e.g. swallowed the write inside its `try {}`) would pass every
existing test. Add a case that calls `set_auth { enabled: true }` and then
reads `path.join(PI_AGENT_DIR, 'settings.json')` to assert
`JSON.parse(...).tau.authEnabled === true`.

Location: `bin/tau.js` `saveTauSetting`; gap in `test/rpc-command.test.js`
(note: `rpc-command.test.js` sets `TAU_USER`/`TAU_PASS` via env, so the
`AUTH_CONFIGURED` guard is satisfied and `set_auth` will call
`saveTauSetting`).

### 5. `POST /api/live-sessions` happy path is not tested through HTTP

The HTTP route `POST /api/live-sessions` (`bin/tau.js`) calls
`liveManager.create({ cwd, model })`, which spawns `pi`. The existing HTTP
test only covers the `cwd required` 400 case; the success path is covered
only at the manager unit-test level via the `_setSpawnPiForTest` hook
(`test/live-session-manager.test.js`). The HTTP wrapper itself — body
parsing, `model` defaulting, `400` on `create()` rejection, `200` +
`session.metadata()` on success — is untested. To cover it without spawning
real `pi`, set `_setSpawnPiForTest` in `http-routes.test.js` (the hook is
already exported) and POST a real cwd, asserting a 200 with a `session.id`,
plus a 400 when the cwd does not exist.

Location: `bin/tau.js` `POST /api/live-sessions` handler; gap in
`test/http-routes.test.js`.

### 6. Minor / lower-priority gaps

- `maybeTitle` sentence-end truncation: the `if (sentenceEnd > 10 &&
  sentenceEnd < 80) title = title.slice(0, sentenceEnd)` branch
  (`bin/tau.js`) is not exercised — the long-message test has no `[.!?]\s`
  inside the window. A unit test with a message like `"Fix the bug. Then
  deploy it everywhere please."` would cover it.
- `updateStateFromResponse` `set_model`/`cycle_model` fallback
  (`if (data.provider && data.id) this.model = data`) when `data.model` is
  absent — not covered; the existing `handleResponse` test sets `data.model`.
- `serveFileList` dotfile/`IGNORED_NAMES` filtering — no test asserts that
  `.git`, `node_modules`, etc. are excluded from the listing.
- `openUrl` invalid-URL rejection (`/^https?:\/\//i.test(url)` → reject) —
  exported but untested. Low value (it shells out to OS openers).

## Test-hook hygiene note (not a test-quality issue)

The commit adds two test-only hooks to production code: `_setAuthForTest`
(mutable `authEnabled`) and `_setSpawnPiForTest` (substitutable spawn). Both
are exported and clearly named. The spawn hook is the more invasive one —
`start()` does `(_spawnPiForTest || spawn)('pi', args, …)`. This is a
reasonable trade-off for testability and matches the existing `_setAuthForTest`
pattern, but it is production code carrying a test seam, so it is worth a
one-line comment at the call site noting the hook is test-only (the
declaration site already has one). No action required.

## Overall assessment

**Verdict:** Accept with minor follow-ups.

**Explanation:** The suite is solid and free of meaningless tests — every
assertion exercises real production behavior or is an honestly-named shape
pin, and the five findings from the prior review round are already addressed
in this commit. The remaining gaps are real but mostly low-stakes: the
static-file traversal 403 branch is the only security-adjacent one and is the
most worthwhile to add, followed by the 415 non-image rejection, malformed
JSON body handling, `saveTauSetting` persistence readback, and the
`POST /api/live-sessions` HTTP happy path. The rest are minor branch
coverage. None of these block accepting the commit.

---

## Fix summaries (addressed after review)

All worthwhile findings addressed; the suite now runs **115 tests** (was 107)
in ~560 ms, all green. Each new test was mutation-verified: temporarily
breaking the production branch it targets makes that test (and only that
test) fail, then the break is reverted and `bin/tau.js` is restored
byte-identical. The two lowest-value minor gaps (`set_model` fallback,
`openUrl` validation) were left as documented follow-ups.

### Fix 1 — Covered the static-file path-traversal 403 branch

New test `static-file path traversal is rejected with 403` in
`test/http-routes.test.js` sends `GET /%2e%2e%2fsecret`. The encoded `%2e%2e`
decodes (via `decodeURIComponent` in `serveStaticFile`) to `..`, so
`path.resolve(path.join(staticRoot, '/../secret'))` resolves outside
`STATIC_DIR` and hits the `if (filePath !== staticRoot && !filePath.startsWith(staticRoot + path.sep)) { res.writeHead(403) }` containment guard — the branch the existing malformed-URL test (which hits the `decodeURIComponent` throw → 400) does not reach. It also re-fetches `/api/health` to confirm the server stays up. Mutation-verified by disabling the guard (`if (false && …)`): only this test fails.

### Fix 2 — Covered the `serveFilePreview` 415 non-image rejection

New test `GET /api/file/preview rejects a non-image with 415` creates a live
session whose cwd contains `notes.txt` and requests it via
`?sessionId=…&path=…/notes.txt`. The `mimes` lookup in `serveFilePreview`
returns `undefined` for `.txt`, hitting `if (!mime) return json(res, 415, { error: 'Not a previewable image' })` — the branch the existing preview test (which sends a `.png` and asserts 200) leaves unhit. Mutation-verified by bypassing the guard: only this test fails.

### Fix 3 — Covered malformed JSON request body → 400

New test `POST /api/rpc with a malformed JSON body returns 400` posts
`{not json` to `/api/rpc`. `readBody`'s `JSON.parse` throws on `end`, the
promise rejects, and the route's `.catch((e) => json(res, 400, { error: e.message }))` produces the 400. No existing test sent an unparseable body. Mutation-verified by making `readBody` swallow parse errors (`resolve({})` instead of `reject(e)`): the body becomes `{}`, `/api/rpc` returns 200, and only this test fails.

### Fix 4 — Asserted `saveTauSetting` persistence by reading `settings.json` back

New test `set_auth persists the enabled flag to settings.json` in
`test/rpc-command.test.js` calls `set_auth { enabled: true }` (credentials are
configured via `TAU_USER`/`TAU_PASS` in this file, so the `AUTH_CONFIGURED`
guard is satisfied), then reads `path.join(PI_AGENT_DIR, 'settings.json')`
and asserts `JSON.parse(...).tau.authEnabled === true`. Every prior `set_auth`
test asserted only the in-memory response (`data.enabled`); a regression that
made `saveTauSetting` a silent no-op would have passed them all.
Mutation-verified by skipping the `fs.writeFileSync` (`if (false) …`): only
this test fails (the read throws on the missing file).

### Fix 5 — Exercised the `POST /api/live-sessions` HTTP happy path and 400

Two new tests in `test/http-routes.test.js` use the existing
`_setSpawnPiForTest` hook (now imported into this file) with a
`PassThrough`/`EventEmitter` fake child so no real `pi` is spawned:
`POST /api/live-sessions creates a live session and returns 200` posts a real
temp cwd and asserts a 200 with a `tau_`-prefixed `session.id`, the resolved
cwd, and `modelSpec`; `POST /api/live-sessions returns 400 when the cwd does
not exist` posts a missing cwd and asserts a 400 matching `/Directory not
found/`. The happy path genuinely drives `start()`'s 100 ms startup wait
(~103 ms observed under mutation), then ends the fake stdin so the 250 ms
`get_session_stats` probe rejects immediately (caught by its `.catch(() => {})`)
instead of scheduling a long pending timer — this keeps the suite fast. The
400 case throws in `start()` before the spawn hook is even called, so no
timers are created. Mutation-verified: changing the success response to 400
fails only the first test; changing the error response to 200 fails only the
second.

### Fix 6 — Covered `maybeTitle` sentence-end truncation and `serveFileList` filtering

Two cheap branch-coverage tests:

- `title is truncated at the first sentence-end punctuation inside the
  window` (`test/pi-rpc-session.test.js`) sends a user message
  `'Fix the bug. Then deploy it everywhere please.'` and asserts
  `sessionName === 'Fix the bug'`, exercising the
  `if (sentenceEnd > 10 && sentenceEnd < 80) title = title.slice(0, sentenceEnd)`
  branch that the long-message test (no `[.!?]\s` in window) does not hit.
  Mutation-verified by disabling the branch: only this test fails (the title
  becomes the full truncated-with-… string).
- `GET /api/files filters dotfiles and ignored directories from the listing`
  (`test/http-routes.test.js`) creates a session cwd containing `a.txt`,
  `node_modules/`, and `.hidden/`, then asserts the listing includes `a.txt`
  but not `node_modules` (in `IGNORED_NAMES`) or `.hidden` (dotfile rule).
  Mutation-verified by disabling the `IGNORED_NAMES` check: only this test
  fails.

### Not addressed (documented low-value follow-ups)

- `updateStateFromResponse` `set_model`/`cycle_model` fallback
  (`if (data.provider && data.id) this.model = data`) when `data.model` is
  absent — minor branch; left as a follow-up.
- `openUrl` invalid-URL rejection — exported but untested; low value (shells
  out to OS openers).
