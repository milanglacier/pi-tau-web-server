# Render codemode calls as highlighted JavaScript

## Goal

Show the JavaScript source of a codemode call in a highlighted code block instead of its JSON argument wrapper. Use the same display for live cards, saved history, and nested codemode calls.

## Decisions

- Include nested codemode calls because they can use the same argument renderer with little extra code.
- Use Highlight.js with only JavaScript support. Copy browser assets into public/vendor at build time so the UI works offline without a CDN.
- Reuse the existing code-block styles for a JavaScript label and a Copy code button. Render source directly rather than passing it through Markdown fences, since JavaScript strings can contain triple backticks.
- Preserve the exact source, including whitespace and trailing newlines, both on screen and when copied.
- Keep other tools, edit diffs, tool outputs, and ordinary Markdown rendering unchanged.
- Keep JSON fallback when code is missing or is not a string. Keep nested notices for omitted arguments. An empty code string is still valid code input.
- Treat source as text. HTML-like strings must not create elements or run scripts. If highlighting is unavailable or fails, show the source without colors.

## Implementation

1. Add the local Highlight.js browser core and JavaScript grammar to the build. Load them through optional module imports in the code-block renderer so missing assets fall back to plain source. Include the assets and the new frontend module in the service-worker app shell.
2. Add a shared JavaScript code-block renderer with the existing layout, a source-copy button, and safe highlighting fallback.
3. Add a shared argument renderer in src/public/tool-card.ts and use it for live cards, history cards, and nested-call details. Avoid re-highlighting unchanged nested arguments.
4. Add syntax colors that remain readable in dark and light themes. Keep the code block usable on narrow screens.
5. Add tests for real highlighting, exact source preservation and copying, HTML safety, fallback behavior, and matching live/history/nested rendering.

## Verification

- Run npm run typecheck and npm test.
- Run the relevant browser tests, including the existing nested-call tests.
- Check the built browser assets and offline app-shell entries.
- Check that ordinary tools, edit diffs, omitted-argument notices, and tool outputs keep their existing behavior.

## Progress

- [x] Inspect the current renderer and agree on scope.
- [x] Save the plan before implementation.
- [x] Add local highlighting and the shared renderer.
- [x] Connect live, history, and nested argument rendering.
- [x] Finish verification.

## Verification results

- Typecheck passed.
- All 247 unit tests passed.
- The three focused browser tests passed. They cover live and reloaded history, nested calls, exact source copying with carriage returns and trailing newlines, HTML safety, narrow screens, theme colors, missing highlighting assets, JSON fallback, empty code, edit diffs, and omitted nested arguments.
- A browser preview confirmed the root and nested code-block layout in light and dark themes.
- The browser cache contains the new renderer and both highlighting assets.
- The npm package preview includes the renderer, highlighting assets, and their license.
- All 58 browser tests passed, including the existing history, nested-call, and permission tests.
- A final build, typecheck, unit-test run, and git diff --check passed.
- npm install reported one existing high-severity advisory in brace-expansion under Pi's development dependency. The highlighting package adds no dependencies.

## Follow-up: simplify rendering for supported calls

Codemode cannot call another codemode. The nested-codemode rendering described above is therefore unreachable and does not need highlighting support.

- [x] Keep the shared highlighted argument renderer for live and saved root calls only. Remove its nested-element option.
- [x] Render nested arguments as plain text in a stable pre element. Remove the argument cache key and element replacement logic used for nested highlighting.
- [x] Remove the nested-codemode browser fixture and its highlighting and copying checks. Use read calls to check omitted and empty nested arguments.
- [x] Preserve the existing plan above and append this correction.

### Follow-up verification

- Typecheck and all 247 unit tests passed.
- The three codemode browser tests passed, along with the nested-call checks reached during the run.
- The full browser run hit the command's 200-second timeout before finishing, so a complete browser-suite result is not available.
- git diff --check passed.
