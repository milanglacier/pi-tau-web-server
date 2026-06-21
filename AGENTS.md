# Commit Style

Commit messages in this repo should read like a human explaining the change, not telegraphic shorthand. The maintainer has repeatedly pushed back on terse, abbreviated subject lines that drop the words that carry the actual intent.

Write the subject as a full, clear sentence. It may be long — that is fine — but it must name the real outcome, not a compressed label for it. For example, `fix(ui): canonical model identity, extension-refresh, drop client merges` was rejected as ambiguous jargon; `fix(ui): make server canonical for model/thinking identity across clients and extensions` was rejected as terse; the accepted form was `fix(ui): preserve the full provider/model:thinking-level identity in every browser so it is never downgraded or left stale, including when extensions change the model`. The words "preserve the full ... identity" and "never downgraded or left stale" are the point — keep that kind of language instead of collapsing it to one-word labels like "canonicalize" or "refresh".

In the body, write full sentences that explain why each change was made, not bullet fragments that only describe what changed. Keep the key framing words the user cared about ("preserve", "no downgrade", "stale") visible in the subject or the opening paragraph.

# Important Notes About the Codebase and Rabbit Holes

These tips and notes are maintained as a reference for future development. They
document the “rabbit holes” we’ve encountered before. Agents should keep them
in mind to avoid introducing features or fixes that cause regressions.

## Writing Notes Guide

When a user asks to add a note to `AGENTS.md`, capture durable project knowledge that helps future agents avoid repeating the same mistakes.

Expected content:
- The problem, edge case, or project-specific constraint, described with short detail and examples to recognize it later.
- The intended behavior or invariant to preserve, expressed in terms of outcomes.
- Relevant context about where the issue appears, if it helps identify the area in the future.

Avoid turning the note into a step-by-step implementation plan. Do not include granular patch instructions.
