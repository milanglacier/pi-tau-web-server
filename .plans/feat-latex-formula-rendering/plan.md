# Add LaTeX formula rendering to tau

## Context

Assistant (and user) messages in tau's browser UI often contain LaTeX math, but the hand-rolled markdown renderer (`src/public/markdown.ts`) passes it through as plain text — worse, emphasis regexes mangle it (`$a_i * b_i$` sprouts `<em>` tags). The goal is to render math properly using KaTeX.

Decisions confirmed with the user:
- **KaTeX vendored** (not CDN): copied into `public/vendor/katex/` at build time so the app stays self-contained and offline-capable (matches the service-worker/PWA setup).
- **All four delimiters**: `$$...$$` and `\[...\]` (display), `$...$` and `\(...\)` (inline), with conservative single-`$` heuristics so currency like "$5 and $10" is untouched.

Key existing facts: no bundler (plain `tsc`, ES2022 modules); static server already maps `.woff2` MIME (`src/server/config.ts:66`); npm `files` already includes `public`; markdown re-renders fully on every streaming delta (`message-renderer.ts:169`), so unclosed math simply shows raw until the closing delimiter arrives — acceptable, no streaming changes needed.

## Changes

### 1. Dependency + vendor copy — `package.json`, new `scripts/copy-katex.mjs`, `.gitignore`
- Add `katex` (^0.16.x) to `devDependencies`.
- Build script becomes `tsc ... && tsc ... && node scripts/copy-katex.mjs`. (`prepare` runs `build`, so git installs get the copy; tarball installs ship prebuilt `public/` — npm `files` overrides `.gitignore`, same mechanism that ships `public/*.js`.)
- `scripts/copy-katex.mjs`: resolve katex dist via `createRequire(import.meta.url).resolve('katex/package.json')`, copy `katex.min.js`, `katex.min.css`, and **only `fonts/*.woff2`** (~350 KB; the CSS lists woff2 first so fallback formats are never fetched) into `public/vendor/katex/`. Clear error if katex unresolved.
- `.gitignore`: add `/public/vendor/`.

### 2. Load KaTeX — `public/index.html`
- `<link rel="stylesheet" href="vendor/katex/katex.min.css">` after the `style.css` link (line 14).
- `<script defer src="vendor/katex/katex.min.js"></script>` **before** the `app.js` module script (line 258). Deferred classic scripts and module scripts share the after-parse queue in document order, so `window.katex` exists before the app runs — `renderMarkdown()` stays synchronous.

### 3. Core rendering — `src/public/markdown.ts`
- **`renderMath(src, displayMode)` helper**: looks up `globalThis.katex` at render time (works under node tests); returns `katex.renderToString(src, { displayMode, throwOnError: false })`, falling back to `<code class="math-fallback">${escapeHtml(src)}</code>` if katex is absent or throws.
- **Display math**: new `extractDisplayMath(text, blocks)` called in `renderMarkdown()` right **after** code-fence extraction (line 20) and **before** the line split — so `$$` inside ``` fences stays literal and multi-line `$$...$$` survives. Regexes: `/\$\$([\s\S]+?)\$\$/g` and `/\\\[([\s\S]+?)\\\]/g`, replaced with `\n%%MATHBLOCK<N>%%\n` (own line; **no underscore** in the placeholder, matching the `%%ICODE0%%` convention, so a stray italic regex can never split it). New branch in the block loop next to the CODEBLOCK branch (line 66): `/^%%MATHBLOCK(\d+)%%$/` → `<div class="math-block">…rendered…</div>`.
- **Inline math in `renderInline()`**: extract **after** inline-code spans (line 254, so `` `$x$` `` stays code) and **before** image/emphasis regexes (so math content isn't mangled), into `%%IMATH<N>%%` placeholders; restore last, alongside the ICODE restore (line 280), so later regexes never see KaTeX's HTML.
  - `\(...\)`: `/\\\((.+?)\\\)/g`
  - `$...$`: `/(?<![\\$])\$(?!\s)((?:\\.|[^$])+?)(?<![\s\\])\$(?!\d)/g` — opening `$` not escaped/doubled and not followed by whitespace; closing `$` not escaped, not preceded by whitespace, not followed by a digit (kills "$5 and $10").
- **User messages** (`renderUserMarkdown`, line 216): inline math comes free via shared `renderInline`; also call `extractDisplayMath` before its line loop and add the same MATHBLOCK branch (~6 lines) so pasted LaTeX questions render.
- **Guard `window.copyCode`** (line 294) with `if (typeof window !== 'undefined')` so the module imports cleanly under `node --test`.

### 4. Styling — `public/style.css` (message-content section, ~line 1620)
```css
.message-content .math-block { margin: 10px 0; overflow-x: auto; overflow-y: hidden; }
.message-content .katex-display { margin: 0; }
.message-content .katex { font-size: 1.05em; }  /* KaTeX default 1.21em too big vs theme text */
.message-content .math-fallback { opacity: 0.85; }
```
KaTeX inherits `color`, so both themes work unchanged.

### 5. Service worker — `src/public/sw.ts`
- Bump `CACHE_NAME` to `'tau-v4'`; add `/vendor/katex/katex.min.js` and `/vendor/katex/katex.min.css` to the app-shell `addAll` list (line 12). Do **not** precache fonts (a single 404 would fail install; the network-first runtime cache picks them up on demand).

### 6. Tests — new `test/markdown.test.ts`, tweak `tsconfig.test.json`
- Import `renderMarkdown`/`renderUserMarkdown` from `../src/public/markdown.ts` (`allowImportingTsExtensions` already on); stub `globalThis.katex` with a marker-emitting `renderToString`.
- Cases: multi-line `$$…$$` becomes its own display block; `\[x\]` / `\(x\)`; `$a_i * b_i$` gets no `<em>` mangling; `` `$x$` `` stays a code span; `$`/`$$` inside fenced code stay literal; currency non-matches (`$5 and $10`, `$ x$`, `$x $`, `\$5`); katex-absent fallback shows escaped source; user-message math.
- `tsconfig.test.json`: add `src/public/legacy-dom.d.ts` to `include` so `window.copyCode` typechecks in the test program.

### No changes: `src/public/message-renderer.ts`
Full re-render per delta already handles streaming; KaTeX `renderToString` is sub-millisecond per formula. Caching would be a premature optimization.

## Verification

1. `npm install && npm run build` — confirm `public/vendor/katex/` contains `katex.min.js`, `katex.min.css`, `fonts/*.woff2`.
2. `npm run typecheck` and `npm test` (includes the new markdown tests).
3. Manual: run the server (`node bin/tau.js`), open the UI, prompt for math-heavy output (e.g. the quadratic formula with both display and inline math). Verify: display blocks render and scroll horizontally when wide; inline math renders mid-sentence; code-fence and backtick `$` stay literal; "$5 and $10" stays text; user-sent LaTeX renders; only woff2 fonts fetched.
4. Degradation: block `vendor/katex/katex.min.js` in devtools → escaped source shown via `.math-fallback`, no console errors. Reload twice and confirm the `tau-v4` SW cache took over.

Note for the eventual commit: per CLAUDE.md, write the subject as a full sentence naming the outcome, e.g. "feat(ui): render LaTeX math in assistant and user messages with vendored KaTeX so formulas display properly offline".

---

## Code Review — commit f77d29c (reviewed 2026-07-13)

**Verdict: solid implementation, faithful to the plan, no blocking issues.** Typecheck is clean, all 185 tests pass, and `public/vendor/katex/` contains `katex.min.js`, `katex.min.css`, and woff2-only fonts (~596 KB) after a fresh build.

### What was verified

- **Placeholder pipeline ordering is correct.** Display math is extracted after code fences and before the line split (`src/public/markdown.ts:25`); inline math is extracted after inline-code spans and before the emphasis regexes, and restored last alongside `%%ICODE%%` so no later regex ever sees KaTeX's HTML (`src/public/markdown.ts:314`). Spot-checked beyond the test file: math inside table cells and list items renders; unclosed `$$` during streaming stays raw text as the commit message claims; `$5 and $10`, `$ x$`, `$x $`, and `\$5` all stay literal.
- **Fallback paths are XSS-safe.** Both the katex-absent and katex-throws paths escape the source through `escapeHtml` before emitting the `.math-fallback` element; KaTeX's own output escapes its input.
- **Script ordering claim in `public/index.html` is correct** — deferred classic scripts and module scripts share the in-order after-parse queue, so `window.katex` exists before `app.js` runs.
- **The Dockerfile keeps working**: the builder stage now copies `scripts/`, and the runtime stage takes `public/` from the builder, so the vendored assets reach the image. The plan missed this; the implementation correctly caught it.
- **Service worker**: precaching only the two shell assets (not fonts, which a single 404 would turn into an install failure) is the right call; fonts land in the runtime cache on demand.

### Deviations from the plan (all reasonable, none regressive)

- **Tests load the compiled `../public/markdown.js` via `require(esm)`** instead of importing `../src/public/markdown.ts` as planned (section 6). Consequently the `tsconfig.test.json` include tweak was never needed and wasn't made. This is arguably better — it tests the artifact actually shipped — but note it means `npm test`'s build step is load-bearing for these tests.
- `katex` landed at `^0.17.0`, not the planned `^0.16.x`.
- The CSS selector is `.message-content .math-block .katex-display` rather than the planned `.message-content .katex-display` — more specific, fine.
- `package.json` `files` additionally gained `"scripts"` so packed tarballs can re-run `npm run build`. Harmless and sensible.

### Known gaps (document, don't necessarily fix)

- **User-message fenced code is not protected from display math.** `renderUserMarkdown` has never handled ``` fences, so `$$...$$` inside a user-pasted code block now renders as math where it previously stayed verbatim. Low impact, but it is the one place the "math in code stays literal" invariant does not hold.
- **The single-`$` heuristic accepts currency ranges shaped like `$5 and 10$`** (opening `$` may be followed by a digit — necessary so `$2^n$` works; only the closing `$` rejects a following digit). Inherent to any heuristic; the common "`$5 and $10`" case is handled.
- **Literal placeholder text can be misrestored**: a message literally containing `%%IMATH0%%` gets substituted during the restore pass (yielding `undefined` if no math was extracted). This is the same pre-existing class of issue as `%%ICODE0%%` — not introduced here, just now with more placeholder names.
- **`scripts/copy-katex.mjs` never cleans `public/vendor/katex/`**, so a future KaTeX upgrade that renames font files would leave orphans behind. Cosmetic.
- **Display math mid-blockquote splits the quote** (`> text $$x$$ more` → blockquote, math block, then a paragraph). Acceptable for display-mode semantics, just slightly odd visually.

### Commit message

Follows the repo's CLAUDE.md style: full-sentence subject naming the real outcome, body explaining why (currency heuristics, offline vendoring rationale, streaming non-change). No complaints.
