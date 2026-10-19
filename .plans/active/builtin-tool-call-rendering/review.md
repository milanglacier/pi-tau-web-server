## Findings

### [P2] Keep full file targets accessible in expanded cards

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/tool-card.ts:794-801`

Removing the read argument block leaves the path and line range only in the header preview, which truncates text and has no tooltip. With a long path, expanding a live or history card cannot reveal the filename or requested range, although both were accessible in the previous JSON view. The new edit-array diffs and JavaScript/Bash write views also hide full paths, including in nested rows. Preserve a readable full target in the expanded view rather than relying solely on the truncated preview.

### [P2] Reserve header space for the Copy code button

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/javascript-code-block.ts:59-65`

Plain-text writes use the full file path as the header label, but the flex label cannot shrink below a long filename's width. In a 380px card, a 50-character filename followed by `.txt` pushes the Copy code button entirely outside the wrapper. Because the wrapper hides overflow and provides no horizontal scrollbar, the button becomes inaccessible to pointer users. Allow the label to wrap or shrink while reserving space for the button; this affects both top-level and nested write views.

## Overall assessment

**Verdict:** Patch is incorrect.

**Explanation:** Type checking, all 265 unit tests, and six focused browser tests pass. However, browser checks confirm that long paths hide file targets and can push the Copy code button out of view.

## Fix summaries

### Keep full file targets accessible in expanded cards

Expanded read, edit, and write views show the full file path as selectable text that wraps within the card. Read targets include the requested line range. This applies to live cards, history cards, and nested calls, while malformed arguments still use the JSON fallback.

### Reserve header space for the Copy code button

Code-block header labels can shrink and wrap long filenames. Copy code keeps its width and stays on one line, so the button remains visible and clickable in narrow top-level and nested write views.

### Regression tests

Two browser tests cover full paths, read ranges, literal HTML characters in paths, and long labels in live, history, and nested views. The copy test checks the button layout and exact clipboard contents at viewport widths of 380px and 360px.

### Validation

- `npm run typecheck` passed.
- `npm test` passed all 265 tests.
- `npm run test:e2e` passed all 70 browser tests, including both regression tests.
