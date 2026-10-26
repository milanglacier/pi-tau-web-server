# Plan: show compaction clearly in the transcript and make `/compact` work

Branch: `fix/compaction-behavior`

## Goal

The user should always know when Pi is compacting the context, why it started,
how it ended, and where in the conversation it happened. This holds whether the
user started it (command palette, header button, or typing `/compact`) or Pi
started it on its own (context nearly full, or context overflow).

## Findings

The three reported problems are all real. Each was checked against Tau's code
and the installed Pi (`@earendil-works/pi-coding-agent` 1.4.0).

### 1. Clicking "Compact" gives almost no feedback (true)

- The palette item and the header "Compact" button call
  `rpcCommand({ type: 'compact' }, 'Compacting...')`. The only feedback is the
  small status text in the footer, which flips to "Done" or an error and then
  disappears after 2–3 seconds.
- The transcript was meant to show a "Compacting context…" row, but that row
  never appears (see finding 2).
- During a manual compaction Pi does not send `agent_start`, so Tau treats the
  tab as idle. The Stop button is hidden, the input stays enabled, and the
  live tab shows no activity.
- If the user sends a message while the manual compaction runs, Pi rejects it
  ("Cannot submit a prompt while compaction is in progress"). Tau already drew
  the message as sent, and it ignores the rejection: replies to commands sent
  over the WebSocket go to an `rpcResponse` event that nothing listens to. The
  message looks sent but is lost.
- The server forwards `compact` with a 60 second timeout. Summarizing a large
  context with a slow model can take longer. The browser then shows a timeout
  error while Pi keeps compacting and later succeeds.
- If a reply is running, Pi's `compact` first aborts that reply. Tau does not
  warn the user about this.

### 2. Automatic compaction is invisible (true)

- Tau handles `auto_compaction_start` and `auto_compaction_end`. Pi renamed
  these long ago to `compaction_start` and `compaction_end`, now sent for every
  compaction with `reason` set to `"manual"`, `"threshold"`, or `"overflow"`.
  The installed Pi binary contains no `auto_compaction_*` event at all, so
  Tau's handlers are dead code.
- Automatic compaction runs inside an agent operation (before
  `agent_settled`), so the user only sees the usual typing indicator. A long
  pause with no explanation is all they get.
- Even if the old handler ran, it would be wrong for the current event: it
  reads `event.summary` (now `event.result.summary`), shows "✓ Context
  compacted" for failures and cancels too, and puts the summary into
  `innerHTML` without escaping.
- Nothing about a compaction is kept. The server's live `entries` list only
  records messages, and the history renderer skips `compaction` entries from
  the session file. Switching tabs, reloading, or reopening a saved session
  shows no sign that the context was compacted.

### 3. Typing `/compact` sends it to the model (true)

- `sendMessage` always sends a `prompt`. Pi's RPC `prompt` only handles
  extension commands, prompt templates, and `/skill:` commands. Built-in
  commands such as `/compact` exist only in Pi's terminal UI, as Pi's RPC
  docs state. `/compact` therefore reaches the model as plain text.

### Other problems found

- **The auto-compaction setting does nothing.** The server answers
  `set_auto_compaction` with success without telling Pi, and its `get_state`
  always reports `autoCompactionEnabled: true`. The toggle in Settings flips
  visually and has no effect. This is left over from when Tau was an
  extension. In Pi this setting is global: it is saved to the user's Pi
  settings file and applies to every Pi session, including the terminal UI.
- **Compaction retries are not shown.** Pi sends
  `summarization_retry_scheduled` and related events when the summary request
  fails and is retried. Tau ignores them.
- **The context pill goes blank after compaction.** Tau resets the token count
  to 0, so the pill falls back to the session cost until the next reply. Pi's
  `compaction_end` includes `estimatedTokensAfter`, which could fill this gap.

## Should compaction appear in the transcript?

Yes. The transcript is where the user is already looking, and compaction
changes what the model remembers, so its place in the conversation matters.
Pi's own terminal UI does the same: it shows a status line while compacting
and adds a compaction summary block to the chat afterwards. The footer status
text is too small and too short-lived for an operation that can take a minute.

## Decisions

- One transcript row represents one compaction. It is created on
  `compaction_start` and updated in place until `compaction_end`. After it
  ends it stays in the transcript as a divider.
- The running row says why compaction started:
  - manual: "Compacting context…"
  - threshold: "Context is nearly full. Compacting automatically…"
  - overflow: "Context overflowed. Compacting…"
  `compaction_start` carries only the reason, so whether Pi will retry the
  reply is known only when compaction ends.
  It also shows how long it has been running, so a slow compaction does not
  look stuck.
- The finished row reflects the real outcome:
  - success: "Context compacted · 150k → ~32k tokens", with the summary in a
    collapsed section that the user can expand. When `willRetry` is true, the
    row adds "Retrying the reply…". The summary is rendered with
    the existing markdown renderer, never inserted as raw HTML.
  - cancelled: "Compaction cancelled".
  - failed: Pi's `errorMessage` in the error style, for example
    "Compaction failed: Nothing to compact (session too small)".
- While a compaction runs, the tab counts as busy, the same as a running
  reply:
  - the Stop button is shown and stops the compaction (Pi's `abort` also
    aborts compaction);
  - the live tab shows activity;
  - messages typed meanwhile go into Tau's existing local queue and are sent
    after compaction ends. This matches Pi's terminal UI, which also queues
    input during compaction.
- The browser drives the row from events only. The reply to the `compact`
  command is used only to report errors that happen before Pi starts
  compacting, such as no live tab. The server allows the `compact` command a
  much longer timeout (10 minutes), so a slow compaction is not reported as
  failed.
- `/compact` typed in the chat box runs compaction instead of being sent to
  the model. Text after it becomes Pi's `customInstructions`, matching Pi's
  terminal UI (`/compact focus on the API changes`). Only an exact `/compact`
  or `/compact ` followed by text is recognized. Everything else starting
  with `/` goes to Pi unchanged, so extension commands, prompt templates and
  skills keep working.
- Tau refuses to compact while a reply is running. Pi's `compact` aborts the
  running reply first, and Pi's terminal UI allows this, but in Tau a click
  should never throw away a reply by accident. Tau shows an inline note "Wait
  for the reply to finish, or stop it first." This applies to the palette,
  the header button, and `/compact`. The typed `/compact` text stays in the
  input so the user can send it again once the reply ends.
- The auto-compaction setting changes Pi's real setting. Tau forwards
  `set_auto_compaction` to Pi and reads the real value from Pi's
  `get_state`. The Settings row says that this is the global Pi setting,
  used by all Pi sessions including the terminal UI.

## Part 1: server

- Track compaction state per live session from `compaction_start` and
  `compaction_end`: whether it is running, the reason, and the start time.
  Include this in the session metadata and snapshot so every browser, a
  reload, and a tab switch can show a compaction that is still running.
- On a successful `compaction_end`, add a `compaction` entry to the session's
  live `entries` with the same fields Pi saves in the session file (summary,
  `tokensBefore`, timestamp), plus `estimatedTokensAfter` and the reason.
  Snapshots then show the divider, the same as a session loaded from file.
- Give the `compact` command a long timeout instead of the general 60 seconds.
- Clear the compaction state if the Pi process exits, so a tab never stays
  "compacting" forever.
- Forward `set_auto_compaction` to Pi and report Pi's real
  `autoCompactionEnabled` from `get_state`. Each Pi process holds its own
  copy of the settings, so other running tabs may still use the old value,
  and the Settings row reads the value from the tab being viewed.

## Part 2: browser, live events

- Replace the `auto_compaction_*` handlers with `compaction_start` and
  `compaction_end` handlers that create and update the transcript row
  described above.
- Show `summarization_retry_scheduled` in the running row, for example
  "Summary request failed. Retrying in 2s (attempt 1/3)…". Ignore
  `source: "branchSummary"`, which belongs to tree navigation.
- Count a running compaction as pending work for the tab, so the Stop button,
  the live tab activity, and the local message queue behave as described.
  Flush the queue after `compaction_end`. When `willRetry` is true, Pi
  continues the reply first, and the queue waits for `agent_settled` as usual.
- When a snapshot arrives for a tab with a running compaction, draw the
  running row at the end of the transcript.
- After a successful compaction, show the context pill from
  `estimatedTokensAfter`, marked as an estimate (for example "~16%"), until the
  next reply reports real usage.
- Hide the header "Compact" button while a compaction runs.

## Part 3: browser, `/compact` and the Compact actions

- Put the recognition of `/compact` and its instructions in a small pure
  function under `src/public/`, so it can be unit tested.
- In `sendMessage`, a recognized `/compact` clears the input, does not draw a
  user message, and starts compaction through the same path as the palette.
  Images or attached files with `/compact` are refused with an inline note,
  since compaction cannot use them.
- The palette item and header button use the same path. If the tab is busy,
  they show the "wait or stop first" note and send nothing.
- Surface a rejected `prompt` sent over the WebSocket as an inline error. Today
  the rejection is dropped, which is how the lost message in finding 1
  happens. With the queue change it should be rare, but a rejection must
  never be silent.

## Part 4: saved history

- `buildHistoryItems` turns each `compaction` entry into the same finished
  divider row used live, with the summary collapsed. Pi writes the entry after
  the messages it kept, so placing the divider at the entry's position marks
  the moment compaction happened.
- Earlier messages stay visible above the divider. Hiding them would make the
  transcript hard to read back. The divider makes clear that the model only
  sees the summary of what came before it (and the kept messages).

## Tests

- Unit tests for the `/compact` recognizer: plain `/compact`, with
  instructions, extra spaces, `/compactor` and `/compact-foo` not recognized,
  other slash commands left alone.
- Server unit tests (`test/live-session-manager.test.ts`): compaction state
  set and cleared by the events, metadata and snapshot include it, a
  successful compaction adds an entry, failure and cancel do not, process exit
  clears the state.
- History unit tests (`test/history-render.test.ts`): a `compaction` entry
  becomes a divider with its summary; summary text containing HTML is shown as
  text.
- End-to-end tests with a fixture provider like
  `test/fixtures/permission-rpc-provider.ts` that also returns a summary, and a
  small context window so automatic compaction triggers:
  - palette Compact shows the running row and then the finished divider;
  - `/compact keep the API notes` runs compaction and is not shown as a user
    message;
  - automatic compaction during a reply shows the threshold wording;
  - a message typed during compaction is queued and sent afterwards;
  - Compact during a running reply shows the "wait or stop first" note, the
    reply keeps running, and a typed `/compact` stays in the input;
  - the auto-compaction toggle shows Pi's real value and changes it (point
    Pi at a temporary agent directory so the user's settings are untouched);
  - Stop during compaction shows "Compaction cancelled";
  - reloading during a slow compaction still shows the running row.
  Keep the new file within the suite's time budget (about 35 seconds total).
- Run `npm run typecheck`, `npm test`, and `npm run test:e2e`.

## Out of scope

- Other Pi terminal-only commands typed in the chat box (`/tree`, `/export`,
  `/name`, and so on). The `/compact` recognizer can be extended later.
- Slash command autocompletion in the chat box.
- Showing the cost of generating the summary.
- Branch summaries from tree navigation.
