## Writing

Write in plain, simple language EVERYWHERE: **comments, docstrings, commit
messages, docs, README documentation, and explanations to the user**.

### Code, Comments & Docstrings

The text in the repo must read as the final, clean version. It should carry
no trace of the back and forth it took to get there, as if it had never been
written any other way. Describe only the current state:

- Describe only current behavior in code, docstrings and inline comments. Do
  not mention what changed or contrast it with earlier behavior.
- The only exception where record behavior changes in contract with earlier
  behavior is acceptable is in **commit messages or plans**, where readers have
  the relevant context.

### Commit Messages & Communication

Write commit messages and explanations to the user in plain English, since the
user has not read the code. Use complete sentences, not compressed jargon or
dense noun phrases. Bad: "removing pairs-order nondeterminism". Good: "results
no longer depend on the order the placeholders are listed in". Do not coin
terminology (e.g. "walk-based expander", "placeholder DSL"); say what the thing
does instead.

Commit messages in this repo should read like a human explaining the change,
not telegraphic shorthand. The maintainer has repeatedly pushed back on terse,
abbreviated subject lines that drop the words that carry the actual intent.

Write the subject as a full, clear sentence. It may be long — that is fine —
but it must name the real outcome, not a compressed label for it. For example,
`fix(ui): canonical model identity, extension-refresh, drop client merges` was
rejected as ambiguous jargon; `fix(ui): make server canonical for
model/thinking identity across clients and extensions` was rejected as terse;
the accepted form was `fix(ui): preserve the full provider/model:thinking-level
identity in every browser so it is never downgraded or left stale, including
when extensions change the model`. The words "preserve the full ... identity"
and "never downgraded or left stale" are the point — keep that kind of language
instead of collapsing it to one-word labels like "canonicalize" or "refresh".

In the body, write full sentences that explain why each change was made, not
bullet fragments that only describe what changed. Keep the key framing words
the user cared about ("preserve", "no downgrade", "stale") visible in the
subject or the opening paragraph.

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

## Model strings are two separate fields — don't parse or split them

Pi's API always sends the model as a structured object with separate `provider`
and `id` fields (e.g. `{provider: "openrouter", id: "z-ai/glm-5.2"}`). The
provider is the backend that serves the model. The id is the model name as that
provider knows it, and it can contain slashes — `z-ai/glm-5.2` is a single
model name, not two things. Do not split the id on slashes or treat its
segments as meaningful.

When displaying the model in the UI, join them as `provider/id` — which
naturally produces `openrouter/z-ai/glm-5.2`. When adding a thinking level for
the model input box, append `:level` to the full string:
`openrouter/z-ai/glm-5.2:high`.
