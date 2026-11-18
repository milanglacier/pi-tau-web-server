---
name: review-style
description: Review a change for code and writing style only. Use as the style reviewer when reviewing changes.
---

# Style Review

Review only code style and writing style. Other reviewers check correctness,
logic, performance, and security, so leave those out. Do not modify files,
create commits, or generate a fix.

## Before reviewing

1. Resolve the review target the same way the review request does
   (uncommitted changes, a base branch, a commit, or given paths), and inspect
   the same diff.
2. Read every applicable `AGENTS.md`. Its rules on writing, tests, the README,
   and the changelog are the standard for this review.
3. Read a few files next to the changed code to learn the conventions already
   used there. Judge the change against those conventions, not against your
   own preferences.

## What to check

### Current state only

Everything in the repo, code as well as text, must read as the final version,
as if it had always been written this way. `AGENTS.md` states this rule for
writing; apply it to code too. Flag:

- Names that point at an earlier version, such as `newRenderer`,
  `legacyParse`, `fixedLayout`, `renderV2`, or `oldCount`.
- Code kept for a state that no longer exists, such as fallbacks for data the
  code no longer produces, compatibility shims, flags that switch between old
  and new behavior, or branches that keep old behavior just in case. Backward
  compatibility that users need is fine, such as reading files that a released
  version wrote.
- Tests named or written around the change instead of the behavior, such as
  "no longer shows X" or "does not go back to the old layout". The exception is
  a meaningful regression test for a bug that shipped, which may describe the
  bug it guards against.
- Comments, docstrings, docs, and log or error messages that mention what
  changed, how something used to work, or the conversation that led to it.

Commit messages and plan files are exempt, because their readers need to know
what changed.

### Code

- Names, file layout, and patterns follow the surrounding code.
- The change does no more than it needs to. Flag abstractions, options,
  helpers, or fallback code that nothing uses yet.
- No dead code, leftover debugging output, commented-out code, or unrelated
  edits such as reformatting or renaming outside the change.
- Logic is not duplicated when a helper for it already exists nearby.

### Comments and docstrings

- Written in plain language with complete sentences. No compressed jargon and
  no made-up names for things.
- Explain why when it is not obvious. Flag comments that only repeat what the
  code says.

### Project rules

Check the change against the `AGENTS.md` rules for writing, tests, the README,
the changelog, and commit messages. Common problems are:

- Tests that should not exist, such as regression tests for bugs that never
  shipped or tests of benchmarks and fixtures.
- Implementation details in the README, or README edits that change nothing a
  user does or sees.
- Changelog entries for bugs that never shipped, or entries that describe how
  something was built instead of what users get.
- Commit messages without the required prefix, or with a subject that hides the
  real outcome behind short labels.

## What not to flag

- Anything a formatter or linter already enforces.
- Personal preferences that the project's rules and nearby code do not support.
- Style problems in code the change did not touch.

## Output

Use the layout from the review request, but tag each finding with a style tag
instead of a `[P0]`–`[P3]` priority tag, so style findings stay separate from
logic findings in the merged review:

- **[S1]**: Breaks an explicit project rule in a way that misleads readers or
  users, such as implementation details in the README, a changelog entry for a
  bug that never shipped, or a comment that describes the wrong behavior.
- **[S2]**: Breaks a project rule or a clear convention of the surrounding code,
  such as a test that should not exist, a comment that tells the history of a
  change, or a new pattern where the code already has one.
- **[S3]**: A smaller wording or structure issue that is still worth fixing.

When the request gives no layout, list each finding under `## Findings` as a
`###` heading with its style tag and a short imperative title, then a
`**Location:**` line with an absolute path and line range, then one short
paragraph. Cite the `AGENTS.md` file and line range a finding relies on. If
there are no findings, write `No findings.`
