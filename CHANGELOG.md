# Changelog

## [Unreleased]

### Changed

- Switching back to a tab you already opened shows its conversation almost at once, at the same scroll position, including anything that arrived while it was hidden.
- Large sessions show their newest messages sooner and fill in older history faster, and long sessions no longer freeze the page while they load.

## [1.2.0] - 2026-11-02

### Added

- Every open session appears at the top of its project with a green dot, and projects with open sessions move to the top of the sidebar.

### Fixed

- Every compaction appears in the transcript from start to finish, `/compact` runs compaction instead of reaching the model, and the auto-compaction setting changes Pi's real setting.
- A message queued before automatic compaction starts stays queued until the original reply finishes.
- HTML in assistant replies and compaction summaries is shown as text, and Markdown links, images, and nested Markdown no longer run scripts.
- Session titles in the sidebar are shown as plain text, and new sessions stay highlighted before Pi reports their file paths.

## [1.1.10] - 2026-10-25

### Added

- `--pi-command` and `TAU_PI_COMMAND` run a different Pi executable, such as a fork like pi-bolt.

## [1.1.9] - 2026-10-25

### Added

- The sidebar shows the 10 newest sessions per project with a "Show all" row, and each project has a + button that opens the New Tau Tab popup with that project filled in.

### Fixed

- The open session stays visible when live tabs change, and message matches survive deleting a session.

## [1.1.8] - 2026-10-19

### Fixed

- Provider errors appear in the chat where the reply stopped and stay visible when the session is reopened, while retries show progress instead of hiding the failure.

## [1.1.7] - 2026-10-19

### Added

- Built-in bash, edit, read, and write calls render in readable task-specific views instead of raw JSON, including when nested inside codemode.

### Fixed

- Long file paths wrap instead of hiding the file name or pushing Copy code out of view.

## [1.1.5] - 2026-10-16

### Added

- The New Tau Tab popup suggests directories and models while you type, without replacing the text already entered.

### Fixed

- Suggestions stay tied to the current input, so Tab cannot replace newer text with an unrelated path.

## [1.1.3] - 2026-10-14

### Fixed

- Streamed thinking stays inside the thinking block when an assistant message ends without visible text.

## [1.1.2] - 2026-10-01

### Added

- codemode calls render as highlighted JavaScript, and nested tool calls appear inside their parent card in live sessions and saved history.

### Changed

- Supports Pi 1.x.

## [1.1.0] - 2026-09-21

### Breaking Changes

- Requires Pi 0.86 or newer.

### Changed

- Opening a large session shows the newest messages immediately and fills in older history progressively without moving the reading position, including in Safari.

### Fixed

- Queued instructions keep their order across reconnects and no longer lock a session or run twice when a dispatch or completion event is lost.
- An unanswered permission dialog can be answered from another browser or after a reconnect, and Abort stops a waiting turn instead of claiming success.
- Running Tau from its package directory starts the server, and importing Tau from standard input no longer crashes.

## [1.0.14] - 2026-07-24

### Changed

- Supports Pi up to 0.89.

## [1.0.13] - 2026-07-21

### Changed

- Supports Pi 0.81.

### Fixed

- The Enter key that confirms an input-method composition commits the composed text instead of sending the message, and global shortcuts no longer fire while composing.
- The tab bar and model picker show the session's real model as soon as a tab is created or resumed.

## [1.0.9] - 2026-07-17

### Added

- Initial release as a standalone web server for Pi. It runs multiple live Pi RPC sessions in parallel in one browser page, with a saved-session browser and search, a session tree for branching, mobile support, and optional HTTP Basic Auth.
