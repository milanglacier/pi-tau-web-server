## Findings

### [P2] Keep task-list continuation content below its label

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/markdown.ts:234-237`

When a checkbox item has an indented continuation, such as `- [ ] Task\n  More details`, the paragraph now becomes a direct child of `.task-list-item`. That element still uses `display: flex` with the default row direction in `public/style.css:1861-1865`, so the details appear beside the label instead of below it. Indented code blocks join the same row and become squeezed as well; this is reproducible in the browser with the project's stylesheet. Group the label and continuation content in a block-layout container beside the checkbox, or adjust the task-item layout to preserve vertical flow, and cover this case with a layout test.

## Overall assessment

**Verdict:** Patch is incorrect.

**Explanation:** Typechecking and all 332 tests pass, but the list changes introduce a browser layout regression for checkbox items with continuation paragraphs or code blocks.

## Follow-up: checklist layout fixed

The finding is resolved. Each checklist label is grouped in a span, and the item uses two columns: one for the checkbox and one for its text. Extra paragraphs and code blocks stack below the label in the text column. Long code stays within the item's available width.

Added `test/e2e/markdown.e2e.ts` to check the rendered layout at desktop (1280 px) and phone (375 px) widths, including a wrapping label, paragraphs before and after code, a long command, and a checked item. The test failed on the original layout and passes with the fix.

Verification: `npm run typecheck`, `npm test` (332 tests), `npm run test:e2e` (105 tests, about 34 seconds), and `git diff --check` all pass.

**Updated verdict:** Patch is correct; the reported layout regression is fixed.

## Benchmark check after the checklist fix

Compared the working tree with `HEAD`, which contains the code before the checklist layout fix. The standard `npm run benchmark:render -- --preset long --iterations 20` run took 6.8 ms for Markdown across 60 replies. That benchmark measures string rendering, not browser layout.

A paired comparison used five rounds of 20 samples with alternating before/after order and the same fixtures. The table shows the median of each version's round medians:

| Markdown workload | Before | After | Difference |
| --- | ---: | ---: | ---: |
| Typical: 15 replies | 1.610 ms | 1.616 ms | +0.006 ms |
| Long: 60 replies | 6.264 ms | 6.248 ms | -0.016 ms |
| Images: 14 replies | 1.201 ms | 1.203 ms | +0.002 ms |
| Checklist-heavy: 60 replies, 300 checkbox items | 2.198 ms | 2.211 ms | +0.013 ms |

The standard fixtures contain no checkbox items, so a separate Chromium check used 60 checklist replies with 300 checkbox items, each with two paragraphs and a code block. It measured inserting the rendered HTML and forcing layout, with 30 alternating samples per version after warmup:

| Content width | Before | After | Difference |
| --- | ---: | ---: | ---: |
| Desktop: 1000 px | 21.05 ms | 23.00 ms | +1.95 ms (+9.3%) |
| Narrow: 335 px | 23.90 ms | 23.90 ms | 0.00 ms |

There is no meaningful change in Markdown string-rendering time. The desktop checklist stress case costs about 2 ms more to insert and lay out all 300 items; the narrow case shows no measured increase. The browser check excludes painting and full application tab-switch work.
