# Tau

Standalone web UI for [Pi](https://github.com/badlogic/pi-mono) RPC sessions. Tau runs one backend server and manages multiple headless `pi --mode rpc` child sessions. In-page Tau tabs (not browser tabs) represent live Pi sessions.

![Tau dark mode](docs/images/dark.png)

![Tau terracotta theme](docs/images/terracotta.png)

![Settings](docs/images/settings.png)

![Commands](docs/images/commands.png)

## What it does

Tau gives you a browser workspace for Pi:

- **Standalone server** — run `tau`; it serves the UI and manages Pi RPC child processes
- **In-page Tau tabs** — create, switch, and close multiple live Pi sessions from one browser page
- **Session persistence while the server runs** — closing/reloading the browser does not kill Pi sessions
- **Explicit lifecycle** — closing an in-page Tau tab terminates that Pi child; shutting down Tau terminates all managed children
- **Works on any device** — open the same Tau server from phone, tablet, or another monitor
- **Session browser** — view saved Pi JSONL session history

## Install

```bash
npm install -g git+https://github.com/deflating/tau.git#main
```

## Usage

```bash
tau
```

Open the printed URL (default `http://localhost:3001`). Click `+` to create an in-page Tau tab, choose/type a project directory, optionally enter a Pi `/model`-style model string, then chat.

Useful flags/env:

```bash
tau --host 127.0.0.1 --port 3001 --projects-dir ~/code --open
TAU_PORT=3001 TAU_HOST=0.0.0.0 tau
```

## Features

### Chat
- Full markdown rendering with syntax-highlighted code blocks
- Streaming responses with typing indicator
- Image attachments (paste, drag & drop, or button)
- Copy any message with one click
- Inline diff viewer for edit tool calls
- Message queuing while the agent is working

### Live Session Management
- Backend-owned live Pi RPC sessions
- JupyterLab-style in-page Tau tab strip
- Browser reload/reconnect restores live Tau tabs from the backend
- Multiple browser clients see the same live-session list
- Historical sessions remain read-only

### Model & Thinking
- Optional model string at session creation using Pi `/model` syntax
- Per-session thinking level controls
- Token usage percentage with context visualiser
- Cost tracking per session

### File Browser
- Right sidebar rooted at the active live session cwd
- Navigate directories, open files natively
- Drag files onto the input to insert their path

### PWA
- Installable as a standalone app on iOS, Android, and macOS
- Custom app icons
- Service worker with network-first caching

## Configuration

Environment variables:

| Variable | Default | Description |
|---|---:|---|
| `TAU_PORT` / `TAU_MIRROR_PORT` | `3001` | Server port |
| `TAU_HOST` | `0.0.0.0` | Bind address |
| `TAU_PROJECTS_DIR` | *(none)* | Directory scanned for project chips in the new-tab modal |
| `TAU_STATIC_DIR` | *(bundled)* | Override static files path |
| `TAU_USER` | *(none)* | HTTP Basic Auth username |
| `TAU_PASS` | *(none)* | HTTP Basic Auth password |

Tau also reads matching values from `~/.pi/agent/settings.json` under `tau` (`host`, `port`, `projectsDir`, `user`, `pass`, `authEnabled`).

### Authentication

Tau supports optional HTTP Basic Auth. Set credentials in `~/.pi/agent/settings.json` or via env, then toggle “Require login” in Tau Settings.

```json
{
  "tau": {
    "user": "pi",
    "pass": "your-password"
  }
}
```

Both HTTP and WebSocket connections are gated when enabled. `/api/health` remains open for monitoring.

## How it works

```
┌─────────────┐     ┌──────────────────────────────┐     ┌─────────────────┐
│  Browser    │◄───►│  Tau standalone server       │◄───►│ pi --mode rpc   │
│  (Tau UI)   │     │  HTTP + WS + session manager │     │ child sessions  │
└─────────────┘     └──────────────────────────────┘     └─────────────────┘
```

Tau spawns child processes with `TAU_DISABLED=1` to prevent old extension autostart recursion.

## Development

```bash
git clone https://github.com/deflating/tau.git
cd tau
npm link
tau --projects-dir ~/code
```

Edit `public/` and refresh the browser. Restart `tau` after changing `bin/tau.js`.

### Tests

Tau ships with a Node.js test suite (`node --test`) covering the standalone
backend: helper functions, session-file path validation, the `PiRpcSession`
state machine, the `LiveSessionManager`, the `/api/rpc` shim, and the HTTP +
WebSocket server surface (including the same-origin/CORS and malformed-URL
hardening).

```bash
npm test
```

The server module is import-safe: requiring `bin/tau.js` does not start a
listener or install process signal handlers — those run only when invoked as
`node bin/tau.js` (the `tau` bin). Each test file points `PI_CODING_AGENT_DIR`
at an isolated temp tree so real Pi settings/sessions are never touched.

## License

MIT
