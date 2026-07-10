# Pi Tau Web Server

**Browser workspace for [Pi](https://github.com/milanglacier/pi-tau-web-server) — a standalone web server that manages multiple live Pi RPC sessions in parallel.**

Pi Tau Web Server is a fork of [deflating/tau](https://github.com/deflating/tau), forked at
[`5e2bce39`](https://github.com/deflating/tau/tree/5e2bce39) and rewritten from
a Pi extension that ran inside the Pi TUI into a standalone Node.js web server.
Instead of living inside a TUI session, Tau runs one backend process and spawns
headless `pi --mode rpc` child processes — one per in-page Tau tab — so you can
work with multiple Pi sessions side by side in your browser.

## Key differences from `5e2bce39`

| Area                  | Upstream (`5e2bce39`)                                                                         | This fork                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Architecture**      | Pi extension loaded inside the Pi TUI process; browser displayed a single running TUI session | Standalone Node.js server that spawns independent `pi --mode rpc` child processes                              |
| **Multiple sessions** | Not supported                                                                                 | In-page tabs each backed by their own Pi RPC subprocess; run N sessions in parallel                            |
| **Session lifecycle** | Tied to the Pi TUI session — close the TUI and the browser view died                          | Sessions are server-owned; closing/reloading the browser does not kill Pi children                             |
| **Pi communication**  | In-process Pi extension API                                                                   | Out-of-process JSON line-delimited RPC over stdin/stdout                                                       |
| **UI dialogs**        | `ctx.ui.confirm/input/select` shown in TUI only; not forwarded to the browser                 | All forwarded to the browser — extensions that use these built-in UI interfaces work seamlessly in the browser |
| **Test coverage**     | Javascript and No tests                                                                       | Typescript + Full test suite                                                                                   |
| **Auto-start**        | Extension auto-started inside Pi unless `TAU_DISABLED=1`                                      | Always explicit — the user runs `pi-tau-web-server` when they want it                                          |

### Enhancements in this branch compared with `main`

This branch also includes various enhancements over `main`, including a session-tree and branching interface that mirrors Pi TUI's `/tree` command. Open **Session tree** from the header or command palette to inspect every branch and continue from any earlier point; selecting a user message restores it to the composer so it can be edited and submitted as a new branch.

![Tau light mode](docs/images/main-page.jpg)

![Tau dark mode](docs/images/main-page-dark.jpg)

![New tab modal](docs/images/new-tab.jpg)

![Commands](docs/images/commands.png)

![Model completion](docs/images/model-completion.jpg)

![Settings](docs/images/settings.png)

![Mobile main page](docs/images/mobile-main-page.jpeg)

![Mobile sidebar](docs/images/mobile-side-bar.jpeg)

## What it does

- **Standalone server** — run `pi-tau-web-server`; it serves the web UI and manages Pi RPC child processes as subprocesses via `pi --mode rpc`
- **Multiple live sessions** — in-page Tau tabs (not browser tabs) each represent a live Pi RPC session. Create, switch, and close them from one browser page. Tau runs all of them in parallel.
- **Session persistence while the server runs** — closing or reloading the browser does not kill Pi child sessions; only closing an in-page Tau tab or shutting down the Tau server does
- **Works on any device** — open the same Tau server from your phone, tablet, or another monitor
- **Session history browser** — view saved Pi JSONL session files, search across all sessions by message content
- **WebSocket-based client-server architecture** — the browser connects to Tau over HTTP and WebSocket; Tau communicates with Pi processes over JSON line-delimited RPC over stdin/stdout

## Install

```bash
npm install -g git+https://github.com/milanglacier/pi-tau-web-server.git#main
```

## Usage

```bash
pi-tau-web-server
```

Open the printed URL (default `http://localhost:3001`). Click `+` in the tab bar or sidebar to create an in-page Tau tab, choose or type a project directory, optionally enter a Pi `/model`-style model string, then chat.

```bash
pi-tau-web-server --host 127.0.0.1 --port 3001 --open
TAU_PORT=3001 TAU_HOST=0.0.0.0 TAU_PROJECTS_DIR="$HOME/projects" pi-tau-web-server
```

## Containers

The container launcher runs one isolated Tau service per instance name. Docker
and Podman are supported; set `TAU_CONTAINER_RUNTIME` to select one explicitly.
The image is built automatically on the first run, or it can be built ahead of
time:

```bash
container/tau-container build
```

Start an instance with credentials in the environment:

```bash
TAU_USER=alice TAU_PASS='choose-a-password' \
  container/tau-container run personal-workspace --port 3001
```

Missing credentials are prompted for, with the password input hidden. Start
additional isolated instances by giving each one a different name and host
port:

```bash
container/tau-container run work-workspace --port 3002
container/tau-container status
container/tau-container logs work-workspace
container/tau-container stop work-workspace
```

Each instance has an isolated `~/projects` directory inside the container,
available at `/state/home/projects`. It is mounted read-write from the
instance's `projects/` state directory.

On an instance's first launch, the launcher copies
`${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}` into that instance's writable state.
Symlinks are dereferenced on the host. The host `sessions/`, `npm/`, and `git/`
directories are excluded. Package declarations remain in `settings.json`, so Pi
installs missing npm/git packages when its first RPC session starts.

The copied configuration is never refreshed automatically. Changes made by Pi
or Tau therefore survive container recreation and remain isolated from other
instances. Projects and session files are also stored separately per instance.
By default, state is kept under:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/pi-tau-web-server/instances/<instance>/
```

The host-side projects directory is `<instance>/projects/` beneath that path.
Override the state root with `TAU_CONTAINER_STATE_DIR`.

Ports bind to all host interfaces by default. HTTP Basic Auth does not encrypt
credentials or traffic, so use a TLS reverse proxy for access from another
machine. Pass `--bind 127.0.0.1` to restrict an instance to local access.

## Features

### Chat

- Full markdown rendering with syntax-highlighted code blocks
- Streaming responses with typing indicator
- Image attachments (paste, drag & drop, or button)
- Copy any message with one click
- Inline diff viewer for edit tool calls
- Message queuing while the agent is working

### Live Session Management

- Backend-owned live Pi RPC sessions, each backed by a `pi --mode rpc` subprocess
- JupyterLab-style in-page Tau tab strip — each tab is an independent Pi session
- Browser reload or reconnect restores live Tau tabs from the backend
- Multiple browser clients see the same live session list
- Historical sessions remain read-only
- **Session tree and branching** — inspect the active session's full tree and jump to any earlier entry, mirroring Pi TUI's `/tree` behavior; choose a user message to restore it to the composer and create a new branch

### Model & Thinking

- Optional model string at session creation using Pi `/model` syntax (e.g. `openai/gpt-5.5:high`)
- Per-session model picker with fuzzy search
- Per-session thinking level controls
- Token usage percentage with context window visualiser
- Cost tracking per session

### File Browser

- Right sidebar rooted at the active live session's working directory
- Navigate directories, open files natively
- Drag files onto the input to insert their path

### Session Browser

- Sidebar with all saved Pi JSONL session files, grouped by project
- Full-text search across all historical sessions with highlighted snippets
- Rename sessions, export to HTML

### Mobile Support

- Slide-over sidebar with swipe-from-edge gesture
- Slimmed header, model picker stays accessible
- Larger touch targets and font sizes optimized for mobile
- Auto-reconnect WebSocket on return from background
- PWA: installable as a standalone app on iOS, Android, and macOS

### Themes

Six built-in themes: Dusk (clean neutral dark, default), Dawn (warm blue dark), Midnight (OLED black), Clean (Apple-style light with cyan-blue accents), Terracotta (warm light), Sage (warm olive-green). All with frosted glass header and input area.

## Configuration

### CLI flags

| Flag                                  |                                                  Description |
| ------------------------------------- | -----------------------------------------------------------: |
| `--open`                              |                 Open the URL in the default browser on start |
| `--port` / `TAU_PORT`                 |                                Server port (default: `3001`) |
| `--host` / `TAU_HOST`                 |                            Bind address (default: `0.0.0.0`) |
| `--projects-dir` / `TAU_PROJECTS_DIR` | Directory scanned for project chips in the new-session modal |

### Environment variables

| Variable           |     Default |                                              Description |
| ------------------ | ----------: | -------------------------------------------------------: |
| `TAU_PORT`         |      `3001` |                                              Server port |
| `TAU_HOST`         |   `0.0.0.0` |                                             Bind address |
| `TAU_PROJECTS_DIR` |    _(none)_ | Directory scanned for project chips in the new-tab modal |
| `TAU_STATIC_DIR`   | _(bundled)_ |                               Override static files path |
| `TAU_USER`         |    _(none)_ |                                 HTTP Basic Auth username |
| `TAU_PASS`         |    _(none)_ |                                 HTTP Basic Auth password |
| `TAU_COOKIE_SECRET`| _(generated)_ |            Secret that signs session cookies (optional) |

Tau also reads matching values from `~/.pi/agent/settings.json` under the `tau` key (`host`, `port`, `projectsDir`, `user`, `pass`, `authEnabled`, `cookieSecret`).

### Authentication

Tau Web Server supports optional HTTP Basic Auth. Set credentials in `~/.pi/agent/settings.json` or via environment variables, then toggle "Require login" in Tau Settings.

```json
{
  "tau": {
    "user": "pi",
    "pass": "your-password"
  }
}
```

Both HTTP and WebSocket connections are gated when enabled. `/api/health` remains open for monitoring.

After the first successful Basic login, the server sets a signed `HttpOnly` session cookie and accepts it in place of the Authorization header. This keeps mobile browsers (notably iOS Safari and the installed PWA, which evict cached Basic credentials whenever you switch apps) from re-prompting for the password every time you return to the app. The cookie is scoped to the browser session — killing the browser ends it and the Basic prompt appears again — and the token inside it expires after 12 hours of inactivity, renewing itself while the app is in use. Changing the password invalidates every outstanding cookie on all devices, and deleting the auto-generated `cookieSecret` from `~/.pi/agent/settings.json` force-logs-out all devices at once.

## How it works

```
┌─────────────┐     ┌──────────────────────────┐     ┌───────────────────────────┐
│  Browser    │◄───►│  Tau Web Server          │◄───►│  pi --mode rpc            │
│  (Tau UI)   │     │  HTTP + WebSocket +      │     │  child session 1          │
│             │     │  LiveSessionManager      │     ├───────────────────────────┤
│             │     │  (Node.js)               │     │  pi --mode rpc            │
│             │     │                          │     │  child session 2          │
│             │     │                          │     ├───────────────────────────┤
│             │     │                          │     │  pi --mode rpc            │
│             │     │                          │     │  child session (N)        │
└─────────────┘     └──────────────────────────┘     └───────────────────────────┘
```

The browser connects to Tau Web Server over WebSocket (and HTTP for history and API calls). Tau manages a pool of `PiRpcSession` instances, each of which spawns a `pi --mode rpc` subprocess. Communication with Pi is over JSON line-delimited RPC via stdin/stdout. Closing an in-page Tau tab sends a DELETE request that terminates the corresponding Pi child. Shutting down Tau terminates all managed children.

## Development

### Prerequisites

- [Pi](https://github.com/badlogic/pi-mono) must be installed (`pi` on `PATH`)
- Node.js and npm

### Setup

```bash
git clone https://github.com/milanglacier/pi-tau-web-server.git
cd pi-tau-web-server
npm install
npm run build
npm link
pi-tau-web-server --projects-dir ~/code
```

The project is written in TypeScript, with separate `tsconfig.json` files:

| Config                 |                                       Targets |
| ---------------------- | --------------------------------------------: |
| `tsconfig.server.json` |     Server-side code (`src/server/` → `bin/`) |
| `tsconfig.public.json` | Browser-side code (`src/public/` → `public/`) |
| `tsconfig.test.json`   |                          Test files (`test/`) |

Compiled JS is not committed to git (see `.gitignore`). Always run `npm run build` (or `tsc -p <config>`) after editing TypeScript source.

Edit `public/` files and refresh the browser. Restart `pi-tau-web-server` after changing server code in `src/server/`.

### Tests

```bash
npm test
```

The test suite uses Node.js built-in `node --test` and covers session-file path validation, the `PiRpcSession` state machine, `LiveSessionManager`, the `/api/rpc` shim, HTTP + WebSocket server surface (including same-origin/CORS hardening and malformed-URL hardening), and WebSocket auth gating.

Each test file points `PI_CODING_AGENT_DIR` at an isolated temp tree so real Pi settings and sessions are never touched. The `LiveSessionManager` tests replace the real `spawn` with a test stub.

### Project structure

```
├── bin/            # Compiled server-side JS
├── public/         # Compiled browser-side JS, HTML, CSS, icons
├── src/
│   ├── server/     # Server TypeScript source
│   │   ├── server-main.ts   # HTTP server, WebSocket, API routes
│   │   ├── sessions.ts      # PiRpcSession + LiveSessionManager
│   │   ├── model-utils.ts   # Model parsing and formatting
│   │   ├── config.ts        # Settings, paths, CLI args
│   │   └── types.ts         # Shared type definitions
│   └── public/     # Browser TypeScript source
│       ├── app.ts, app-main.ts, state.ts, themes.ts, ...
│       └── websocket-client.ts
├── test/           # Node.js test files
├── docs/           # Screenshots and documentation
└── extras/         # Extra utilities
```

## License

MIT
