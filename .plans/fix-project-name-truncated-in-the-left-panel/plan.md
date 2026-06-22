---
status: COMPLETED
---

# Fix Project Name Truncated In The Left Panel

## Problem

The Tau web left sidebar displays the current project group as `scratch` when the real project directory is `~/Desktop/personal-projects/agent-scratch`.

The frontend only renders the last segment of `project.path`, which is reasonable when `project.path` is accurate. The bad value is produced by the backend while reconstructing project paths from Pi session storage directory names:

```ts
dir.name.replace(/^--/, '/').replace(/--$/, '').replace(/-/g, '/')
```

That decode treats every hyphen as a path separator. A storage directory representing `.../agent-scratch` is reconstructed as `.../agent/scratch`, so the sidebar's last-segment display becomes `scratch`.

## Root Cause

The session directory name is a lossy fallback encoding for display purposes. It cannot safely reconstruct real filesystem paths when a directory name itself contains hyphens.

The session JSONL header already carries the real cwd (`entry.cwd`). That is the canonical project path and should be used wherever Tau needs to show or match a project path.

## Fix Plan

1. Add a header-cwd reader for session JSONL files so APIs that do not parse the whole session can still use the canonical project path.
2. Update `/api/sessions` to group and return project paths using parsed session `cwd`.
3. Update `/api/projects` to match session counts/activity against the session header `cwd`, so hyphenated project directories under `--projects-dir` still show their history correctly.
4. Update `/api/search` to return the header `cwd` in each result's `project` field.
5. Add regression coverage for `agent-scratch` so the API returns the full hyphenated project path instead of a split path ending in `scratch`.

## Expected Outcome

For a session whose header says:

```json
{"type":"session","cwd":"/Users/northyear/Desktop/personal-projects/agent-scratch"}
```

the `/api/sessions` project path remains `/Users/northyear/Desktop/personal-projects/agent-scratch`, and the existing sidebar last-segment rendering displays `agent-scratch`.

Existing sessions without a usable header `cwd` keep their encoded `dirName` for file lookup, but Tau does not pretend the lossy storage directory name can recover a real project path.

## Review Findings (latest commit)

### Finding 1: Preserve per-directory lookup for sessions without cwd

**Body**: In `serveSessionsList`, `const projectPath = parsed.cwd || ''` makes every older session whose header lacks a usable `cwd` share the same project entry, and only the first such directory's `dirName` is retained. The client loads historical sessions with `project.dirName` plus `session.file`, so a no-cwd session from a later storage directory will request `/api/sessions/<first-dir>/<that-file>` and return 404 or the wrong file; this regresses the stated fallback case for existing sessions without header cwd.

**Location**: `/Users/northyear/Desktop/personal-projects/tau/src/server/server-main.ts:508-514`

### Finding 2: Count `/api/projects` sessions by each file's header cwd

**Body**: `serveProjectsList` reads only the first non-null session header cwd in a storage directory and then assigns `files.length` and the directory-wide `lastActive` to that one project. Because the storage directory encoding is lossy, a single directory can contain JSONL files whose headers name different real cwd values, such as paths that differ by `agent-scratch` versus `agent/scratch`; in that case `/api/projects` attributes all sessions to whichever header was encountered first while the other project shows zero or stale history.

**Location**: `/Users/northyear/Desktop/personal-projects/tau/src/server/server-main.ts:468-480`

### Overall Assessment

**Verdict**: Needs revision.

**Explanation**: The change correctly uses header cwd for the main hyphenated-name display path, but it loses the per-file/per-directory information that the UI and project counts still need for fallback and collision cases. These regressions should be fixed before the commit is accepted.

## Rejected Review Findings

### Rejected: Preserve per-directory lookup for sessions without cwd

This finding is rejected because backward compatibility for older session JSONL files without a usable header `cwd` is not required. The implementation can treat the header `cwd` as the canonical data source and avoid preserving fallback behavior for incomplete legacy files.

### Rejected: Count `/api/projects` sessions by each file's header cwd

This finding is rejected as an intentional performance tradeoff. Counting `/api/projects` by reading and grouping every session file's header cwd would add extra I/O and implementation complexity for metadata that is acceptable to keep approximate; the rare lossy-directory collision case is not worth burdening the current route.

## Review Findings (2nd round reviewer)

No additional findings.

### Overall Assessment (2nd round reviewer)

**Verdict**: Correct as-is.

**Explanation**: I reviewed the last two commits and did not find any new high-confidence, actionable issues beyond the findings already recorded and rejected above.
