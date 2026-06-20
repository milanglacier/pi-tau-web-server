# Review — `chore: add tests.` (c27cb93)

Scope: the test commit in full (9 test files, the `bin/tau.js` export +
`require.main` guard, `package.json` test script, README test section). All 83
tests pass under `npm test`.

## Do the tests make sense?

Overall, yes. The suite is well-structured and exercises real behavior, not
stubs-of-stubs:

- `helpers.test.js`, `session-paths.test.js`, `live-session-path.test.js` test
  pure functions and path resolvers against the real filesystem with real
  traversal-escape / outside-root / malformed-URL inputs. These are the
  strongest files — they would catch real regressions.
- `pi-rpc-session.test.js` drives the `PiRpcSession` state machine through
  `handleEvent` / `handleResponse` / `handleLine` / `terminate` / `handleExit`
  with a stub manager and stub child. The stubs only capture side effects
  (broadcasts, kill signals, pending rejections); the logic under test is the
  real class. The SIGTERM→SIGKILL escalation and the "no SIGKILL if already
  exited" branch are both genuinely verified.
- `live-session-manager.test.js` uses fake sessions only because real
  `PiRpcSession` would spawn `pi`; it still exercises the real `broadcast`,
  `delete`, `removeExited`, and `shutdown` control flow.
- `http-routes.test.js` and `websocket.test.js` spin up the real HTTP/WS
  server on an ephemeral port and assert through `fetch` / a real `ws` client,
  including same-origin vs cross-origin preflight, malformed-URL hardening,
  and the important "client disconnect must not terminate child sessions"
  invariant.
- `rpc-command.test.js` injects fake sessions into the real `liveManager` and
  covers the `handleRpcCommand` branches, including the
  ack-timeout→success conversion for `prompt`/`abort`/`extension_ui_response`
  and the "immediate send failure is surfaced as an error" path.

So the bulk of the suite is meaningful. The issues below are the few cases
where a test is either a "test for the test setup", advertises coverage it
does not provide, or is redundant with a name that oversells it.

## Findings

### Title: Remove the `SESSIONS_DIR is wired to the temp tree` sanity test

Body: This test asserts `SESSIONS_DIR === SESSIONS`, where `SESSIONS` is the
exact value just assigned to `process.env.PI_CODING_AGENT_SESSION_DIR` a few
lines above, and `SESSIONS_DIR` is computed from that env var
(`bin/tau.js:16-17`). It is true by construction and exercises no production
logic — it only confirms the test's own env wiring was set before `require`.
If the env-var fallback in `bin/tau.js` ever broke, every other test in this
file would fail against the real Pi tree, making this assertion redundant. It
is a test for the test harness, not for tau.

Location: `/home/milanglacier/Desktop/personal-projects/tau/test/session-paths.test.js:91-93`

### Title: `set_auth` test name claims a "rejects without configured credentials" case it never exercises

Body: The test title promises coverage of the
`if (!AUTH_CONFIGURED) return error('No credentials configured…')` branch
(`bin/tau.js:541`), but `TAU_USER`/`TAU_PASS` are set at the top of the file
so `AUTH_CONFIGURED` is always `true`, and the body only toggles
`enabled: false` then `enabled: true`. The unconfigured-credentials rejection
path is never hit. Either rename the test to match what it does
("set_auth toggles the enabled flag"), or add a case that runs with
credentials unset to actually cover the error branch.

Location: `/home/milanglacier/Desktop/personal-projects/tau/test/rpc-command.test.js:69-76`

### Title: `live_session_created` WS test does not exercise `manager.create()`

Body: The test is named "live_session_created is broadcast when a session is
created via the manager", but it never calls `liveManager.create()` — it
manually invokes `liveManager.broadcast({ type: 'live_session_created', … })`
and checks the client received it. That verifies the WS server delivers a
broadcast payload to a connected client, which is already covered by the
`broadcast only delivers to OPEN clients` unit test plus the
`same-origin WebSocket upgrade receives the initial standalone state` test.
It does not verify the actual creation path emits the event. Either rename
to reflect the real intent ("broadcasts are delivered to connected WS
clients") or drive a real `create()` (with `pi` stubbed or the spawn
factored out) so the name is honest.

Location: `/home/milanglacier/Desktop/personal-projects/tau/test/websocket.test.js:128-136`

### Title: `terminate` tests pay the real 1.5s SIGTERM grace wait on every run

Body: `PiRpcSession.terminate` awaits a hardcoded `setTimeout(resolve, 1500)`
(`bin/tau.js:355`) before deciding whether to SIGKILL. The two escalation
tests in `pi-rpc-session.test.js` each pay that full wait, and together they
account for ~3.0s of the suite's ~3.1s total runtime. The escalation *logic*
(the `exitCode === null && signalCode === null` re-check) could be validated
with `node:test`'s `mock.timers()` (or a smaller injected delay) without
waiting on wall-clock time. Not a correctness issue, but it is the dominant
cost of the suite and is cheaply fixable.

Location: `/home/milanglacier/Desktop/personal-projects/tau/test/pi-rpc-session.test.js:120-141`

## Overall assessment

**Verdict:** Needs minor revision.

**Explanation:** The suite is genuinely useful — the great majority of tests
exercise real production behavior and would catch regressions. The four
findings above are isolated quality issues: one literal test-of-the-setup
(`SESSIONS_DIR` wiring), two tests whose names advertise coverage they don't
deliver (`set_auth` rejection, `live_session_created` via `create()`), and one
perf nit that doubles suite runtime. Fixing the names/removing the tautology
sharpen the suite without changing what it actually verifies.

---

## Fix summaries (addressed after review)

All four findings addressed; full suite still green and now runs in ~163 ms
(was ~3.1 s), 82 tests pass.

### Fix 1 — Removed the `SESSIONS_DIR` wiring tautology test

Deleted `SESSIONS_DIR is wired to the temp tree` from
`test/session-paths.test.js`. It asserted the module read the env var that the
test itself had just set — true by construction. `SESSIONS` is still used at
the top of the file to set `PI_CODING_AGENT_SESSION_DIR`, so no leftover
unused binding. Coverage of the real env-var fallback now comes implicitly
from every other test in the file running against the temp tree.

### Fix 2 — Renamed the `set_auth` test to match what it covers

`AUTH_CONFIGURED` is a load-time `const` computed from `TAU_USER`/`TAU_PASS`,
which this file always sets, so the `!AUTH_CONFIGURED` rejection branch
(`bin/tau.js:541`) cannot be hit without either a new test-only export
(expanding the existing `_setAuthForTest` hook surface) or re-loading the
module with cleared env (spawns a second HTTP server + ping interval).
Per the review's either/or, the lighter and honest fix was chosen: renamed to
`set_auth toggles the enabled flag when credentials are configured`. The test
body is unchanged.

### Fix 3 — Renamed the WS `live_session_created` test

The test never called `liveManager.create()` (which would spawn `pi`); it
manually invoked `liveManager.broadcast(...)`. Renamed to `manager
broadcasts are delivered to connected WS clients` and updated the inline
comment from "simulate" to "exercise the same broadcast path the manager
uses on create()". This is now honest about verifying WS delivery rather than
the create flow.

### Fix 4 — Replaced the real 1.5s SIGTERM waits with `t.mock.timers`

Both `terminate` escalation tests in `test/pi-rpc-session.test.js` now call
`t.mock.timers.enable({ apis: ['setTimeout'] })` and advance the clock with
`t.mock.timers.tick(1500)` instead of awaiting wall-clock time. `terminate` is
started as a non-awaited promise, the clock is ticked past the 1500 ms grace
wait, then the promise is awaited (`Promise.all([term, check])` for the
escalation test). `clearTimeout` is mocked automatically alongside
`setTimeout`, so the pending-command timer teardown in `terminate`/`send`
still works; the 100000 ms command timeout never fires because only 1500 ms
is advanced. Suite duration dropped from ~3143 ms to ~163 ms (~19×), with the
two tests themselves going from ~1500 ms each to sub-millisecond.

---

# Second-pass review — `chore: add tests.` (2627a98)

Scope: independent re-read of the committed test suite (8 test files, 82
tests, all green in ~186 ms via `npm test`). This pass focuses on the
user's question — *do the tests make sense, and are any of them tests
written for tests' sake (tautologies / coverage theater)?* I agree with
the first reviewer's four findings and their fixes; the items below are
additional issues the first pass missed.

## Do the tests make sense?

Mostly yes. The path-resolver files (`session-paths`, `live-session-path`),
the `PiRpcSession` state-machine tests, and the HTTP/WS server tests
exercise real production code against the real filesystem / a real `http`
server / a real `ws` client. Those would catch real regressions. The
issues below are confined to a handful of tests that either assert
JavaScript built-ins through one-line wrappers, or assert a hardcoded
constant against itself.

## Findings

### Title: Drop the `addClient/removeClient manage the client set` test

Body: `LiveSessionManager.addClient`/`removeClient` are one-line
delegations to `Set` (`bin/tau.js:241-242`):
```
addClient(ws) { this.clients.add(ws); }
removeClient(ws) { this.clients.delete(ws); }
```
The test (`test/live-session-manager.test.js:53-60`) asserts that after
`addClient`, `clients.size === 1`, and after `removeClient`, `clients.size
=== 0`. This verifies `Set.prototype.add`/`delete`, not tau logic. Every
other test in this file (`broadcast`, `broadcastUpdated`, `delete`,
`shutdown`, `removeExited`) already drives `addClient`/`removeClient` or
the client set through real behavior, so a regression in these wrappers
would surface elsewhere. It is a test of the language, not the product.

Location: `/home/milanglacier/Desktop/personal-projects/tau/test/live-session-manager.test.js:53-60`

### Title: `get_available_models` test asserts a hardcoded `[]` equals `[]`

Body: The production branch is
`if (cmd === 'get_available_models') return success({ models: [] });`
(`bin/tau.js:453`). The test
(`test/rpc-command.test.js:93-97`) calls the command and asserts
`deepEqual(resp.data.models, [])`. There is no logic, no state, and no
branching behind the return value — the implementation is a literal
constant. The test can only fail if someone rewrites the literal, and at
that point the assertion is verifying the new literal matches itself. It
locks in the API *shape* (a `models` array exists) but the name promises
"returns an empty list in standalone mode," which is a constant-equals-
itself check rather than behavioral coverage. Either rename to an
intentional shape-pin ("get_available_models response shape is
`{ models: [] }`") so the intent is honest, or drop it.

Location: `/home/milanglacier/Desktop/personal-projects/tau/test/rpc-command.test.js:93-97`

### Title: `set_auto_compaction` test verifies a no-op echo stub

Body: The production handler is
`if (cmd === 'set_auto_compaction') return success({ enabled: !!command.enabled });`
(`bin/tau.js:481`) — it persists nothing, toggles no state, and ignores
the session. The test
(`test/rpc-command.test.js:149-155`) sends `enabled: false` and asserts
`resp.data.enabled === false`, i.e. it checks that `!!false === false`.
The test name ("accepted as a backend-local command") is also inaccurate:
the branch sits *after* the `if (!session) return error('No active Tau
session…')` guard (`bin/tau.js:476`), so it requires a live session —
which is why the test has to call `injectSession()` first. As written the
test cannot catch a regression because there is no behavior behind the
stub. Either remove it, or fold it into a documented "stub commands
return their echoed payload" shape test alongside `get_available_models`.

Location: `/home/milanglacier/Desktop/personal-projects/tau/test/rpc-command.test.js:149-155`

### Title: Cross-origin WS test's `assert.rejects` predicate accepts any error

Body: `test/websocket.test.js:72-82` claims to verify a 403, but the
predicate passed to `assert.rejects` is `(err) => true`, so *any*
rejection passes — a 401, an `ECONNRESET`, a 404, or a genuine 403 all
satisfy it. The test effectively only checks "the upgrade does not
succeed," which is strictly weaker than the name advertises. The `ws`
client does not expose the HTTP status on the error event, so a strict
status assertion is hard here, but the test should at least assert that
the promise rejects (e.g. drop the always-true predicate and let
`assert.rejects` require a rejection), and the name should be softened to
"cross-origin WebSocket upgrade is rejected" so it no longer claims a
specific status code it cannot observe.

Location: `/home/milanglacier/Desktop/personal-projects/tau/test/websocket.test.js:72-82`

### Title: `list and get expose session metadata` half-tests a `Map.get` wrapper

Body: `LiveSessionManager.get` is `return this.sessions.get(id);`
(`bin/tau.js:247`). The assertion `assert.equal(mgr.get('nope'),
undefined)` (`test/live-session-manager.test.js:66`) verifies
`Map.prototype.get` returns `undefined` for a missing key — JavaScript
behavior, not tau logic. The `list()` half of the same test is
meaningful (it exercises `Array.from(...).map((s) => s.metadata())` and
the `.id` projection), so I'd keep the test but drop the
`get('nope') === undefined` line and rename to focus on `list`, or
replace the trivial `get` assertion with one that exercises `get`
returning the actual session object the test just inserted (which the
existing `assert.equal(mgr.get('tau_1'), s)` already does on the
preceding line — the `nope` line is the redundant one).

Location: `/home/milanglacier/Desktop/personal-projects/tau/test/live-session-manager.test.js:62-69`

## Overall assessment

**Verdict:** Needs minor revision.

**Explanation:** The suite is solid where it matters — resolvers, the RPC
session state machine, and the live HTTP/WS server all test real
behavior. The five findings above are isolated tautologies / oversold
assertions: two tests of JS built-ins through one-line wrappers
(`addClient`/`removeClient`, `get('nope')`), two tests of constant
echoes (`get_available_models`, `set_auto_compaction`), and one
predicate that makes the assertion vacuous (cross-origin WS 403).
Removing or renaming them sharpens the suite without losing any real
coverage, since the surrounding tests already exercise the same code
paths behaviorally.

---

## Second-pass fix summaries (addressed after the review above)

All five findings addressed; full suite still green and now runs in ~205 ms,
81 tests pass (was 82).

### Fix 1 — Dropped the `addClient/removeClient` tautology test

Deleted `addClient/removeClient manage the client set` from
`test/live-session-manager.test.js`. `addClient`/`removeClient` are one-line
delegations to `Set` (`bin/tau.js:241-242`), so the test only verified
`Set.prototype.add`/`delete`. Every other test in this file
(`broadcast`, `broadcastUpdated`, `delete`, `removeExited`, `shutdown`)
already drives the client set through real behavior, so a regression in the
wrappers would still surface there.

### Fix 2 — Renamed the `get_available_models` test to an honest shape-pin

Renamed to `get_available_models response shape is { models: [] }` in
`test/rpc-command.test.js`. The production branch
(`bin/tau.js:453`) returns a hardcoded `[]`, so the assertion is a
constant-equals-itself check that pins the response shape rather than any
behavior. The new name says exactly that. The body is unchanged.

### Fix 3 — Renamed the `set_auto_compaction` test to reflect what it covers

Renamed to `set_auto_compaction echoes the enabled flag without persisting
state` in `test/rpc-command.test.js`. The handler
(`bin/tau.js:481`) is a no-op echo (`!!command.enabled`), and the branch
sits after the `if (!session)` guard so it requires a live session —
contradicting the old "backend-local command" name. The new name is honest
about the stub-echo nature; the body is unchanged.

### Fix 4 — Softened the cross-origin WS test name and dropped the vacuous predicate

Renamed `cross-origin WebSocket upgrade is rejected with 403` to
`cross-origin WebSocket upgrade is rejected` in
`test/websocket.test.js`, and removed the `(err) => true` predicate from
`assert.rejects` so a plain rejection is required (matching the weakened
name). The `ws` client does not expose the HTTP status on the error event,
so a strict 403 assertion is not feasible; added an inline comment stating
that. The assertion now fails if the upgrade ever succeeds, which is the
actual invariant under test.

### Fix 5 — Dropped the redundant `get('nope') === undefined` line

Removed `assert.equal(mgr.get('nope'), undefined)` from the `list and get
expose session metadata` test in `test/live-session-manager.test.js`. It
verified `Map.prototype.get` on a missing key — JavaScript behavior, not
tau logic. The meaningful `get` assertion (`mgr.get('tau_1') === s`, which
exercises the wrapper returning the actual inserted session) and the
`list()` assertions remain, so the test still covers the real projections.
